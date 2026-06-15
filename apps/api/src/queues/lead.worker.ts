import { prisma } from '../prisma/client'
import { createChildLogger } from '../logger'
import { generateInitialMessage } from '../ai/sdr-agent'
import { sendTextMessage } from '../modules/whatsapp/whatsapp.service'
import { enqueueFollowUp } from './index'
import { LeadStatus, ConversationState } from '@sdr-solar/shared'

const log = createChildLogger('lead-worker')

export async function processNewLead(data: { leadId: string }): Promise<void> {
  const lead = await prisma.lead.findUnique({ where: { id: data.leadId } })

  if (!lead) {
    log.warn({ leadId: data.leadId }, 'Lead not found in worker')
    return
  }

  // Don't process if already contacted
  if (lead.status !== LeadStatus.NEW) {
    log.info({ leadId: lead.id, status: lead.status }, 'Lead already processed, skipping')
    return
  }

  log.info({ leadId: lead.id, name: lead.name }, 'Sending initial contact message')

  // Generate personalized initial message
  const message = await generateInitialMessage({
    name: lead.name,
    energyBill: lead.energyBill ?? undefined,
    city: lead.city ?? undefined,
  })

  // Create conversation — use upsert by activeKey to avoid duplicating
  // if a parallel worker (e.g. webhook arriving before initial contact fires) already created one.
  const conversation = await prisma.conversation.upsert({
    where: { activeKey: lead.id },
    create: {
      leadId: lead.id,
      state: ConversationState.INITIAL_CONTACT as unknown as 'INITIAL_CONTACT',
      activeKey: lead.id,
    },
    update: {},
  })

  // @lid JIDs are privacy-preserving device identifiers — Evolution API cannot resolve
  // them for outbound delivery. Only use a stored JID for sending if it is a full
  // @s.whatsapp.net address; otherwise fall back to the numeric phone.
  const storedJid = lead.whatsappJid ?? ''
  const replyTo = storedJid.includes('@s.whatsapp.net') ? storedJid : lead.phone

  // Send WhatsApp message
  const messageId = await sendTextMessage(replyTo, message)

  // Save message to DB
  await prisma.message.create({
    data: {
      conversationId: conversation.id,
      role: 'assistant',
      content: message,
      whatsappId: messageId ?? undefined,
      sentAt: new Date(),
    },
  })

  // Update lead status and contact time
  await prisma.lead.update({
    where: { id: lead.id },
    data: {
      status: LeadStatus.CONTACTED as unknown as 'NEW',
      lastContactAt: new Date(),
    },
  })

  // Schedule the first follow-up anchored on the message we just sent.
  // If the lead replies before it fires, the worker will see a newer user
  // message and skip itself automatically.
  await enqueueFollowUp(lead.id, 1, new Date())

  log.info({ leadId: lead.id, messageId }, 'Initial contact sent, follow-up scheduled')
}
