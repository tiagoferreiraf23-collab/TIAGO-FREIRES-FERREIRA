import type Anthropic from '@anthropic-ai/sdk'
import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc'
import timezone from 'dayjs/plugin/timezone'
import { prisma } from '../../prisma/client'
import { createChildLogger } from '../../logger'
import { LeadStatus, ConversationState } from '@sdr-solar/shared'
import { checkCalendar, scheduleVisit } from '../../modules/scheduling/scheduling.service'
import { notifyTeam } from '../../modules/notifications/notifications.service'

dayjs.extend(utc)
dayjs.extend(timezone)

const log = createChildLogger('ai:tools')

/**
 * Parse a datetime string as Fortaleza local time (BRT, UTC-3).
 *
 * Ana frequently sends times like "2026-06-18T14:00:00" without a timezone.
 * On Railway (UTC server) `new Date()` would treat that as 14:00 UTC,
 * which displays as 11:00 BRT — exactly the 3h drift bug seen in prod.
 *
 * If the string already has Z or an offset, we trust it. Otherwise we
 * force-interpret as America/Sao_Paulo and convert to a UTC Date.
 */
function parseAsBRT(input: string): Date {
  const hasTz = input.endsWith('Z') || /[+-]\d{2}:?\d{2}$/.test(input)
  if (hasTz) return new Date(input)
  return dayjs.tz(input, 'America/Sao_Paulo').toDate()
}

export const SDR_TOOLS: Anthropic.Tool[] = [
  {
    name: 'check_calendar',
    description:
      'Verifica horários disponíveis dos consultores para uma determinada cidade e período preferido do lead.',
    input_schema: {
      type: 'object' as const,
      properties: {
        city: {
          type: 'string',
          description: 'Cidade onde o lead mora (ex: "São Paulo", "Campinas")',
        },
        preferredPeriod: {
          type: 'string',
          enum: ['manha', 'tarde', 'noite', 'qualquer'],
          description: 'Período preferido do lead para a visita. Use "noite" SOMENTE quando o lead disser explicitamente que só pode após o expediente (horário noturno 19h).',
        },
      },
      required: ['city'],
    },
  },
  {
    name: 'schedule_visit',
    description: 'Agenda a visita técnica após o lead confirmar data e horário.',
    input_schema: {
      type: 'object' as const,
      properties: {
        leadId: {
          type: 'string',
          description: 'ID do lead no sistema',
        },
        consultantId: {
          type: 'string',
          description: 'ID do consultor que fará a visita',
        },
        dateTime: {
          type: 'string',
          description: 'Data e hora da visita no formato ISO 8601 (ex: 2024-06-15T10:00:00)',
        },
      },
      required: ['leadId', 'consultantId', 'dateTime'],
    },
  },
  {
    name: 'update_crm',
    description:
      'Atualiza o status e informações do lead no CRM a partir dos dados coletados na conversa.',
    input_schema: {
      type: 'object' as const,
      properties: {
        leadId: {
          type: 'string',
          description: 'ID do lead',
        },
        stage: {
          type: 'string',
          enum: Object.values(LeadStatus),
          description: 'Novo estágio do lead no pipeline',
        },
        notes: {
          type: 'string',
          description: 'Notas sobre a conversa para o CRM',
        },
        extractedData: {
          type: 'object',
          description: 'Dados extraídos da conversa (nome, cidade, tipo de imóvel, etc.)',
          properties: {
            name: { type: 'string', description: 'Nome ou apelido que o lead pediu para ser chamado. Salve SEMPRE que aprender, mesmo que só o primeiro nome.' },
            city: { type: 'string' },
            neighborhood: { type: 'string' },
            propertyType: { type: 'string', enum: ['casa', 'apartamento', 'comercial', 'sitio_fazenda'] },
            ownProperty: { type: 'boolean' },
            energyBill: { type: 'number' },
            preferredPeriod: { type: 'string' },
          },
        },
      },
      required: ['leadId', 'stage'],
    },
  },
  {
    name: 'escalate_to_human',
    description:
      'Escala o atendimento para um consultor humano quando necessário (lead muito quente, objeção complexa, raiva, pedido explícito).',
    input_schema: {
      type: 'object' as const,
      properties: {
        leadId: {
          type: 'string',
          description: 'ID do lead',
        },
        reason: {
          type: 'string',
          description: 'Motivo da escalada para o consultor humano',
        },
        priority: {
          type: 'string',
          enum: ['low', 'medium', 'high', 'urgent'],
          description: 'Prioridade do atendimento',
        },
      },
      required: ['leadId', 'reason'],
    },
  },
  {
    name: 'schedule_callback',
    description:
      'Agenda você (Ana) para retomar AUTOMATICAMENTE a conversa com o lead após X minutos. Use SEMPRE que o lead pedir pra você falar com ele depois (ex: "me chama daqui 2 min", "fala comigo em meia hora", "volta amanhã às 10"). NUNCA prometa retorno sem chamar este tool — ele garante que o sistema realmente vai voltar a falar.',
    input_schema: {
      type: 'object' as const,
      properties: {
        leadId: {
          type: 'string',
          description: 'ID do lead no sistema (vem do CONTEXTO)',
        },
        delayMinutes: {
          type: 'integer',
          description: 'Em quantos minutos retomar a conversa. Mínimo 1, máximo 1440 (24h). Para "2 minutos" passe 2. Para "1 hora" passe 60.',
          minimum: 1,
          maximum: 1440,
        },
        reason: {
          type: 'string',
          description: 'Motivo da pausa (curto). Ex: "lead pediu pra eu falar em 2 min", "lead em reunião agora".',
        },
      },
      required: ['leadId', 'delayMinutes', 'reason'],
    },
  },
  {
    name: 'send_media',
    description: 'Envia um vídeo ou imagem explicativo sobre energia solar para o lead.',
    input_schema: {
      type: 'object' as const,
      properties: {
        type: {
          type: 'string',
          enum: ['image', 'video', 'document'],
          description: 'Tipo de mídia',
        },
        mediaKey: {
          type: 'string',
          enum: ['como_funciona', 'economia_media', 'processo_instalacao', 'depoimentos'],
          description: 'Identificador do material a ser enviado',
        },
        caption: {
          type: 'string',
          description: 'Legenda para acompanhar a mídia',
        },
      },
      required: ['type', 'mediaKey'],
    },
  },
]

export type ToolInput = {
  check_calendar: { city: string; preferredPeriod?: 'manha' | 'tarde' | 'noite' | 'qualquer' }
  schedule_visit: { leadId: string; consultantId: string; dateTime: string }
  update_crm: {
    leadId: string
    stage: string
    notes?: string
    extractedData?: {
      name?: string
      city?: string
      neighborhood?: string
      propertyType?: string
      ownProperty?: boolean
      energyBill?: number
      preferredPeriod?: string
    }
  }
  escalate_to_human: { leadId: string; reason: string; priority?: string }
  send_media: { type: string; mediaKey: string; caption?: string }
  schedule_callback: { leadId: string; delayMinutes: number; reason: string }
}

export async function executeToolCall(
  toolName: string,
  toolInput: unknown,
): Promise<string> {
  log.info({ toolName, toolInput }, 'Executing tool call')

  try {
    switch (toolName) {
      case 'check_calendar': {
        const input = toolInput as ToolInput['check_calendar']
        const slots = await checkCalendar(input.city, input.preferredPeriod)
        if (slots.length === 0) {
          return JSON.stringify({ available: false, message: 'Sem horários disponíveis nos próximos 3 dias úteis' })
        }
        return JSON.stringify({
          available: true,
          slots: slots.slice(0, 3).map((s) => ({
            consultantId: s.consultantId,
            consultantName: s.consultantName,
            dateTime: s.startTime.toISOString(),
            formatted: formatSlotForDisplay(s.startTime),
          })),
        })
      }

      case 'schedule_visit': {
        const input = toolInput as ToolInput['schedule_visit']
        const result = await scheduleVisit(
          input.leadId,
          parseAsBRT(input.dateTime),
          input.consultantId,
        )
        return JSON.stringify(result)
      }

      case 'update_crm': {
        const input = toolInput as ToolInput['update_crm']
        const updateData: Record<string, unknown> = {
          status: input.stage as LeadStatus,
        }

        if (input.extractedData) {
          if (input.extractedData.name && input.extractedData.name.trim()) {
            updateData.name = input.extractedData.name.trim()
          }
          if (input.extractedData.city) updateData.city = input.extractedData.city
          if (input.extractedData.neighborhood) updateData.neighborhood = input.extractedData.neighborhood
          if (input.extractedData.propertyType) updateData.propertyType = input.extractedData.propertyType
          if (input.extractedData.ownProperty !== undefined) updateData.ownProperty = input.extractedData.ownProperty
          if (input.extractedData.energyBill) updateData.energyBill = input.extractedData.energyBill
        }

        await prisma.lead.update({ where: { id: input.leadId }, data: updateData })
        log.info({ leadId: input.leadId, stage: input.stage }, 'CRM updated via tool')
        return JSON.stringify({ success: true, message: 'CRM atualizado com sucesso' })
      }

      case 'escalate_to_human': {
        const input = toolInput as ToolInput['escalate_to_human']
        const lead = await prisma.lead.findUnique({
          where: { id: input.leadId },
          include: { conversations: { include: { messages: { take: 5, orderBy: { sentAt: 'desc' } } } } },
        })
        if (!lead) return JSON.stringify({ success: false, error: 'Lead not found' })

        await Promise.all([
          prisma.lead.update({
            where: { id: input.leadId },
            data: { status: LeadStatus.ESCALATED as unknown as 'CONTACTED' },
          }),
          prisma.conversation.updateMany({
            where: { leadId: input.leadId, state: { not: ConversationState.CLOSED as unknown as 'CONFIRMED' } },
            // Clear activeKey on terminal escalation so future contact can open a new conversation
            data: { state: ConversationState.ESCALATED as unknown as 'CONFIRMED', activeKey: null },
          }),
          notifyTeam({
            type: 'escalation',
            leadName: lead.name,
            leadPhone: lead.phone,
            reason: input.reason,
            priority: (input.priority ?? 'medium') as 'low' | 'medium' | 'high' | 'urgent',
          }),
        ])

        return JSON.stringify({ success: true, message: 'Escalado para consultor humano. Equipe notificada.' })
      }

      case 'schedule_callback': {
        const input = toolInput as ToolInput['schedule_callback']
        // Resolve the active conversation for the lead
        const conversation = await prisma.conversation.findFirst({
          where: { leadId: input.leadId, activeKey: input.leadId },
          orderBy: { createdAt: 'desc' },
        })
        if (!conversation) {
          return JSON.stringify({ success: false, error: 'no_active_conversation' })
        }
        const { enqueueScheduledCallback } = await import('../../queues')
        await enqueueScheduledCallback({
          leadId: input.leadId,
          conversationId: conversation.id,
          delayMinutes: input.delayMinutes,
          reason: input.reason,
        })
        return JSON.stringify({
          success: true,
          message: `Retomada agendada em ${input.delayMinutes} min`,
        })
      }

      case 'send_media': {
        const input = toolInput as ToolInput['send_media']
        // TODO: replace these placeholder URLs with real Ecolare media URLs (S3, R2, Drive, etc.).
        // Until the URLs are real, the send is gated below so we don't dispatch broken media.
        const mediaMap: Record<string, { url: string; type: string }> = {
          como_funciona: { url: 'https://seusite.com/media/como-funciona.mp4', type: 'video' },
          economia_media: { url: 'https://seusite.com/media/economia.jpg', type: 'image' },
          processo_instalacao: { url: 'https://seusite.com/media/instalacao.jpg', type: 'image' },
          depoimentos: { url: 'https://seusite.com/media/depoimentos.mp4', type: 'video' },
        }
        const media = mediaMap[input.mediaKey]
        if (!media) return JSON.stringify({ success: false, error: 'Media not found' })
        // Safety gate: refuse to dispatch placeholder URLs (avoid broken media on the lead's WhatsApp)
        if (media.url.includes('seusite.com')) {
          log.warn({ mediaKey: input.mediaKey }, 'send_media skipped — placeholder URL not yet replaced')
          return JSON.stringify({ success: false, error: 'media_not_configured', message: 'Material ainda não disponível.' })
        }
        return JSON.stringify({ success: true, mediaUrl: media.url, mediaType: media.type, caption: input.caption })
      }

      default:
        return JSON.stringify({ error: `Unknown tool: ${toolName}` })
    }
  } catch (err) {
    log.error({ toolName, err }, 'Tool execution failed')
    return JSON.stringify({ error: 'Tool execution failed', details: String(err) })
  }
}

function formatSlotForDisplay(date: Date): string {
  const days = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado']
  const day = days[date.getDay()]
  const dateStr = date.toLocaleDateString('pt-BR')
  const hours = date.getHours()
  const period = hours < 12 ? 'manhã' : 'tarde'
  return `${day}, ${dateStr} às ${date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })} (${period})`
}
