import { createChildLogger } from '../../logger'
import { createLead, findLeadByPhone } from './leads.repository'
import { prisma } from '../../prisma/client'
import { enqueueNewLead } from '../../queues'
import { LeadStatus, ConversationState } from '@sdr-solar/shared'
import type { MetaLeadPayload } from '@sdr-solar/shared'

const log = createChildLogger('leads')

export async function processMetaLead(payload: MetaLeadPayload): Promise<void> {
  const parsed = parseMetaFormData(payload.fieldData)

  if (!parsed.phone) {
    log.warn({ leadgenId: payload.leadgenId }, 'Lead received without phone, skipping')
    return
  }

  const existing = await findLeadByPhone(parsed.phone)
  if (existing) {
    log.info({ phone: parsed.phone, existingId: existing.id }, 'Duplicate lead, skipping')
    return
  }

  const lead = await createLead({
    name: parsed.name ?? 'Lead',
    phone: parsed.phone,
    email: parsed.email,
    city: parsed.city,
    energyBill: parsed.energyBill,
    propertyType: parsed.propertyType,
    source: 'meta_ads',
    adId: payload.adId,
    formId: payload.formId,
  })

  log.info({ leadId: lead.id, name: lead.name, phone: lead.phone }, 'New lead created')

  await enqueueNewLead(lead.id)
}

export async function processIncomingWhatsApp(data: {
  phone: string
  message: string
  messageId: string
  timestamp: number
  pushName?: string
  // Present when the message came from a Click-to-WhatsApp ad (CTWA).
  // sourceId = Meta ad id — persisted on the lead for attribution.
  referral?: {
    sourceId?: string
    sourceType?: string
    sourceUrl?: string
    headline?: string
    ctwaClid?: string
  }
}): Promise<void> {
  let lead = await findLeadByPhone(data.phone)

  if (!lead) {
    // If phone is a JID (@lid, @s.whatsapp.net), store it as jid and use numeric part as phone
    const isJid = data.phone.includes('@')
    const numericPhone = data.phone.replace(/@\w+\.?\w*$/, '').replace(/\D/g, '')
    const storePhone = isJid ? (numericPhone || data.phone) : data.phone
    const storeJid = isJid ? data.phone : undefined

    const isCtwa = !!data.referral?.sourceId
    log.info(
      { phone: storePhone, jid: storeJid, pushName: data.pushName, ctwa: isCtwa, adId: data.referral?.sourceId, adHeadline: data.referral?.headline },
      isCtwa ? 'New CTWA contact (ad click), creating lead' : 'New WhatsApp contact, creating lead',
    )
    const newLead = await createLead({
      name: data.pushName ?? storePhone,
      phone: storePhone,
      whatsappJid: storeJid,
      source: isCtwa ? 'ctwa' : 'whatsapp_inbound',
      adId: data.referral?.sourceId,
    })
    lead = { ...newLead, conversations: [] }
  } else if (data.referral?.sourceId && !lead.adId) {
    // Lead já existia (ex: veio de campanha CSV) e agora clicou num anúncio CTWA.
    // Preenche a atribuição que faltava sem sobrescrever o source original.
    await prisma.lead.update({
      where: { id: lead.id },
      data: { adId: data.referral.sourceId },
    })
    log.info({ leadId: lead.id, adId: data.referral.sourceId }, 'Existing lead re-engaged via CTWA ad — attribution backfilled')
  }

  // Find or create the active conversation for this lead.
  //
  // Order of preference:
  //   1. Existing conversation with activeKey = lead.id (open session)
  //   2. Recently closed conversation (ESCALATED/CLOSED/NO_RESPONSE within the last 30 days) → REOPEN it
  //   3. Create a brand-new INITIAL_CONTACT conversation
  //
  // Rationale: bug production 2026-07-03 (Robson) — Ana confirmed visit + handoff,
  // conversation flipped to ESCALATED and activeKey went null. When the lead
  // replied "Ok" the next morning, no active conversation was found → new one
  // created → Ana greeted him as a stranger ("Oi, tudo bem? Eu sou a Ana...")
  // because the fresh conversation had no history. Reopening the escalated
  // conversation keeps the history intact and Ana responds contextually.
  const REOPEN_WINDOW_DAYS = 30
  const cutoff = new Date(Date.now() - REOPEN_WINDOW_DAYS * 24 * 3600 * 1000)

  let conversation = await prisma.conversation.findUnique({
    where: { activeKey: lead.id },
    include: { messages: true },
  })

  if (!conversation) {
    const recentlyClosed = await prisma.conversation.findFirst({
      where: {
        leadId: lead.id,
        activeKey: null,
        state: { in: [ConversationState.ESCALATED, ConversationState.CLOSED, ConversationState.NO_RESPONSE] },
        updatedAt: { gte: cutoff },
      },
      orderBy: { updatedAt: 'desc' },
    })
    if (recentlyClosed) {
      conversation = await prisma.conversation.update({
        where: { id: recentlyClosed.id },
        data: { activeKey: lead.id, state: ConversationState.QUALIFYING },
        include: { messages: true },
      })
      log.info(
        { leadId: lead.id, convId: conversation.id, previousState: recentlyClosed.state },
        'Reopened previously closed conversation instead of creating a new one',
      )
    } else {
      conversation = await prisma.conversation.create({
        data: { leadId: lead.id, state: 'INITIAL_CONTACT', activeKey: lead.id },
        include: { messages: true },
      })
    }
  }

  // Update last contact + always persist the real JID we received so we reply to the right channel
  const jidUpdate = data.phone.includes('@') ? { whatsappJid: data.phone } : {}
  await prisma.lead.update({
    where: { id: lead.id },
    data: { lastContactAt: new Date(), status: LeadStatus.CONTACTED as unknown as 'NEW', ...jidUpdate },
  })

  // Enqueue for AI processing
  const { enqueueIncomingMessage } = await import('../../queues')
  await enqueueIncomingMessage({
    leadId: lead.id,
    conversationId: conversation.id,
    message: data.message,
    messageId: data.messageId,
  })
}

function parseMetaFormData(fieldData: Array<{ name: string; values: string[] }>): {
  name?: string
  phone?: string
  email?: string
  city?: string
  energyBill?: number
  propertyType?: string
} {
  const fields: Record<string, string> = {}
  for (const field of fieldData) {
    fields[field.name.toLowerCase()] = field.values[0] ?? ''
  }

  // Map common Meta form field names
  const fullNameFallback = `${fields['first_name'] ?? ''} ${fields['last_name'] ?? ''}`.trim() || undefined
  const name =
    fields['full_name'] ??
    fields['nome'] ??
    fields['nome_completo'] ??
    fullNameFallback

  const phone =
    fields['phone_number'] ??
    fields['telefone'] ??
    fields['celular'] ??
    fields['phone'] ??
    undefined

  const email = fields['email'] ?? undefined

  const city =
    fields['city'] ??
    fields['cidade'] ??
    undefined

  const energyBillRaw =
    fields['energy_bill'] ??
    fields['conta_energia'] ??
    fields['valor_conta'] ??
    fields['conta_de_luz'] ??
    ''

  const energyBill = energyBillRaw ? parseEnergyBill(energyBillRaw) : undefined

  const propertyType =
    fields['property_type'] ??
    fields['tipo_imovel'] ??
    fields['tipo_de_imovel'] ??
    undefined

  return { name, phone, email, city, energyBill, propertyType }
}

function parseEnergyBill(raw: string): number | undefined {
  const cleaned = raw.replace(/[R$\s.]/g, '').replace(',', '.')
  const value = parseFloat(cleaned)
  return isNaN(value) ? undefined : value
}
