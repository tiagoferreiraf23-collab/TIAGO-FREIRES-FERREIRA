import { prisma } from '../prisma/client'
import { createChildLogger } from '../logger'
import { sendTemplateMessage } from '../modules/whatsapp/whatsapp.service'
import { enqueueFollowUp } from './index'
import { LeadStatus, ConversationState } from '@sdr-solar/shared'

const log = createChildLogger('lead-worker')

// Primeiro contato de lead que veio do formulário Meta é business-initiated:
// a Meta EXIGE template aprovado (texto livre fora da janela de 24h = erro
// 131047, falha silenciosa — bug que manteve o fluxo automático morto até
// 2026-07-31 e forçava campanhas manuais via CSV).
const INITIAL_TEMPLATE_NAME = 'reativacao_leads_jun_2026'
const INITIAL_TEMPLATE_LANG = 'pt_BR'

// Corpo EXATO aprovado no Meta (editado 2026-07-31: removido "este mês" pra
// ficar atemporal) — persistido no histórico pra Ana ler o que o lead
// realmente recebeu (regra anti-bug-Eliane).
function renderInitialTemplate(firstName: string): string {
  return `Oi, ${firstName}! Aqui é a Ana, consultora da Ecolare Energia Solar 🌞\n\nVocê preencheu nosso formulário sobre energia solar. Posso fazer uma análise rápida e te mostrar quanto você economizaria por mês. Pode ser?`
}

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

  log.info({ leadId: lead.id, name: lead.name }, 'Sending initial contact template')

  // {{1}} do template. Nome placeholder (sem nome real do form) vira "tudo bem"
  // — renderiza "Oi, tudo bem! 👋 ..." que funciona gramaticalmente.
  const rawFirst = lead.name.split(/\s+/)[0] ?? lead.name
  const isPlaceholder = /^(lead|cliente|contato|usuario|usuário)$/i.test(rawFirst) || /^\d+$/.test(rawFirst)
  const firstName = isPlaceholder ? 'tudo bem' : rawFirst

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

  // Template exige o telefone numérico (Cloud API não aceita JID)
  const messageId = await sendTemplateMessage(
    lead.phone,
    INITIAL_TEMPLATE_NAME,
    INITIAL_TEMPLATE_LANG,
    [firstName],
  )

  // null = envio falhou (token, template pausado, número inválido...).
  // Lança pra BullMQ re-tentar; lead permanece NEW até conseguir.
  if (!messageId) {
    throw new Error(`Initial template send failed for lead ${lead.id} (${lead.phone})`)
  }

  // Save message to DB — exact rendered body, com metadata de template
  await prisma.message.create({
    data: {
      conversationId: conversation.id,
      role: 'assistant',
      content: renderInitialTemplate(firstName),
      whatsappId: messageId,
      sentAt: new Date(),
      metadata: {
        type: 'template',
        templateName: INITIAL_TEMPLATE_NAME,
        templateLang: INITIAL_TEMPLATE_LANG,
        autoInitialContact: true,
      },
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
