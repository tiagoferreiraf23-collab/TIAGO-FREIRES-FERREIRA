import { prisma } from '../../prisma/client'
import { createChildLogger } from '../../logger'
import { processMessage } from '../../ai/sdr-agent'
import { sendTextMessage, sendMediaMessage } from '../whatsapp/whatsapp.service'
import { notifyTeam } from '../notifications/notifications.service'
import { ConversationState, LeadStatus } from '@sdr-solar/shared'

const log = createChildLogger('conversations')

export async function handleIncomingMessage(data: {
  leadId: string
  conversationId: string
  message: string
  messageId: string
}): Promise<void> {
  const lead = await prisma.lead.findUnique({
    where: { id: data.leadId },
    include: { conversations: true },
  })

  if (!lead) {
    log.warn({ leadId: data.leadId }, 'Lead not found for message processing')
    return
  }

  const conversation = await prisma.conversation.findUnique({
    where: { id: data.conversationId },
  })

  if (!conversation) {
    log.warn({ conversationId: data.conversationId }, 'Conversation not found')
    return
  }

  // Skip se conversa encerrada ou escalada
  if (
    conversation.state === ConversationState.CLOSED ||
    conversation.state === ConversationState.ESCALATED
  ) {
    log.info({ conversationId: data.conversationId, state: conversation.state }, 'Conversation not active, skipping')
    return
  }

  // AI pausada (modo humano) — só salva a mensagem do lead e sai.
  // O atendente humano vai responder pelo painel/dashboard.
  if (conversation.aiPaused) {
    await prisma.message.create({
      data: {
        conversationId: data.conversationId,
        role: 'user',
        content: data.message,
        sentAt: new Date(),
      },
    })
    log.info({ conversationId: data.conversationId }, 'AI paused — incoming message saved without auto-response')
    return
  }

  // @lid JIDs are privacy-preserving device identifiers — Evolution API cannot resolve
  // them for outbound delivery (returns exists:false). Only use a stored JID for sending
  // if it is a full @s.whatsapp.net address; otherwise fall back to the numeric phone.
  const storedJid = lead.whatsappJid ?? ''
  const replyTo = storedJid.includes('@s.whatsapp.net') ? storedJid : lead.phone
  log.info({ leadId: lead.id, replyTo, storedJid }, 'Reply target resolved')

  // Visita já confirmada — NÃO fecha a conversa automaticamente. Deixa a Ana
  // processar a mensagem normalmente com o histórico completo (incluindo a
  // visita agendada). Assim ela pode lidar com remarcação, dúvidas, confirmação,
  // etc. sem reiniciar o atendimento como se fosse lead novo.
  // (A conversa só fecha de verdade quando o lead pede explicitamente ou após
  // os follow-ups esgotarem — não automaticamente após agendamento.)

  log.info({ leadId: lead.id, conversationId: data.conversationId, messagePreview: data.message.slice(0, 60) }, 'Processing incoming message')

  const agentResponse = await processMessage(data.message, {
    leadId: lead.id,
    leadName: lead.name,
    energyBill: lead.energyBill ?? undefined,
    city: lead.city ?? undefined,
    propertyType: lead.propertyType ?? undefined,
    followUpCount: lead.followUpCount,
    conversationId: data.conversationId,
  })

  // Send the text response
  if (agentResponse.message) {
    await sendTextMessage(replyTo, agentResponse.message)
  }

  // Send media if requested
  if (agentResponse.mediaToSend) {
    await sendMediaMessage(
      replyTo,
      agentResponse.mediaToSend.url,
      agentResponse.mediaToSend.type as 'image' | 'video' | 'document',
      agentResponse.mediaToSend.caption,
    )
  }

  // Handle escalation
  if (agentResponse.escalated) {
    await prisma.conversation.update({
      where: { id: data.conversationId },
      // Clear activeKey — terminal state, lead may open a new conversation later
      data: { state: ConversationState.ESCALATED as unknown as 'INITIAL_CONTACT', activeKey: null },
    })
    log.info({ leadId: lead.id }, 'Conversation escalated to human')
    return
  }

  // Handle scheduled visit
  if (agentResponse.scheduledVisit) {
    await Promise.all([
      prisma.conversation.update({
        where: { id: data.conversationId },
        data: { state: ConversationState.CONFIRMED as unknown as 'INITIAL_CONTACT' },
      }),
      notifyTeam({
        type: 'scheduled',
        leadName: lead.name,
        leadPhone: replyTo,
        consultantName: 'Consultor',
        dateTime: agentResponse.scheduledVisit.dateTime,
        city: lead.city ?? undefined,
      }),
      scheduleVisitReminders(
        replyTo,
        lead.name,
        agentResponse.scheduledVisit.consultantId,
        agentResponse.scheduledVisit.dateTime,
      ),
    ])
    return
  }

  // Update conversation state based on context
  const nextState = inferNextState(conversation.state as ConversationState, data.message)
  if (nextState !== conversation.state) {
    await prisma.conversation.update({
      where: { id: data.conversationId },
      data: { state: nextState as unknown as 'INITIAL_CONTACT' },
    })
  }

  // Update lead status to contacted
  if (lead.status === LeadStatus.NEW) {
    await prisma.lead.update({
      where: { id: lead.id },
      data: { status: LeadStatus.CONTACTED as unknown as 'NEW' },
    })
  }

  // Schedule a fresh follow-up anchored on this Ana message. If the lead
  // responds before it fires, the worker will see the newer user message
  // and skip itself — naturally resetting the timer.
  //
  // SKIP follow-up if Ana already scheduled a callback this turn: the callback
  // IS the "next contact" the lead asked for. Without this, Ana confirms
  // "te chamo no final do dia" and the 5-min generic follow-up fires anyway —
  // exactly the bug seen with the lead Tamyris on 2026-06-19.
  const calledCallback = agentResponse.toolsUsed?.includes('schedule_callback')
  if (agentResponse.message && !calledCallback) {
    const { enqueueFollowUp } = await import('../../queues')
    await enqueueFollowUp(lead.id, 1, new Date())
  }
}

async function scheduleVisitReminders(
  phone: string,
  name: string,
  consultantId: string,
  visitDate: Date,
): Promise<void> {
  const consultant = await prisma.consultant.findUnique({ where: { id: consultantId } })
  const consultantName = consultant?.name ?? 'nosso consultor'

  const reminder24h = new Date(visitDate.getTime() - 24 * 60 * 60 * 1000)
  const reminder2h = new Date(visitDate.getTime() - 2 * 60 * 60 * 1000)
  const now = new Date()

  if (reminder24h > now) {
    const { enqueueReminder } = await import('../../queues')
    await enqueueReminder({ phone, name, consultantName, visitDate, hoursUntil: 24 }, reminder24h)
  }

  if (reminder2h > now) {
    const { enqueueReminder } = await import('../../queues')
    await enqueueReminder({ phone, name, consultantName, visitDate, hoursUntil: 2 }, reminder2h)
  }
}

function inferNextState(current: ConversationState, message: string): ConversationState {
  const lower = message.toLowerCase()

  if (current === ConversationState.INITIAL_CONTACT) {
    const positiveWords = ['sim', 'claro', 'quero', 'interesse', 'ok', 'pode', 'tá bom', 'vamos']
    if (positiveWords.some((w) => lower.includes(w))) {
      return ConversationState.QUALIFYING
    }
  }

  if (current === ConversationState.QUALIFYING) {
    const schedulingWords = ['quando', 'horario', 'horário', 'data', 'dia', 'semana', 'manhã', 'tarde']
    if (schedulingWords.some((w) => lower.includes(w))) {
      return ConversationState.SCHEDULING
    }
  }

  return current
}

export async function getConversationHistory(leadId: string) {
  return prisma.conversation.findMany({
    where: { leadId },
    include: {
      messages: { orderBy: { sentAt: 'asc' } },
    },
    orderBy: { createdAt: 'desc' },
  })
}
