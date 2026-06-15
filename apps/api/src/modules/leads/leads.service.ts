import { createChildLogger } from '../../logger'
import { createLead, findLeadByPhone } from './leads.repository'
import { prisma } from '../../prisma/client'
import { enqueueNewLead } from '../../queues'
import { LeadStatus } from '@sdr-solar/shared'
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
}): Promise<void> {
  let lead = await findLeadByPhone(data.phone)

  if (!lead) {
    // If phone is a JID (@lid, @s.whatsapp.net), store it as jid and use numeric part as phone
    const isJid = data.phone.includes('@')
    const numericPhone = data.phone.replace(/@\w+\.?\w*$/, '').replace(/\D/g, '')
    const storePhone = isJid ? (numericPhone || data.phone) : data.phone
    const storeJid = isJid ? data.phone : undefined

    log.info({ phone: storePhone, jid: storeJid, pushName: data.pushName }, 'New WhatsApp contact, creating lead')
    const newLead = await createLead({
      name: data.pushName ?? storePhone,
      phone: storePhone,
      whatsappJid: storeJid,
      source: 'whatsapp_inbound',
    })
    lead = { ...newLead, conversations: [] }
  }

  // Atomic upsert by activeKey eliminates race condition when two messages
  // arrive simultaneously — the DB unique constraint serializes the operation.
  const conversation = await prisma.conversation.upsert({
    where: { activeKey: lead.id },
    create: { leadId: lead.id, state: 'INITIAL_CONTACT', activeKey: lead.id },
    update: {}, // no-op if already exists
    include: { messages: true },
  })

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
