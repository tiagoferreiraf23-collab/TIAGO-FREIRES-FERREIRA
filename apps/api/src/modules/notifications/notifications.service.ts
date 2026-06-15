import axios from 'axios'
import { env } from '../../config'
import { createChildLogger } from '../../logger'
import { sendTextMessage } from '../whatsapp/whatsapp.service'

const log = createChildLogger('notifications')

interface EscalationPayload {
  type: 'escalation'
  leadName: string
  leadPhone: string
  reason: string
  priority: 'low' | 'medium' | 'high' | 'urgent'
}

interface ScheduledVisitPayload {
  type: 'scheduled'
  leadName: string
  leadPhone: string
  consultantName: string
  dateTime: Date
  city?: string
}

type NotificationPayload = EscalationPayload | ScheduledVisitPayload

export async function notifyTeam(payload: NotificationPayload): Promise<void> {
  await Promise.allSettled([
    sendSlackNotification(payload),
    sendWhatsAppGroupNotification(payload),
  ])
}

async function sendSlackNotification(payload: NotificationPayload): Promise<void> {
  if (!env.notifications.slackWebhookUrl) return

  let message: string
  let color: string

  if (payload.type === 'escalation') {
    const priorityEmoji = { low: '🟡', medium: '🟠', high: '🔴', urgent: '🚨' }[payload.priority]
    message = `${priorityEmoji} *Escalada para humano*\n*Lead:* ${payload.leadName}\n*Telefone:* ${payload.leadPhone}\n*Motivo:* ${payload.reason}`
    color = payload.priority === 'urgent' ? '#FF0000' : '#FF8C00'
  } else {
    message = `✅ *Visita Agendada*\n*Lead:* ${payload.leadName}\n*Telefone:* ${payload.leadPhone}\n*Consultor:* ${payload.consultantName}\n*Data/Hora:* ${payload.dateTime.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}\n*Cidade:* ${payload.city ?? 'N/A'}`
    color = '#36A64F'
  }

  try {
    await axios.post(env.notifications.slackWebhookUrl, {
      attachments: [{ color, text: message, mrkdwn_in: ['text'] }],
    })
    log.debug('Slack notification sent')
  } catch (err) {
    log.warn({ err }, 'Failed to send Slack notification')
  }
}

async function sendWhatsAppGroupNotification(payload: NotificationPayload): Promise<void> {
  if (!env.notifications.teamWhatsappGroupId) return

  let message: string

  if (payload.type === 'escalation') {
    message = `⚠️ *LEAD PRECISA DE ATENÇÃO*\n\n👤 *Lead:* ${payload.leadName}\n📱 *Telefone:* ${payload.leadPhone}\n💬 *Motivo:* ${payload.reason}\n\nResponda ao lead diretamente no WhatsApp.`
  } else {
    message = `🎉 *VISITA AGENDADA*\n\n👤 *Lead:* ${payload.leadName}\n📱 *Telefone:* ${payload.leadPhone}\n👷 *Consultor:* ${payload.consultantName}\n📅 *Data/Hora:* ${payload.dateTime.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}\n📍 *Cidade:* ${payload.city ?? 'N/A'}`
  }

  await sendTextMessage(env.notifications.teamWhatsappGroupId, message)
}

export async function sendVisitReminder(
  phone: string,
  leadName: string,
  consultantName: string,
  dateTime: Date,
  hoursUntil: number,
): Promise<void> {
  const dateFormatted = dateTime.toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })

  const timeLabel = hoursUntil >= 20 ? 'amanhã' : 'daqui a 2 horas'

  const message = `Olá, ${leadName.split(' ')[0]}! 👋\n\nLembrando que você tem uma visita técnica *${timeLabel}* com o consultor ${consultantName}.\n\n📅 *${dateFormatted}*\n\nSe precisar reagendar, é só me avisar aqui! 😊`

  await sendTextMessage(phone, message)
  log.info({ phone, hoursUntil }, 'Visit reminder sent')
}
