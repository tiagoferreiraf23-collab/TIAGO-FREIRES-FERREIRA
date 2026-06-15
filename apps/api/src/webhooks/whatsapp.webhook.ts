import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { createChildLogger } from '../logger'
import { env } from '../config'
import { processIncomingWhatsApp } from '../modules/leads/leads.service'
import { downloadMetaMedia } from '../modules/whatsapp/whatsapp.service'
import { transcribeAudio, reverseGeocode } from '../ai/multimodal'

const log = createChildLogger('webhook:whatsapp')

// ─── Evolution payload ───────────────────────────────────────────────────────
interface EvolutionWebhookBody {
  event: string
  instance: string
  data: {
    key?: { remoteJid?: string; fromMe?: boolean; id?: string }
    message?: {
      conversation?: string
      extendedTextMessage?: { text?: string }
      imageMessage?: { caption?: string }
      audioMessage?: Record<string, unknown>
    }
    messageTimestamp?: number
    pushName?: string
    status?: string
  }
}

// ─── WAHA payload (message event) ────────────────────────────────────────────
interface WAHAWebhookBody {
  event: string
  session?: string
  payload?: {
    id?: string
    timestamp?: number
    from?: string
    fromMe?: boolean
    body?: string
    hasMedia?: boolean
    _data?: { notifyName?: string; pushName?: string }
  }
}

// ─── Meta Cloud API payload ──────────────────────────────────────────────────
// https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/payload-examples
interface MetaCloudWebhookBody {
  object: string                     // "whatsapp_business_account"
  entry?: Array<{
    id?: string
    changes?: Array<{
      field: string                  // "messages"
      value?: {
        messaging_product?: string
        metadata?: { display_phone_number?: string; phone_number_id?: string }
        contacts?: Array<{ profile?: { name?: string }; wa_id?: string }>
        messages?: Array<{
          from?: string              // raw international, e.g. "5588998032895"
          id?: string                // "wamid.xxx..."
          timestamp?: string         // unix seconds (as string!)
          type?: string              // "text", "image", "audio", "interactive", etc.
          text?: { body?: string }
          image?: { caption?: string; id?: string; mime_type?: string }
          audio?: { id?: string; mime_type?: string; voice?: boolean }
          document?: { id?: string; mime_type?: string; filename?: string; caption?: string }
          location?: { latitude?: number; longitude?: number; name?: string; address?: string }
          interactive?: { button_reply?: { title?: string }; list_reply?: { title?: string } }
        }>
        statuses?: Array<{ id?: string; status?: string; recipient_id?: string }>
      }
    }>
  }>
}

interface NormalizedIncoming {
  phone: string
  text: string
  messageId: string
  timestamp: number
  pushName?: string
  fromMe: boolean
  isGroup: boolean
  // Optional attachment to be resolved asynchronously (audio downloaded + transcribed,
  // location reverse-geocoded, image/document base64 fetched, etc.)
  pendingMedia?: {
    kind: 'audio' | 'image' | 'document' | 'location'
    metaMediaId?: string
    mimeType?: string
    latitude?: number
    longitude?: number
    caption?: string
  }
}

/** Detect payload shape and normalize to a single internal format */
function normalize(body: unknown): NormalizedIncoming | null {
  if (!body || typeof body !== 'object') return null

  // Meta Cloud API — has `object: 'whatsapp_business_account'` and `entry[].changes[]`
  if ('object' in body && (body as { object?: string }).object === 'whatsapp_business_account') {
    const b = body as MetaCloudWebhookBody
    const change = b.entry?.[0]?.changes?.[0]
    if (change?.field !== 'messages') return null
    const value = change.value
    const msg = value?.messages?.[0]
    if (!msg) return null

    const baseText =
      msg.text?.body ??
      msg.image?.caption ??
      msg.document?.caption ??
      msg.interactive?.button_reply?.title ??
      msg.interactive?.list_reply?.title ??
      ''

    let pendingMedia: NormalizedIncoming['pendingMedia']

    if (msg.type === 'audio' && msg.audio?.id) {
      pendingMedia = {
        kind: 'audio',
        metaMediaId: msg.audio.id,
        mimeType: msg.audio.mime_type,
      }
    } else if (msg.type === 'image' && msg.image?.id) {
      pendingMedia = {
        kind: 'image',
        metaMediaId: msg.image.id,
        mimeType: msg.image.mime_type,
        caption: msg.image.caption,
      }
    } else if (msg.type === 'document' && msg.document?.id) {
      pendingMedia = {
        kind: 'document',
        metaMediaId: msg.document.id,
        mimeType: msg.document.mime_type,
        caption: msg.document.caption,
      }
    } else if (msg.type === 'location' && msg.location?.latitude != null && msg.location?.longitude != null) {
      pendingMedia = {
        kind: 'location',
        latitude: msg.location.latitude,
        longitude: msg.location.longitude,
      }
    }

    return {
      phone: msg.from ?? '',
      text: baseText,
      messageId: msg.id ?? '',
      timestamp: msg.timestamp ? parseInt(msg.timestamp) : Math.floor(Date.now() / 1000),
      pushName: value?.contacts?.[0]?.profile?.name,
      fromMe: false,
      isGroup: false,
      pendingMedia,
    }
  }

  // WAHA — has `event: 'message'` plus nested `payload.from`/`payload.body`
  if ('event' in body && 'payload' in body) {
    const b = body as WAHAWebhookBody
    if (b.event !== 'message') return null
    const p = b.payload
    if (!p) return null
    return {
      phone: p.from ?? '',
      text: p.body ?? '',
      messageId: p.id ?? '',
      timestamp: p.timestamp ?? Math.floor(Date.now() / 1000),
      pushName: p._data?.pushName ?? p._data?.notifyName,
      fromMe: p.fromMe ?? false,
      isGroup: (p.from ?? '').includes('@g.us'),
    }
  }

  // Evolution — has `event: 'messages.upsert'` plus nested `data.key.remoteJid`
  const e = body as EvolutionWebhookBody
  if (e.event !== 'messages.upsert') return null
  const { key, message, messageTimestamp, pushName } = e.data
  const remoteJid = key?.remoteJid ?? ''
  const text =
    message?.conversation ??
    message?.extendedTextMessage?.text ??
    message?.imageMessage?.caption ??
    ''
  return {
    phone: remoteJid,
    text,
    messageId: key?.id ?? '',
    timestamp: messageTimestamp ?? Math.floor(Date.now() / 1000),
    pushName,
    fromMe: key?.fromMe ?? false,
    isGroup: remoteJid.includes('@g.us'),
  }
}

/**
 * Resolves any pending media (audio → transcription, location → address, etc.)
 * and then forwards the resulting text to the SDR pipeline. Image/document
 * media for now only sets a marker — full attachment flow would require
 * propagating bytes through the BullMQ queue (not done yet).
 */
async function resolveAndProcess(incoming: NormalizedIncoming): Promise<void> {
  let text = incoming.text

  if (incoming.pendingMedia) {
    const pm = incoming.pendingMedia
    if (pm.kind === 'audio' && pm.metaMediaId) {
      log.info({ mediaId: pm.metaMediaId, mimeType: pm.mimeType }, 'Downloading audio for transcription')
      const media = await downloadMetaMedia(pm.metaMediaId)
      if (media) {
        const transcription = await transcribeAudio(media.data, media.mimeType)
        if (transcription) {
          text = text ? `${text}\n\n${transcription}` : transcription
          log.info({ phone: incoming.phone, transcriptionLength: transcription.length }, 'Audio transcribed')
        } else {
          text = text || '[Sistema: lead enviou um áudio, mas a transcrição falhou — peça gentilmente pra digitar.]'
        }
      } else {
        text = text || '[Sistema: lead enviou um áudio, mas o download falhou — peça pra digitar.]'
      }
    } else if (pm.kind === 'location' && pm.latitude != null && pm.longitude != null) {
      const geo = await reverseGeocode(pm.latitude, pm.longitude)
      const address = geo?.formattedAddress ?? `${pm.latitude},${pm.longitude}`
      text = text
        ? `${text}\n\n[Lead enviou sua localização. Endereço aproximado: ${address}]`
        : `[Lead enviou sua localização. Endereço aproximado: ${address}]`
    } else if (pm.kind === 'image') {
      text = text || '[Lead enviou uma imagem — provavelmente foto da conta de luz. Peça pra ele descrever o valor que aparece, OU diga que vai pedir pro engenheiro analisar.]'
    } else if (pm.kind === 'document') {
      text = text || '[Lead enviou um PDF — provavelmente a conta de luz. Peça gentilmente pra ele digitar o valor total e o consumo em kWh.]'
    }
  }

  if (!text) {
    log.debug({ phone: incoming.phone }, 'Empty text after media resolution, skipping')
    return
  }

  log.info({ phone: incoming.phone, textPreview: text.slice(0, 80) }, 'Incoming WhatsApp message resolved')

  await processIncomingWhatsApp({
    phone: incoming.phone,
    message: text,
    messageId: incoming.messageId,
    timestamp: incoming.timestamp,
    pushName: incoming.pushName,
  })
}

export async function registerWhatsAppWebhook(app: FastifyInstance): Promise<void> {
  // Meta Cloud API verification handshake (GET request from Meta dashboard during setup)
  // Returns hub.challenge as plain text if hub.verify_token matches our META_VERIFY_TOKEN.
  app.get('/webhooks/whatsapp', async (request: FastifyRequest, reply: FastifyReply) => {
    const q = request.query as Record<string, string>
    const mode = q['hub.mode']
    const token = q['hub.verify_token']
    const challenge = q['hub.challenge']
    if (mode === 'subscribe' && token && token === env.meta.verifyToken) {
      log.info('Meta Cloud webhook verified')
      return reply.type('text/plain').send(challenge)
    }
    log.warn({ mode, hasToken: !!token }, 'Meta Cloud webhook verification failed')
    return reply.code(403).send({ error: 'Forbidden' })
  })

  app.post('/webhooks/whatsapp', async (request: FastifyRequest, reply: FastifyReply) => {
    const incoming = normalize(request.body)

    if (!incoming) {
      return reply.send({ status: 'ok', ignored: 'unknown_format_or_non_message_event' })
    }

    if (incoming.fromMe) return reply.send({ status: 'ok' })
    if (incoming.isGroup) return reply.send({ status: 'ok' })
    if (!incoming.phone) return reply.send({ status: 'ok' })

    // Acknowledge the webhook fast — Meta gives ~20 s before timing out. Media
    // download + transcription happens in the background, then we enqueue the
    // already-resolved text for the SDR agent.
    reply.send({ status: 'ok' })

    void resolveAndProcess(incoming).catch((err) =>
      log.error({ err, phone: incoming.phone }, 'Failed to process WhatsApp message'),
    )
    return
  })

  app.post('/webhooks/whatsapp/status', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as EvolutionWebhookBody
    if (body.event !== 'messages.update') {
      return reply.send({ status: 'ok' })
    }
    log.debug({ event: body.event }, 'WhatsApp status update received')
    return reply.send({ status: 'ok' })
  })
}
