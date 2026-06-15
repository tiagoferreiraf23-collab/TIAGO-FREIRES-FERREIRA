import { prisma } from '../prisma/client'
import { createChildLogger } from '../logger'
import { generateFollowUpMessage } from '../ai/sdr-agent'
import { sendTextMessage } from '../modules/whatsapp/whatsapp.service'
import { enqueueFollowUp, type FollowUpAttempt } from './index'
import { LeadStatus, ConversationState, MAX_FOLLOW_UP_ATTEMPTS } from '@sdr-solar/shared'

const log = createChildLogger('follow-up-worker')

export async function processFollowUp(data: {
  leadId: string
  attempt: number
  triggeringMessageAt: string  // ISO date — when Ana's message that started silence was sent
}): Promise<void> {
  const lead = await prisma.lead.findUnique({
    where: { id: data.leadId },
    include: {
      conversations: {
        orderBy: { createdAt: 'desc' },
        take: 1,
      },
    },
  })

  if (!lead) {
    log.warn({ leadId: data.leadId }, 'Lead not found for follow-up')
    return
  }

  // Skip if lead reached a terminal status in the meantime
  const skipStatuses = [
    LeadStatus.QUALIFIED,
    LeadStatus.SCHEDULED,
    LeadStatus.VISITED,
    LeadStatus.WON,
    LeadStatus.LOST,
    LeadStatus.DISQUALIFIED,
    LeadStatus.ESCALATED,
  ]
  if (skipStatuses.includes(lead.status as LeadStatus)) {
    log.info({ leadId: lead.id, status: lead.status }, 'Lead already progressed, skipping follow-up')
    return
  }

  const conversation = lead.conversations[0]
  if (!conversation) {
    log.warn({ leadId: lead.id }, 'No conversation found for follow-up')
    return
  }

  // Skip if conversation reached a terminal state
  const terminalStates: ConversationState[] = [
    ConversationState.CLOSED,
    ConversationState.ESCALATED,
    ConversationState.CONFIRMED,
    ConversationState.NO_RESPONSE,
  ]
  if (terminalStates.includes(conversation.state as ConversationState)) {
    log.info(
      { leadId: lead.id, state: conversation.state },
      'Conversation in terminal state, skipping follow-up',
    )
    return
  }

  // Skip while the AI is paused (manual takeover) — humans drive the conversation
  if (conversation.aiPaused) {
    log.info({ leadId: lead.id, conversationId: conversation.id }, 'AI paused — skipping follow-up')
    return
  }

  // Skip if the lead has responded since this follow-up was scheduled — that means
  // the conversation continued naturally and a NEW follow-up timer has been set
  // for the more recent Ana message.
  const triggeredAt = new Date(data.triggeringMessageAt)
  const userMessageAfter = await prisma.message.findFirst({
    where: {
      conversationId: conversation.id,
      role: 'user',
      sentAt: { gt: triggeredAt },
    },
  })
  if (userMessageAfter) {
    log.info(
      { leadId: lead.id, attempt: data.attempt },
      'Lead responded after follow-up was scheduled, skipping',
    )
    return
  }

  if (data.attempt > MAX_FOLLOW_UP_ATTEMPTS) {
    await markLeadAsNoResponse(lead.id, conversation.id)
    return
  }

  log.info({ leadId: lead.id, attempt: data.attempt }, 'Sending follow-up message')

  const message = await generateFollowUpMessage({
    name: lead.name,
    followUpCount: data.attempt,
    energyBill: lead.energyBill ?? undefined,
  })

  // test_panel leads have no real phone — just persist; the panel polls and shows it
  const isTestLead = lead.source === 'test_panel'

  let messageId: string | null = null
  if (!isTestLead) {
    const storedJid = lead.whatsappJid ?? ''
    const replyTo = storedJid.includes('@s.whatsapp.net') ? storedJid : lead.phone
    messageId = await sendTextMessage(replyTo, message)
  }

  const sentAt = new Date()
  await prisma.message.create({
    data: {
      conversationId: conversation.id,
      role: 'assistant',
      content: message,
      whatsappId: messageId ?? undefined,
      sentAt,
      metadata: { followUpAttempt: data.attempt },
    },
  })

  await prisma.lead.update({
    where: { id: lead.id },
    data: { followUpCount: data.attempt, lastContactAt: sentAt },
  })

  // Chain the next attempt — anchored on the message we just sent
  const nextAttempt = (data.attempt + 1) as FollowUpAttempt
  if (nextAttempt <= MAX_FOLLOW_UP_ATTEMPTS) {
    await enqueueFollowUp(lead.id, nextAttempt, sentAt)
  } else {
    // Out of attempts — mark lead as no-response
    await markLeadAsNoResponse(lead.id, conversation.id)
  }

  log.info({ leadId: lead.id, attempt: data.attempt }, 'Follow-up sent')
}

async function markLeadAsNoResponse(leadId: string, conversationId?: string): Promise<void> {
  await Promise.all([
    prisma.lead.update({
      where: { id: leadId },
      data: { status: LeadStatus.LOST as unknown as 'NEW' },
    }),
    conversationId
      ? prisma.conversation.update({
          where: { id: conversationId },
          // Clear activeKey so a re-engagement can open a new conversation
          data: { state: ConversationState.NO_RESPONSE as unknown as 'INITIAL_CONTACT', activeKey: null },
        })
      : Promise.resolve(),
  ])

  log.info({ leadId }, 'Lead marked as no-response after max follow-ups')
}
