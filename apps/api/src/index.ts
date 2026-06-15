import Fastify from 'fastify'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import { env } from './config'
import { createChildLogger } from './logger'
import { connectDatabase } from './prisma/client'
import { startWorkers } from './queues'
import { registerMetaWebhook } from './webhooks/meta.webhook'
import { registerWhatsAppWebhook } from './webhooks/whatsapp.webhook'
import { getMetrics } from './modules/leads/leads.repository'
import { getInstanceStatus, reconnectInstance, bootstrapWhatsApp, getQrCode } from './modules/whatsapp/whatsapp.service'
import { processMessage } from './ai/sdr-agent'
import type { MessageAttachment } from './ai/sdr-agent'
import { reverseGeocode, transcribeAudio } from './ai/multimodal'
import { enqueueFollowUp } from './queues'
import { prisma } from './prisma/client'

const log = createChildLogger('server')

async function buildApp() {
  const app = Fastify({
    logger: false, // We use pino directly
    disableRequestLogging: true,
  })

  // ─── Plugins ───────────────────────────────────────────────────────────────
  await app.register(cors, {
    origin: env.isProduction ? ['http://localhost:3001'] : true,
    credentials: true,
  })

  await app.register(helmet, {
    contentSecurityPolicy: false,
  })

  await app.register(rateLimit, {
    max: 100,
    timeWindow: '1 minute',
    skipOnError: true,
  })

  // ─── Health check ─────────────────────────────────────────────────────────
  app.get('/health', async () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
  }))

  // ─── Webhooks ─────────────────────────────────────────────────────────────
  await registerMetaWebhook(app)
  await registerWhatsAppWebhook(app)

  // ─── API Routes ───────────────────────────────────────────────────────────

  // Leads
  app.get('/api/leads', async (request) => {
    const query = request.query as { status?: string; page?: string; limit?: string }
    const page = parseInt(query.page ?? '1')
    const limit = parseInt(query.limit ?? '20')
    const skip = (page - 1) * limit

    const where = query.status ? { status: query.status as 'NEW' } : {}

    const [leads, total] = await Promise.all([
      prisma.lead.findMany({
        where,
        include: {
          conversations: {
            select: { id: true, state: true, updatedAt: true, _count: { select: { messages: true } } },
          },
          consultant: { select: { name: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.lead.count({ where }),
    ])

    return { data: leads, total, page, limit, pages: Math.ceil(total / limit) }
  })

  app.get('/api/leads/:id', async (request, reply) => {
    const params = request.params as { id: string }
    const lead = await prisma.lead.findUnique({
      where: { id: params.id },
      include: {
        conversations: { include: { messages: { orderBy: { sentAt: 'asc' } } } },
        consultant: true,
      },
    })
    if (!lead) return reply.code(404).send({ error: 'Lead not found' })
    return lead
  })

  // Conversations
  app.get('/api/conversations', async (request) => {
    const query = request.query as { state?: string; page?: string; limit?: string }
    const page = parseInt(query.page ?? '1')
    const limit = parseInt(query.limit ?? '20')

    const where = query.state ? { state: query.state as 'INITIAL_CONTACT' } : {}

    const [conversations, total] = await Promise.all([
      prisma.conversation.findMany({
        where,
        include: {
          lead: { select: { id: true, name: true, phone: true, status: true, city: true } },
          messages: { orderBy: { sentAt: 'desc' }, take: 1 },
        },
        orderBy: { updatedAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.conversation.count({ where }),
    ])

    return { data: conversations, total, page, limit }
  })

  app.get('/api/conversations/:id/messages', async (request, reply) => {
    const params = request.params as { id: string }
    const messages = await prisma.message.findMany({
      where: { conversationId: params.id },
      orderBy: { sentAt: 'asc' },
    })
    if (!messages.length) return reply.code(404).send({ error: 'Conversation not found' })
    return messages
  })

  // Analytics / Dashboard metrics
  app.get('/api/analytics/metrics', async (request) => {
    const query = request.query as { period?: 'today' | 'week' | 'month' }
    const now = new Date()
    let startDate: Date

    switch (query.period) {
      case 'week':
        startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
        break
      case 'month':
        startDate = new Date(now.getFullYear(), now.getMonth(), 1)
        break
      default:
        startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    }

    const metrics = await getMetrics(startDate, now)
    const safeDiv = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : 0)

    return {
      period: query.period ?? 'today',
      startDate,
      endDate: now,
      ...metrics,
      contactRate: safeDiv(metrics.contacted, metrics.total),
      responseRate: safeDiv(metrics.qualified + metrics.scheduled + metrics.won, metrics.contacted),
      qualificationRate: safeDiv(metrics.qualified, metrics.contacted),
      schedulingRate: safeDiv(metrics.scheduled, metrics.qualified),
      conversionRate: safeDiv(metrics.scheduled, metrics.total),
    }
  })

  // SSE for real-time dashboard updates
  app.get('/api/analytics/stream', async (request, reply) => {
    reply.raw.setHeader('Content-Type', 'text/event-stream')
    reply.raw.setHeader('Cache-Control', 'no-cache')
    reply.raw.setHeader('Connection', 'keep-alive')
    reply.raw.flushHeaders()

    const sendMetrics = async () => {
      const now = new Date()
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
      const metrics = await getMetrics(today, now)
      reply.raw.write(`data: ${JSON.stringify({ ...metrics, timestamp: now.toISOString() })}\n\n`)
    }

    await sendMetrics()
    const interval = setInterval(sendMetrics, 10000)
    request.raw.on('close', () => clearInterval(interval))

    return reply
  })

  // Consultants
  app.get('/api/consultants', async () => {
    return prisma.consultant.findMany({ where: { active: true } })
  })

  // ─── Inbox API (WhatsApp-Web-style panel) ────────────────────────────────
  // Designed for the team to monitor and manually intervene in conversations.

  // GET /api/inbox/conversations — paginated list with last message preview
  app.get('/api/inbox/conversations', async (request) => {
    const query = request.query as { search?: string; state?: string; limit?: string }
    const limit = Math.min(parseInt(query.limit ?? '100'), 200)
    const where: Record<string, unknown> = {}
    if (query.state) where.state = query.state
    if (query.search) {
      where.lead = {
        OR: [
          { name: { contains: query.search, mode: 'insensitive' } },
          { phone: { contains: query.search } },
        ],
      }
    }
    const conversations = await prisma.conversation.findMany({
      where,
      include: {
        lead: {
          select: { id: true, name: true, phone: true, city: true, energyBill: true, status: true, scheduledAt: true },
        },
        messages: { orderBy: { sentAt: 'desc' }, take: 1 },
        _count: { select: { messages: true } },
      },
      orderBy: { updatedAt: 'desc' },
      take: limit,
    })
    return {
      conversations: conversations.map((c) => ({
        id: c.id,
        leadId: c.leadId,
        state: c.state,
        aiPaused: c.aiPaused,
        updatedAt: c.updatedAt,
        messageCount: c._count.messages,
        lead: c.lead,
        lastMessage: c.messages[0]
          ? {
              role: c.messages[0].role,
              content: c.messages[0].content,
              sentAt: c.messages[0].sentAt,
            }
          : null,
      })),
    }
  })

  // GET /api/inbox/conversations/:id/messages — full conversation history
  app.get('/api/inbox/conversations/:id/messages', async (request, reply) => {
    const params = request.params as { id: string }
    const conversation = await prisma.conversation.findUnique({
      where: { id: params.id },
      include: {
        lead: true,
        messages: { orderBy: { sentAt: 'asc' } },
      },
    })
    if (!conversation) return reply.code(404).send({ error: 'not_found' })
    return {
      conversation: {
        id: conversation.id,
        leadId: conversation.leadId,
        state: conversation.state,
        aiPaused: conversation.aiPaused,
        activeKey: conversation.activeKey,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
      },
      lead: conversation.lead,
      messages: conversation.messages.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        sentAt: m.sentAt,
        whatsappId: m.whatsappId,
        metadata: m.metadata,
      })),
    }
  })

  // POST /api/inbox/conversations/:id/pause — toggle AI on/off for a conversation
  app.post('/api/inbox/conversations/:id/pause', async (request, reply) => {
    const params = request.params as { id: string }
    const body = (request.body as { paused?: boolean } | null) ?? {}
    const conversation = await prisma.conversation.findUnique({ where: { id: params.id } })
    if (!conversation) return reply.code(404).send({ error: 'not_found' })
    const newPaused = typeof body.paused === 'boolean' ? body.paused : !conversation.aiPaused
    await prisma.conversation.update({
      where: { id: params.id },
      data: { aiPaused: newPaused },
    })
    return { ok: true, aiPaused: newPaused }
  })

  // POST /api/inbox/conversations/:id/reply — send a message as a human attendant
  app.post('/api/inbox/conversations/:id/reply', async (request, reply) => {
    const params = request.params as { id: string }
    const body = request.body as { message: string }
    if (!body.message?.trim()) return reply.code(400).send({ error: 'missing_message' })
    const conversation = await prisma.conversation.findUnique({
      where: { id: params.id },
      include: { lead: true },
    })
    if (!conversation) return reply.code(404).send({ error: 'not_found' })
    const lead = conversation.lead

    const isTestLead = lead.source === 'test_panel'
    let whatsappId: string | null = null
    if (!isTestLead) {
      const { sendTextMessage } = await import('./modules/whatsapp/whatsapp.service')
      const storedJid = lead.whatsappJid ?? ''
      const replyTo = storedJid.includes('@s.whatsapp.net') ? storedJid : lead.phone
      whatsappId = await sendTextMessage(replyTo, body.message)
    }

    await prisma.message.create({
      data: {
        conversationId: params.id,
        role: 'assistant',
        content: body.message,
        whatsappId: whatsappId ?? undefined,
        sentAt: new Date(),
        metadata: { humanSent: true },
      },
    })
    return { ok: true, whatsappId, isTestLead }
  })

  // GET /api/inbox/stream — Server-Sent Events for real-time inbox updates
  app.get('/api/inbox/stream', async (request, reply) => {
    reply.raw.setHeader('Content-Type', 'text/event-stream')
    reply.raw.setHeader('Cache-Control', 'no-cache')
    reply.raw.setHeader('Connection', 'keep-alive')
    reply.raw.setHeader('X-Accel-Buffering', 'no')
    reply.raw.flushHeaders()

    let lastCheck = new Date()
    const tick = async () => {
      try {
        // Find conversations that had new messages OR state changes since lastCheck
        const updated = await prisma.conversation.findMany({
          where: { updatedAt: { gt: lastCheck } },
          select: { id: true, state: true, aiPaused: true, updatedAt: true },
        })
        const newMessages = await prisma.message.findMany({
          where: { sentAt: { gt: lastCheck } },
          select: {
            id: true,
            conversationId: true,
            role: true,
            content: true,
            sentAt: true,
          },
          orderBy: { sentAt: 'asc' },
        })
        if (updated.length > 0 || newMessages.length > 0) {
          reply.raw.write(
            `data: ${JSON.stringify({ type: 'update', updated, newMessages, ts: new Date().toISOString() })}\n\n`,
          )
        } else {
          // heartbeat keeps the connection alive through proxies
          reply.raw.write(`: ping ${Date.now()}\n\n`)
        }
        lastCheck = new Date()
      } catch (err) {
        log.error({ err }, 'inbox stream tick failed')
      }
    }

    const interval = setInterval(tick, 2000)
    request.raw.on('close', () => clearInterval(interval))

    // Send an initial ping so client knows the stream is alive
    reply.raw.write(`: connected ${Date.now()}\n\n`)
    return reply
  })

  // WhatsApp / Evolution admin
  app.get('/api/whatsapp/status', async () => {
    const state = await getInstanceStatus()
    return { instance: env.evolution.instanceName, state }
  })

  app.post('/api/whatsapp/reconnect', async (_request, reply) => {
    await reconnectInstance()
    return reply.code(202).send({ message: 'Reconnect triggered — check provider logs / GET /api/whatsapp/qr for QR' })
  })

  // ─── Google OAuth (re-authorize Calendar) ────────────────────────────────
  // The refresh_token in .env can be revoked by Google after a long idle
  // period or 7 days in "Testing" mode. This endpoint regenerates it.

  app.get('/auth/google', async (_request, reply) => {
    if (!env.google.clientId || !env.google.clientSecret) {
      return reply.code(500).send({ error: 'google_client_not_configured' })
    }
    const params = new URLSearchParams({
      client_id: env.google.clientId,
      redirect_uri: env.google.redirectUri,
      response_type: 'code',
      scope: 'https://www.googleapis.com/auth/calendar',
      access_type: 'offline',
      prompt: 'consent',  // forces issuing a NEW refresh_token
    })
    return reply.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`)
  })

  app.get('/auth/google/callback', async (request, reply) => {
    const query = request.query as Record<string, string>
    const code = query['code']
    const error = query['error']
    if (error) {
      return reply.type('text/html').send(`<pre>Google OAuth returned error: ${error}</pre>`)
    }
    if (!code) {
      return reply.code(400).send({ error: 'missing_code' })
    }
    try {
      const axios = (await import('axios')).default
      const tokenRes = await axios.post('https://oauth2.googleapis.com/token', new URLSearchParams({
        code,
        client_id: env.google.clientId,
        client_secret: env.google.clientSecret,
        redirect_uri: env.google.redirectUri,
        grant_type: 'authorization_code',
      }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })
      const tokens = tokenRes.data as { access_token?: string; refresh_token?: string; scope?: string }
      const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>Google reauthorized</title>
<style>body{font-family:system-ui;background:#0f172a;color:#e2e8f0;padding:32px;line-height:1.6}
.card{background:#1e293b;padding:20px;border-radius:8px;border:1px solid #334155;margin:16px 0}
.token{font-family:monospace;font-size:13px;background:#0f172a;padding:10px;border-radius:4px;word-break:break-all;color:#a3e635}
h1{font-size:18px;margin-top:0}p{color:#94a3b8;font-size:14px}code{background:#0f172a;padding:2px 6px;border-radius:3px}</style>
</head><body>
<h1>✅ Autorização concluída</h1>
<div class="card">
  <p>Copie o <strong>refresh_token</strong> abaixo e cole no <code>.env</code> substituindo a linha <code>GOOGLE_REFRESH_TOKEN=...</code>:</p>
  <div class="token">GOOGLE_REFRESH_TOKEN=${tokens.refresh_token ?? '(não retornado — refaça a autorização clicando no link de novo)'}</div>
</div>
<div class="card">
  <p>Escopo concedido: <code>${tokens.scope ?? ''}</code></p>
  <p>Depois de colar no .env, salve. O hot-reload da API aplica em segundos. Volte ao painel <a href="/test-chat" style="color:#60a5fa">/test-chat</a> e teste o agendamento.</p>
</div>
</body></html>`
      return reply.type('text/html').send(html)
    } catch (err) {
      const errResp = err as { response?: { data?: unknown }; message?: string }
      log.error({ err }, 'Google OAuth token exchange failed')
      return reply
        .code(500)
        .type('text/html')
        .send(`<pre>Token exchange failed: ${errResp.message}\n\n${JSON.stringify(errResp.response?.data, null, 2)}</pre>`)
    }
  })

  // ─── Test Chat Panel (DISABLED in production) ────────────────────────────
  // The test panel is a dev tool — DO NOT expose to the public internet.
  // Set ENABLE_TEST_PANEL=true to override (e.g. for a staging environment).
  const testPanelEnabled =
    !env.isProduction || process.env.ENABLE_TEST_PANEL === 'true'

  if (!testPanelEnabled) {
    log.info('Test panel disabled (production mode). Set ENABLE_TEST_PANEL=true to override.')
  }

  // Wrap registration so the routes only register when enabled
  if (testPanelEnabled) {
  // Lets you talk to Ana directly via the browser, bypassing WhatsApp entirely.
  // Uses the real Claude API, real tools (incl. Google Calendar), real DB writes.

  // Raise body size limit just for the test endpoint (images/PDFs can be ~5-10 MB base64-encoded)
  app.post('/api/test/chat', { bodyLimit: 20 * 1024 * 1024 }, async (request, reply) => {
    const body = request.body as {
      leadId?: string
      leadName?: string
      message: string
      attachment?: {
        type: 'image' | 'document' | 'location' | 'audio'
        base64?: string             // image/document/audio
        mimeType?: string           // 'image/jpeg', 'application/pdf', 'audio/ogg', etc.
        latitude?: number           // location
        longitude?: number          // location
      }
    }
    // text is allowed to be empty if there's an attachment
    if (!body.message && !body.attachment) return reply.code(400).send({ error: 'missing_message_or_attachment' })

    // Get or create the test lead
    let lead = body.leadId
      ? await prisma.lead.findUnique({ where: { id: body.leadId } })
      : null

    if (!lead) {
      lead = await prisma.lead.create({
        data: {
          name: body.leadName ?? 'Lead Teste',
          phone: `+test-${Date.now()}`,    // unique per session
          source: 'test_panel',
          status: 'NEW',
        },
      })
    }

    // Atomic upsert of the active conversation
    const conversation = await prisma.conversation.upsert({
      where: { activeKey: lead.id },
      create: { leadId: lead.id, state: 'INITIAL_CONTACT', activeKey: lead.id },
      update: {},
    })

    // ── AI pause / manual takeover ────────────────────────────────────────────
    // When the conversation is paused: save the lead's message (so the human
    // attendant sees it) and return without running Ana. Follow-ups and
    // callbacks already check this flag and skip too.
    if (conversation.aiPaused) {
      await prisma.message.create({
        data: {
          conversationId: conversation.id,
          role: 'user',
          content: body.message || (body.attachment ? '[anexo enviado]' : ''),
          sentAt: new Date(),
        },
      })
      const updatedConv = await prisma.conversation.findUnique({ where: { id: conversation.id } })
      return {
        leadId: lead.id,
        conversationId: conversation.id,
        response: null,
        aiPaused: true,
        state: updatedConv?.state,
        lead: {
          name: lead.name,
          city: lead.city,
          energyBill: lead.energyBill,
          propertyType: lead.propertyType,
          status: lead.status,
          scheduledAt: lead.scheduledAt,
        },
      }
    }

    // Resolve attachment — location is geocoded and audio is transcribed before reaching the agent
    let agentAttachment: MessageAttachment | undefined
    if (body.attachment?.type === 'location' && body.attachment.latitude && body.attachment.longitude) {
      const geocoded = await reverseGeocode(body.attachment.latitude, body.attachment.longitude)
      agentAttachment = {
        type: 'location',
        resolvedAddress: geocoded?.formattedAddress ?? `${body.attachment.latitude},${body.attachment.longitude}`,
      }
    } else if (body.attachment?.type === 'audio' && body.attachment.base64 && body.attachment.mimeType) {
      const buffer = Buffer.from(body.attachment.base64, 'base64')
      const transcription = await transcribeAudio(buffer, body.attachment.mimeType)
      if (transcription) {
        agentAttachment = { type: 'audio', transcription }
      } else {
        // Whisper not configured or failed — let the agent see a marker so it can ask the lead to type
        agentAttachment = { type: 'audio', transcription: '[áudio recebido, mas o sistema de transcrição está indisponível]' }
      }
    } else if (body.attachment && (body.attachment.type === 'image' || body.attachment.type === 'document')) {
      agentAttachment = {
        type: body.attachment.type,
        base64: body.attachment.base64,
        mimeType: body.attachment.mimeType,
      }
    }

    // Run the real SDR agent
    const result = await processMessage(
      body.message,
      {
        leadId: lead.id,
        leadName: lead.name,
        energyBill: lead.energyBill ?? undefined,
        city: lead.city ?? undefined,
        propertyType: lead.propertyType ?? undefined,
        followUpCount: lead.followUpCount,
        conversationId: conversation.id,
      },
      agentAttachment,
    )

    // Schedule a fresh follow-up anchored on the response we just produced.
    // For test_panel leads the worker won't send via WhatsApp — it just writes
    // a message to the DB which the panel surfaces through polling.
    if (result.message) {
      await enqueueFollowUp(lead.id, 1, new Date()).catch((err) =>
        log.warn({ err, leadId: lead.id }, 'Failed to schedule follow-up'),
      )
    }

    // Re-fetch to pick up any state/data changes made by tools
    const [updatedLead, updatedConv] = await Promise.all([
      prisma.lead.findUnique({ where: { id: lead.id } }),
      prisma.conversation.findUnique({ where: { id: conversation.id } }),
    ])

    return {
      leadId: lead.id,
      conversationId: conversation.id,
      response: result.message,
      toolsUsed: result.toolsUsed,
      escalated: result.escalated,
      scheduledVisit: result.scheduledVisit,
      mediaToSend: result.mediaToSend,
      state: updatedConv?.state,
      // For audio attachments, surface the transcription so the panel can show it
      transcription:
        agentAttachment?.type === 'audio' ? agentAttachment.transcription : undefined,
      resolvedAddress:
        agentAttachment?.type === 'location' ? agentAttachment.resolvedAddress : undefined,
      lead: {
        name: updatedLead?.name,
        city: updatedLead?.city,
        energyBill: updatedLead?.energyBill,
        propertyType: updatedLead?.propertyType,
        status: updatedLead?.status,
        scheduledAt: updatedLead?.scheduledAt,
      },
    }
  })

  app.get('/api/test/history/:leadId', async (request, reply) => {
    const params = request.params as { leadId: string }
    const conversation = await prisma.conversation.findFirst({
      where: { leadId: params.leadId, activeKey: params.leadId },
      include: { messages: { orderBy: { sentAt: 'asc' } } },
    })
    if (!conversation) return reply.code(404).send({ error: 'no_active_conversation' })
    return {
      conversationId: conversation.id,
      state: conversation.state,
      aiPaused: conversation.aiPaused,
      messages: conversation.messages.map((m) => ({
        role: m.role,
        content: m.content,
        sentAt: m.sentAt,
      })),
    }
  })

  // Toggle Ana pause/resume for the current active conversation
  app.post('/api/test/toggle-ai', async (request, reply) => {
    const body = request.body as { leadId: string; paused?: boolean }
    if (!body.leadId) return reply.code(400).send({ error: 'missing_leadId' })
    const conversation = await prisma.conversation.findFirst({
      where: { leadId: body.leadId, activeKey: body.leadId },
    })
    if (!conversation) return reply.code(404).send({ error: 'no_active_conversation' })
    // Toggle if `paused` is omitted; otherwise set explicitly
    const newPaused = typeof body.paused === 'boolean' ? body.paused : !conversation.aiPaused
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { aiPaused: newPaused },
    })
    return { ok: true, aiPaused: newPaused }
  })

  // Send a message AS the human attendant. Saved as 'assistant' with metadata
  // marking it as human-typed. Goes to the lead via the configured WhatsApp
  // provider — unless the lead is a test_panel lead (then just persisted).
  app.post('/api/test/human-reply', async (request, reply) => {
    const body = request.body as { leadId: string; message: string }
    if (!body.leadId || !body.message?.trim()) {
      return reply.code(400).send({ error: 'missing_leadId_or_message' })
    }
    const lead = await prisma.lead.findUnique({ where: { id: body.leadId } })
    if (!lead) return reply.code(404).send({ error: 'lead_not_found' })
    const conversation = await prisma.conversation.findFirst({
      where: { leadId: body.leadId, activeKey: body.leadId },
    })
    if (!conversation) return reply.code(404).send({ error: 'no_active_conversation' })

    const isTestLead = lead.source === 'test_panel'
    let whatsappId: string | null = null
    if (!isTestLead) {
      const { sendTextMessage } = await import('./modules/whatsapp/whatsapp.service')
      const storedJid = lead.whatsappJid ?? ''
      const replyTo = storedJid.includes('@s.whatsapp.net') ? storedJid : lead.phone
      whatsappId = await sendTextMessage(replyTo, body.message)
    }

    await prisma.message.create({
      data: {
        conversationId: conversation.id,
        role: 'assistant',
        content: body.message,
        whatsappId: whatsappId ?? undefined,
        sentAt: new Date(),
        metadata: { humanSent: true },
      },
    })
    return { ok: true, whatsappId, isTestLead }
  })

  app.post('/api/test/reset', async (request) => {
    const body = request.body as { leadId: string }
    await prisma.conversation.updateMany({
      where: { leadId: body.leadId, activeKey: { not: null } },
      data: { state: 'CLOSED', activeKey: null },
    })
    return { ok: true }
  })

  // The test panel UI (single-page HTML, no build step needed)
  app.get('/test-chat', async (_request, reply) => {
    return reply.type('text/html').send(TEST_CHAT_HTML)
  })

  // QR code for both WhatsApp providers. Auto-refreshes the image every 25 s
  // (WhatsApp QRs expire after ~30 s).
  app.get('/api/whatsapp/qr', async (_request, reply) => {
    const qr = await getQrCode()
    if (!qr) {
      return reply.code(404).send({
        error: 'no_qr_available',
        message: 'Session already authenticated — no QR needed. POST /api/whatsapp/reconnect to force a new login.',
      })
    }
    const imgSrc = qr.startsWith('data:') ? qr : `data:image/png;base64,${qr}`
    const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>WhatsApp QR — SDR Solar</title>
<style>
body{font-family:system-ui;background:#0a0a0a;color:#fafafa;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;margin:0;gap:8px}
img{background:#fff;padding:16px;border-radius:8px;width:340px;height:340px}
h1{font-weight:500;margin:0}p{color:#a3a3a3;margin:0;text-align:center;padding:0 20px;max-width:400px}
.timer{color:#666;font-size:13px;margin-top:8px}
</style></head>
<body>
<h1>Escaneie no WhatsApp</h1>
<p>Configurações &rarr; Aparelhos conectados &rarr; Conectar um aparelho</p>
<img id="qr" src="${imgSrc}" alt="QR Code" />
<div class="timer">Atualiza em <span id="t">25</span>s</div>
<script>
let t = 25
setInterval(() => {
  t--
  document.getElementById('t').textContent = t
  if (t <= 0) {
    fetch(location.href, { headers: { 'Accept': 'text/html' } })
      .then(r => r.text())
      .then(html => {
        const m = html.match(/src="(data:image[^"]+)"/)
        if (m) document.getElementById('qr').src = m[1]
        t = 25
      })
      .catch(() => { t = 5 })
  }
}, 1000)
</script>
</body></html>`
    return reply.type('text/html').send(html)
  })
  }   // end of testPanelEnabled block — all test/QR routes above are dev-only

  return app
}

async function main() {
  try {
    await connectDatabase()
    const app = await buildApp()
    startWorkers()

    await app.listen({ port: env.port, host: '0.0.0.0' })
    log.info({ port: env.port }, `SDR Solar API running on port ${env.port}`)

    // Bootstraps the WhatsApp provider's session if needed (WAHA only — no-op for Evolution).
    // Webhook is set via WHATSAPP_HOOK_URL env var on the WAHA container.
    bootstrapWhatsApp().catch((err) =>
      log.warn({ err }, 'bootstrapWhatsApp failed — provider may need manual setup'),
    )
  } catch (err) {
    log.error({ err }, 'Failed to start server')
    process.exit(1)
  }
}

// ─── Test Chat Panel HTML ──────────────────────────────────────────────────
// Single-page chat that talks to /api/test/chat. No build step, no framework.

const TEST_CHAT_HTML = `<!doctype html>
<html lang="pt-br">
<head>
<meta charset="utf-8">
<title>Painel de Teste — Ana / SDR Solar</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; font-family: system-ui, -apple-system, sans-serif; background: #0f0f12; color: #e5e5e5; height: 100vh; display: flex; overflow: hidden; }

  .chat { flex: 1; display: flex; flex-direction: column; border-right: 1px solid #2a2a2e; }
  .chat-header { padding: 14px 20px; background: #18181b; border-bottom: 1px solid #2a2a2e; display: flex; justify-content: space-between; align-items: center; }
  .chat-header h1 { margin: 0; font-size: 16px; font-weight: 500; }
  .chat-header .sub { color: #71717a; font-size: 12px; margin-top: 2px; }
  .chat-header button { background: #27272a; color: #e5e5e5; border: 1px solid #3f3f46; padding: 6px 12px; border-radius: 6px; font-size: 13px; cursor: pointer; }
  .chat-header button:hover { background: #3f3f46; }
  .chat-header .header-actions { display: flex; gap: 8px; align-items: center; }
  .toggle-ai { background: #14532d; color: #bbf7d0; border-color: #166534; }
  .toggle-ai:hover { background: #166534; }
  .toggle-ai.paused { background: #7c2d12; color: #fed7aa; border-color: #9a3412; }
  .toggle-ai.paused:hover { background: #9a3412; }
  .human-banner { background: #7c2d12; color: #fed7aa; padding: 8px 20px; font-size: 13px; text-align: center; border-bottom: 1px solid #9a3412; display: none; }
  .human-banner.active { display: block; }
  .human-composer { padding: 12px 20px; background: #422006; border-top: 1px solid #7c2d12; display: none; gap: 8px; align-items: center; }
  .human-composer.active { display: flex; }
  .human-composer input { flex: 1; background: #1c1917; color: #fed7aa; border: 1px solid #7c2d12; padding: 10px 14px; border-radius: 8px; font-size: 14px; outline: none; }
  .human-composer input:focus { border-color: #f59e0b; }
  .human-composer button { background: #ea580c; color: white; border: none; padding: 10px 16px; border-radius: 8px; font-size: 13px; cursor: pointer; }
  .human-composer button:hover { background: #c2410c; }
  .msg.human { align-self: flex-start; background: #422006; color: #fed7aa; border: 1px solid #7c2d12; }
  .msg.human::before { content: '👤 Humano: '; opacity: 0.7; font-size: 11px; display: block; margin-bottom: 2px; }

  .messages { flex: 1; overflow-y: auto; padding: 20px; display: flex; flex-direction: column; gap: 12px; }
  .msg { max-width: 75%; padding: 10px 14px; border-radius: 12px; line-height: 1.4; font-size: 14px; word-wrap: break-word; white-space: pre-wrap; }
  .msg.user { align-self: flex-end; background: #2563eb; color: white; }
  .msg.assistant { align-self: flex-start; background: #27272a; }
  .msg.system { align-self: center; background: transparent; color: #71717a; font-size: 12px; font-style: italic; padding: 4px; }

  .composer { padding: 14px 20px; background: #18181b; border-top: 1px solid #2a2a2e; display: flex; flex-direction: column; gap: 8px; }
  .composer-row { display: flex; gap: 8px; align-items: center; }
  .composer input[type="text"] { flex: 1; background: #27272a; color: #e5e5e5; border: 1px solid #3f3f46; padding: 10px 14px; border-radius: 8px; font-size: 14px; outline: none; }
  .composer input[type="text"]:focus { border-color: #2563eb; }
  .composer button.send { background: #2563eb; color: white; border: none; padding: 10px 20px; border-radius: 8px; font-size: 14px; cursor: pointer; }
  .composer button.send:hover { background: #1d4ed8; }
  .composer button.send:disabled { background: #3f3f46; cursor: not-allowed; }
  .composer button.icon { background: #27272a; color: #a3a3a3; border: 1px solid #3f3f46; padding: 10px 12px; border-radius: 8px; font-size: 16px; cursor: pointer; }
  .composer button.icon:hover { background: #3f3f46; color: #fafafa; }
  .composer button.icon.recording { background: #dc2626; color: white; animation: pulse 1.2s infinite; }
  @keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: 0.6 } }
  .composer input[type="file"] { display: none; }
  .attach-pill { display: inline-flex; align-items: center; gap: 6px; background: #1e3a8a; color: #bfdbfe; padding: 4px 10px; border-radius: 12px; font-size: 12px; max-width: 100%; overflow: hidden; }
  .attach-pill .x { cursor: pointer; opacity: 0.7; margin-left: 4px; }
  .attach-pill .x:hover { opacity: 1 }
  .location-row { display: none; gap: 6px; align-items: center; font-size: 13px; color: #a3a3a3; }
  .location-row.active { display: flex; }
  .location-row input { background: #27272a; color: #e5e5e5; border: 1px solid #3f3f46; padding: 6px 10px; border-radius: 6px; font-size: 13px; width: 110px; }
  .location-row button.preset { background: transparent; color: #60a5fa; border: 1px solid #3f3f46; padding: 4px 10px; border-radius: 6px; font-size: 12px; cursor: pointer; }

  .sidebar { width: 360px; background: #18181b; padding: 20px; overflow-y: auto; display: flex; flex-direction: column; gap: 16px; }
  .section { background: #27272a; border-radius: 8px; padding: 14px; }
  .section h2 { margin: 0 0 10px; font-size: 12px; font-weight: 600; color: #71717a; text-transform: uppercase; letter-spacing: 0.5px; }
  .field { display: flex; justify-content: space-between; padding: 4px 0; font-size: 13px; }
  .field span:first-child { color: #71717a; }
  .field span:last-child { color: #e5e5e5; font-weight: 500; max-width: 200px; text-align: right; word-break: break-all; }
  .badge { display: inline-block; padding: 3px 8px; border-radius: 4px; font-size: 11px; font-weight: 500; margin-right: 4px; margin-bottom: 4px; }
  .badge.tool { background: #1e3a8a; color: #bfdbfe; }
  .badge.state { background: #14532d; color: #bbf7d0; }
  .badge.state.escalated { background: #7c2d12; color: #fed7aa; }
  .badge.state.confirmed { background: #14532d; color: #bbf7d0; }
  .badge.state.scheduling { background: #713f12; color: #fef3c7; }
  .badge.state.qualifying { background: #581c87; color: #e9d5ff; }
  .empty { color: #52525b; font-size: 13px; font-style: italic; }
  .calendar-link { color: #60a5fa; text-decoration: none; font-size: 13px; }
  .calendar-link:hover { text-decoration: underline; }
</style>
</head>
<body>

<div class="chat">
  <div class="chat-header">
    <div>
      <h1>Ana &mdash; SDR Ecolare</h1>
      <div class="sub" id="lead-id-display">Nenhuma conversa ativa</div>
    </div>
    <div class="header-actions">
      <button id="toggle-ai-btn" class="toggle-ai" title="Liga/desliga a Ana nesta conversa">🤖 Ana ativa</button>
      <button id="reset-btn">Nova conversa</button>
    </div>
  </div>
  <div class="human-banner" id="human-banner">
    👤 Modo Humano — Ana pausada. Você responde manualmente ao lead.
  </div>
  <div class="messages" id="messages">
    <div class="msg system">Digite uma mensagem como se fosse o lead. A Ana responde usando o prompt + tools reais.</div>
  </div>
  <div class="human-composer" id="human-composer">
    <input id="human-input" placeholder="Responda ao lead como humano..." autocomplete="off" />
    <button id="human-send-btn">Enviar como Humano</button>
  </div>
  <div class="composer">
    <div id="attach-display"></div>
    <div class="composer-row">
      <button class="icon" id="attach-btn" title="Anexar imagem ou PDF">📎</button>
      <button class="icon" id="mic-btn" title="Gravar áudio (clique pra gravar, clique de novo pra parar)">🎤</button>
      <button class="icon" id="loc-btn" title="Enviar localização">📍</button>
      <input type="file" id="file-input" accept="image/*,application/pdf,audio/*" />
      <input type="text" id="input" placeholder="Digite sua mensagem..." autocomplete="off" />
      <button class="send" id="send-btn">Enviar</button>
    </div>
    <div class="location-row" id="loc-row">
      <span>Latitude:</span>
      <input type="text" id="loc-lat" placeholder="-3.7319" />
      <span>Longitude:</span>
      <input type="text" id="loc-lng" placeholder="-38.5267" />
      <button class="preset" id="loc-preset-fortaleza">Fortaleza (Aldeota)</button>
      <button class="preset" id="loc-cancel">cancelar</button>
    </div>
  </div>
</div>

<div class="sidebar">
  <div class="section">
    <h2>Estado da Conversa</h2>
    <div id="state-display"><span class="empty">aguardando primeira mensagem</span></div>
  </div>
  <div class="section">
    <h2>Dados do Lead</h2>
    <div id="lead-data"><div class="empty">sem dados ainda</div></div>
  </div>
  <div class="section">
    <h2>Ferramentas Usadas</h2>
    <div id="tools-display"><span class="empty">nenhuma chamada</span></div>
  </div>
  <div class="section">
    <h2>Visita Agendada</h2>
    <div id="visit-display"><span class="empty">nenhuma visita</span></div>
  </div>
</div>

<script>
let currentLeadId = localStorage.getItem('testLeadId') || null
let pendingAttachment = null   // { type, base64, mimeType, latitude, longitude, label }
const messages = document.getElementById('messages')
const input = document.getElementById('input')
const sendBtn = document.getElementById('send-btn')
const resetBtn = document.getElementById('reset-btn')
const leadIdDisplay = document.getElementById('lead-id-display')
const stateDisplay = document.getElementById('state-display')
const leadData = document.getElementById('lead-data')
const toolsDisplay = document.getElementById('tools-display')
const visitDisplay = document.getElementById('visit-display')
const attachBtn = document.getElementById('attach-btn')
const fileInput = document.getElementById('file-input')
const attachDisplay = document.getElementById('attach-display')
const micBtn = document.getElementById('mic-btn')
const locBtn = document.getElementById('loc-btn')
const locRow = document.getElementById('loc-row')
const locLat = document.getElementById('loc-lat')
const locLng = document.getElementById('loc-lng')
const locPresetFortaleza = document.getElementById('loc-preset-fortaleza')
const locCancel = document.getElementById('loc-cancel')
const toggleAiBtn = document.getElementById('toggle-ai-btn')
const humanBanner = document.getElementById('human-banner')
const humanComposer = document.getElementById('human-composer')
const humanInput = document.getElementById('human-input')
const humanSendBtn = document.getElementById('human-send-btn')
let aiPaused = false

let mediaRecorder = null
let audioChunks = []
let recordingStream = null
let recordingStartTs = 0

function updateLeadIdDisplay() {
  leadIdDisplay.textContent = currentLeadId ? 'leadId: ' + currentLeadId.slice(0, 24) + '...' : 'Nenhuma conversa ativa'
}
function addMessage(role, content) {
  const div = document.createElement('div')
  div.className = 'msg ' + role
  div.textContent = content
  messages.appendChild(div)
  messages.scrollTop = messages.scrollHeight
}
function applyAiPausedUI() {
  if (aiPaused) {
    toggleAiBtn.textContent = '👤 Modo Humano'
    toggleAiBtn.classList.add('paused')
    humanBanner.classList.add('active')
    humanComposer.classList.add('active')
  } else {
    toggleAiBtn.textContent = '🤖 Ana ativa'
    toggleAiBtn.classList.remove('paused')
    humanBanner.classList.remove('active')
    humanComposer.classList.remove('active')
  }
}
async function toggleAi() {
  if (!currentLeadId) {
    alert('Inicie uma conversa enviando uma mensagem antes de pausar a Ana.')
    return
  }
  try {
    const res = await fetch('/api/test/toggle-ai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ leadId: currentLeadId, paused: !aiPaused }),
    })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const data = await res.json()
    aiPaused = data.aiPaused
    applyAiPausedUI()
    addMessage('system', aiPaused ? '⏸ Ana pausada. Você responde manualmente agora.' : '▶ Ana retomada. Próxima mensagem do lead vai pra ela.')
  } catch (e) {
    alert('Falha ao alternar: ' + e.message)
  }
}
async function sendHumanReply() {
  const text = humanInput.value.trim()
  if (!text || !currentLeadId) return
  humanInput.value = ''
  humanSendBtn.disabled = true
  addMessage('human', text)
  try {
    const res = await fetch('/api/test/human-reply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ leadId: currentLeadId, message: text }),
    })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    // Refresh known count so the poller doesn't duplicate this message
    try {
      const fresh = await fetch('/api/test/history/' + currentLeadId)
      if (fresh.ok) {
        const d = await fresh.json()
        knownMessageCount = d.messages.length
      }
    } catch (_) {}
  } catch (e) {
    addMessage('system', 'Erro ao enviar resposta humana: ' + e.message)
  } finally {
    humanSendBtn.disabled = false
    humanInput.focus()
  }
}
toggleAiBtn.addEventListener('click', toggleAi)
humanSendBtn.addEventListener('click', sendHumanReply)
humanInput.addEventListener('keydown', function(e){ if (e.key === 'Enter') sendHumanReply() })
function renderField(label, value) {
  return '<div class="field"><span>' + label + '</span><span>' + (value || '&mdash;') + '</span></div>'
}
function renderState(state) {
  if (!state) { stateDisplay.innerHTML = '<span class="empty">aguardando</span>'; return }
  stateDisplay.innerHTML = '<span class="badge state ' + state.toLowerCase() + '">' + state + '</span>'
}
function renderLead(lead) {
  if (!lead) return
  let html = ''
  html += renderField('Nome', lead.name)
  html += renderField('Cidade', lead.city)
  html += renderField('Conta de luz', lead.energyBill ? 'R$ ' + lead.energyBill : null)
  html += renderField('Tipo', lead.propertyType)
  html += renderField('Status', lead.status)
  leadData.innerHTML = html
}
let allTools = []
function renderTools(newTools) {
  if (newTools && newTools.length) allTools = allTools.concat(newTools)
  if (!allTools.length) { toolsDisplay.innerHTML = '<span class="empty">nenhuma chamada</span>'; return }
  toolsDisplay.innerHTML = allTools.map(function(t){ return '<span class="badge tool">' + t + '</span>' }).join('')
}
function renderVisit(visit) {
  if (!visit) return
  const dt = new Date(visit.dateTime)
  const formatted = dt.toLocaleString('pt-BR', { weekday: 'long', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
  visitDisplay.innerHTML =
    '<div class="field"><span>Data</span><span>' + formatted + '</span></div>' +
    '<div class="field"><span>Consultor</span><span>' + visit.consultantId.slice(0, 16) + '...</span></div>' +
    '<a class="calendar-link" href="https://calendar.google.com/" target="_blank">Abrir Google Calendar &rarr;</a>'
}

function renderAttachPill() {
  if (!pendingAttachment) { attachDisplay.innerHTML = ''; return }
  attachDisplay.innerHTML =
    '<span class="attach-pill">' +
    (pendingAttachment.type === 'image' ? '🖼️ ' : pendingAttachment.type === 'document' ? '📄 ' : '📍 ') +
    pendingAttachment.label +
    '<span class="x" id="attach-clear">✕</span></span>'
  document.getElementById('attach-clear').addEventListener('click', function(){
    pendingAttachment = null; renderAttachPill()
  })
}

function fileToBase64(file) {
  return new Promise(function(resolve, reject) {
    const reader = new FileReader()
    reader.onload = function() {
      const dataUrl = reader.result
      const base64 = dataUrl.split(',')[1]
      resolve(base64)
    }
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

attachBtn.addEventListener('click', function(){ fileInput.click() })

fileInput.addEventListener('change', async function(){
  const file = fileInput.files && fileInput.files[0]
  if (!file) return
  if (file.size > 18 * 1024 * 1024) {
    alert('Arquivo muito grande (limite 18 MB)')
    fileInput.value = ''
    return
  }
  const base64 = await fileToBase64(file)
  const isImage = file.type.startsWith('image/')
  const isAudio = file.type.startsWith('audio/')
  pendingAttachment = {
    type: isImage ? 'image' : isAudio ? 'audio' : 'document',
    base64: base64,
    mimeType: file.type || (isImage ? 'image/jpeg' : isAudio ? 'audio/ogg' : 'application/pdf'),
    label: file.name + ' (' + Math.round(file.size/1024) + ' KB)',
  }
  renderAttachPill()
  fileInput.value = ''
  input.focus()
})

// ─── Audio recording (MediaRecorder) ──────────────────────────────────────────
async function startRecording() {
  try {
    recordingStream = await navigator.mediaDevices.getUserMedia({ audio: true })
  } catch (e) {
    alert('Nao foi possivel acessar o microfone: ' + e.message)
    return
  }
  // Pick a mime type the browser supports (Chrome/Edge prefer webm; Safari prefers mp4)
  const candidates = ['audio/webm;codecs=opus','audio/webm','audio/ogg;codecs=opus','audio/mp4','audio/aac']
  let mimeType = ''
  for (const c of candidates) { if (window.MediaRecorder && MediaRecorder.isTypeSupported(c)) { mimeType = c; break } }
  mediaRecorder = new MediaRecorder(recordingStream, mimeType ? { mimeType: mimeType } : undefined)
  audioChunks = []
  recordingStartTs = Date.now()
  mediaRecorder.ondataavailable = function(e){ if (e.data && e.data.size > 0) audioChunks.push(e.data) }
  mediaRecorder.onstop = async function(){
    const blob = new Blob(audioChunks, { type: mediaRecorder.mimeType || 'audio/webm' })
    const durationSec = ((Date.now() - recordingStartTs) / 1000).toFixed(1)
    if (recordingStream) recordingStream.getTracks().forEach(function(t){ t.stop() })
    recordingStream = null
    const base64 = await fileToBase64(blob)
    pendingAttachment = {
      type: 'audio',
      base64: base64,
      mimeType: blob.type,
      label: 'Audio gravado (' + durationSec + 's, ' + Math.round(blob.size/1024) + ' KB)',
    }
    renderAttachPill()
    micBtn.classList.remove('recording')
    micBtn.textContent = '🎤'
    input.focus()
  }
  mediaRecorder.start()
  micBtn.classList.add('recording')
  micBtn.textContent = '⏹'
  micBtn.title = 'Clique para parar de gravar'
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop()
}

micBtn.addEventListener('click', function(){
  if (micBtn.classList.contains('recording')) stopRecording()
  else startRecording()
})

locBtn.addEventListener('click', function(){
  locRow.classList.toggle('active')
  if (locRow.classList.contains('active')) locLat.focus()
})

locPresetFortaleza.addEventListener('click', function(){
  locLat.value = '-3.7437'    // Aldeota, Fortaleza-CE (referência)
  locLng.value = '-38.4977'
})

locCancel.addEventListener('click', function(){
  locRow.classList.remove('active')
  locLat.value = ''
  locLng.value = ''
})

async function send() {
  const text = input.value.trim()

  // If location coordinates are filled, treat as location attachment
  const locLatVal = parseFloat(locLat.value)
  const locLngVal = parseFloat(locLng.value)
  if (!isNaN(locLatVal) && !isNaN(locLngVal)) {
    pendingAttachment = {
      type: 'location',
      latitude: locLatVal,
      longitude: locLngVal,
      label: 'lat: ' + locLatVal.toFixed(4) + ', lng: ' + locLngVal.toFixed(4),
    }
    locRow.classList.remove('active')
    locLat.value = ''
    locLng.value = ''
  }

  if (!text && !pendingAttachment) return
  sendBtn.disabled = true
  const userDisplay = (text || '') +
    (pendingAttachment ? (text ? ' ' : '') + '[' + pendingAttachment.label + ']' : '')
  addMessage('user', userDisplay)
  input.value = ''
  const payloadAttachment = pendingAttachment
  pendingAttachment = null
  renderAttachPill()

  try {
    const body = { leadId: currentLeadId, message: text }
    if (payloadAttachment) {
      body.attachment = payloadAttachment.type === 'location'
        ? { type: 'location', latitude: payloadAttachment.latitude, longitude: payloadAttachment.longitude }
        : { type: payloadAttachment.type, base64: payloadAttachment.base64, mimeType: payloadAttachment.mimeType }
    }
    const res = await fetch('/api/test/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const data = await res.json()
    if (!currentLeadId) {
      currentLeadId = data.leadId
      localStorage.setItem('testLeadId', currentLeadId)
      updateLeadIdDisplay()
    }
    if (data.transcription) addMessage('system', '🎤 Transcricao: "' + data.transcription + '"')
    if (data.resolvedAddress) addMessage('system', '📍 Endereco resolvido: ' + data.resolvedAddress)
    if (data.aiPaused) {
      addMessage('system', '⏸ Mensagem do lead recebida. Ana esta pausada — responda manualmente abaixo.')
    }
    if (data.response) addMessage('assistant', data.response)
    if (data.escalated) addMessage('system', 'Conversa escalada para consultor humano')
    if (data.scheduledVisit) addMessage('system', 'Visita agendada no Google Calendar')
    if (data.toolsUsed && data.toolsUsed.indexOf('schedule_callback') !== -1) {
      addMessage('system', '⏰ Retorno automatico agendado — vou aparecer aqui sozinha quando a hora chegar')
    }
    // Refresh known count so the poller does not duplicate this user+assistant pair
    try {
      const fresh = await fetch('/api/test/history/' + currentLeadId)
      if (fresh.ok) {
        const freshData = await fresh.json()
        knownMessageCount = freshData.messages.length
      }
    } catch (_) {}
    renderState(data.state)
    renderLead(data.lead)
    renderTools(data.toolsUsed)
    if (data.scheduledVisit) renderVisit(data.scheduledVisit)
  } catch (e) {
    addMessage('system', 'Erro: ' + e.message)
  } finally {
    sendBtn.disabled = false
    input.focus()
  }
}

async function reset() {
  if (currentLeadId) {
    await fetch('/api/test/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ leadId: currentLeadId }),
    }).catch(function(){})
  }
  currentLeadId = null
  allTools = []
  knownMessageCount = 0
  aiPaused = false
  applyAiPausedUI()
  localStorage.removeItem('testLeadId')
  messages.innerHTML = '<div class="msg system">Nova conversa iniciada. Digite uma mensagem para comecar.</div>'
  updateLeadIdDisplay()
  stateDisplay.innerHTML = '<span class="empty">aguardando primeira mensagem</span>'
  leadData.innerHTML = '<div class="empty">sem dados ainda</div>'
  toolsDisplay.innerHTML = '<span class="empty">nenhuma chamada</span>'
  visitDisplay.innerHTML = '<span class="empty">nenhuma visita</span>'
  input.focus()
}

async function restoreHistory() {
  if (!currentLeadId) return
  updateLeadIdDisplay()
  try {
    const res = await fetch('/api/test/history/' + currentLeadId)
    if (!res.ok) {
      localStorage.removeItem('testLeadId')
      currentLeadId = null
      updateLeadIdDisplay()
      return
    }
    const data = await res.json()
    messages.innerHTML = ''
    knownMessageCount = data.messages.length
    for (const m of data.messages) {
      addMessage(m.role === 'user' ? 'user' : 'assistant', m.content)
    }
    renderState(data.state)
    aiPaused = !!data.aiPaused
    applyAiPausedUI()
  } catch (e) {}
}

// ─── Polling for scheduled callbacks ──────────────────────────────────────────
// The schedule_callback tool fires after a delay and writes a new assistant
// message to the DB. We poll history every 5 s to surface that message live.
let knownMessageCount = 0
async function pollForNewMessages() {
  if (!currentLeadId) return
  try {
    const res = await fetch('/api/test/history/' + currentLeadId)
    if (!res.ok) return
    const data = await res.json()
    if (data.messages.length > knownMessageCount) {
      const newOnes = data.messages.slice(knownMessageCount)
      for (const m of newOnes) {
        const role = m.role === 'user' ? 'user' : 'assistant'
        if (role === 'assistant') addMessage('system', '⏰ Retorno agendado da Ana:')
        addMessage(role, m.content)
      }
      knownMessageCount = data.messages.length
      renderState(data.state)
    }
    // Sync pause state in case it was toggled elsewhere
    if (typeof data.aiPaused === 'boolean' && data.aiPaused !== aiPaused) {
      aiPaused = data.aiPaused
      applyAiPausedUI()
    }
  } catch (e) {}
}
setInterval(pollForNewMessages, 5000)

input.addEventListener('keydown', function(e){ if (e.key === 'Enter') send() })
sendBtn.addEventListener('click', send)
resetBtn.addEventListener('click', reset)
restoreHistory()
input.focus()
</script>
</body>
</html>`

main()
