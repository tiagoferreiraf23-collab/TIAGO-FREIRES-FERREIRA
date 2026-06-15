import Anthropic from '@anthropic-ai/sdk'
import { prisma } from '../prisma/client'
import { createChildLogger } from '../logger'
import { env } from '../config'
import { buildSystemPrompt } from '../ai/prompts/sdr-prompt'
import { sendTextMessage } from '../modules/whatsapp/whatsapp.service'
import { ConversationState, MessageRole } from '@sdr-solar/shared'

const log = createChildLogger('callback-worker')
const anthropic = new Anthropic({ apiKey: env.anthropic.apiKey })

/**
 * Fires after the delay set by the schedule_callback tool. Generates and sends
 * a natural continuation of the paused conversation — unless the lead already
 * came back on their own (we don't want to spam).
 */
export async function processScheduledCallback(data: {
  leadId: string
  conversationId: string
  delayMinutes: number
  reason: string
}): Promise<void> {
  const conversation = await prisma.conversation.findUnique({
    where: { id: data.conversationId },
    include: {
      messages: { orderBy: { sentAt: 'asc' }, take: 30 },
      lead: true,
    },
  })

  if (!conversation) {
    log.warn({ conversationId: data.conversationId }, 'Conversation not found, skipping callback')
    return
  }

  // Skip if conversation reached a terminal state in the meantime
  const terminalStates: ConversationState[] = [
    ConversationState.CLOSED,
    ConversationState.ESCALATED,
    ConversationState.CONFIRMED,
    ConversationState.NO_RESPONSE,
  ]
  if (terminalStates.includes(conversation.state as ConversationState)) {
    log.info(
      { conversationId: data.conversationId, state: conversation.state },
      'Conversation in terminal state, skipping callback',
    )
    return
  }

  // Skip while the AI is paused (manual takeover) — the human attendant will handle it
  if (conversation.aiPaused) {
    log.info({ conversationId: data.conversationId }, 'AI paused — skipping scheduled callback')
    return
  }

  // Skip if the lead already responded on their own since the callback was scheduled.
  // The last message in the conversation should be from the assistant (the one that
  // called schedule_callback). If it's from the user, they came back early.
  const lastMessage = conversation.messages[conversation.messages.length - 1]
  if (lastMessage?.role === MessageRole.USER) {
    log.info(
      { conversationId: data.conversationId },
      'Lead already responded since callback was scheduled, skipping',
    )
    return
  }

  const lead = conversation.lead

  // ─── Generate a natural continuation message ─────────────────────────────
  const systemPrompt = buildSystemPrompt({
    leadId: lead.id,
    name: lead.name,
    energyBill: lead.energyBill ?? undefined,
    city: lead.city ?? undefined,
    propertyType: lead.propertyType ?? undefined,
    followUpCount: lead.followUpCount,
  })

  const callbackInstruction = `[INSTRUÇÃO INTERNA, NÃO REPITA]
Você combinou com o lead que voltaria a falar com ele depois de ${data.delayMinutes} minutos. Esse tempo agora passou. Contexto do pedido: "${data.reason}".

Gere UMA mensagem curta e natural retomando a conversa de onde parou. NÃO se apresente de novo. NÃO peça desculpa por demorar. Faça a próxima pergunta lógica do roteiro ou retome o assunto que estava sendo discutido antes da pausa. Tom amigável e leve.

Responda APENAS com a mensagem que será enviada ao lead, sem qualquer outro texto.`

  const messages: Anthropic.MessageParam[] = conversation.messages.map((m) => ({
    role: m.role as 'user' | 'assistant',
    content: m.content,
  }))
  messages.push({ role: 'user', content: callbackInstruction })

  const response = await anthropic.messages.create({
    model: env.anthropic.model,
    max_tokens: 300,
    system: systemPrompt,
    messages,
  })

  const textBlock = response.content.find((b) => b.type === 'text')
  const callbackMessage = textBlock?.type === 'text' ? textBlock.text.trim() : ''

  if (!callbackMessage) {
    log.warn({ conversationId: data.conversationId }, 'Empty callback message generated, skipping send')
    return
  }

  // For test_panel leads we don't try to reach a real WhatsApp number — the
  // panel polls history and shows the message as soon as it lands in the DB.
  const isTestLead = lead.source === 'test_panel'

  let messageId: string | null = null
  if (!isTestLead) {
    const storedJid = lead.whatsappJid ?? ''
    const replyTo = storedJid.includes('@s.whatsapp.net') ? storedJid : lead.phone
    messageId = await sendTextMessage(replyTo, callbackMessage)
  }

  await prisma.message.create({
    data: {
      conversationId: conversation.id,
      role: MessageRole.ASSISTANT,
      content: callbackMessage,
      whatsappId: messageId ?? undefined,
      sentAt: new Date(),
      metadata: {
        kind: 'scheduled_callback',
        delayMinutes: data.delayMinutes,
        reason: data.reason,
      },
    },
  })

  log.info(
    { leadId: lead.id, conversationId: data.conversationId, messageId, isTestLead },
    'Scheduled callback sent',
  )
}
