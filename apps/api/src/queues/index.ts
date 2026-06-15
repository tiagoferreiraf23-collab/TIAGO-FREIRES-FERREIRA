import { Queue, Worker } from 'bullmq'
import IORedis from 'ioredis'
import { env } from '../config'
import { createChildLogger } from '../logger'
import { QUEUE_NAMES, JOB_NAMES, FOLLOW_UP_DELAYS } from '@sdr-solar/shared'

const log = createChildLogger('queues')

// BullMQ bundles its own ioredis which conflicts at the type level with the root ioredis.
// Solution: pass raw connection options (not an IORedis instance) to BullMQ, and keep
// a separate IORedis instance only for connection event monitoring.
function parseRedisUrl(url: string): { host: string; port: number; password?: string } {
  try {
    const u = new URL(url)
    return {
      host: u.hostname || 'localhost',
      port: parseInt(u.port || '6379'),
      password: u.password || undefined,
    }
  } catch {
    return { host: 'localhost', port: 6379 }
  }
}

const redisBaseOpts = parseRedisUrl(env.redis.url)
// Options object passed directly to BullMQ — avoids ioredis instance type conflict
const connection = { ...redisBaseOpts, maxRetriesPerRequest: null, enableReadyCheck: false }

// Separate ioredis instance only for connection lifecycle events
const monitorRedis = new IORedis(env.redis.url, { maxRetriesPerRequest: null, enableReadyCheck: false })
monitorRedis.on('connect', () => log.info('Redis connected'))
monitorRedis.on('error', (err) => log.error({ err }, 'Redis error'))

// ─── Queues ───────────────────────────────────────────────────────────────────

export const leadQueue = new Queue(QUEUE_NAMES.LEAD_PROCESSOR, { connection })
export const conversationQueue = new Queue(QUEUE_NAMES.CONVERSATION, { connection })
export const followUpQueue = new Queue(QUEUE_NAMES.FOLLOW_UP, { connection })
export const notificationQueue = new Queue(QUEUE_NAMES.NOTIFICATION, { connection })
export const scheduledCallbackQueue = new Queue(QUEUE_NAMES.SCHEDULED_CALLBACK, { connection })

// ─── Business hours helper ──────────────────────────────────────────────────
// Ana só manda mensagens proativas (contato inicial, follow-up, callback) dentro
// do horário comercial. Mensagens reativas (resposta a lead que falou agora)
// não passam por aqui — vão direto.

/**
 * Devolve um delay (em ms) que faz o job disparar dentro do horário comercial.
 * Se o "agora" já está dentro do horário, devolve 0 (sem delay extra).
 * Se está fora, ajusta pro próximo dia útil às BUSINESS_HOURS_START.
 *
 * Considera fuso de Fortaleza (UTC-3, sem horário de verão).
 */
export function clampToBusinessHours(baseDelayMs: number): number {
  const start = env.business.hoursStart
  const end = env.business.hoursEnd
  const targetUtc = new Date(Date.now() + baseDelayMs)
  // Converte UTC -> Fortaleza (BRT, UTC-3)
  const fortHour = (targetUtc.getUTCHours() - 3 + 24) % 24
  const inWindow = fortHour >= start && fortHour < end
  if (inWindow) return baseDelayMs
  // Fora da janela — empurra pro próximo horário válido (START local)
  const target = new Date(targetUtc)
  if (fortHour >= end) {
    // Passou do fim — amanhã às START
    target.setUTCDate(target.getUTCDate() + 1)
  }
  // BRT (UTC-3): para mandar às START local, em UTC é START + 3
  target.setUTCHours(start + 3, 0, 0, 0)
  return Math.max(0, target.getTime() - Date.now())
}

// ─── Enqueue helpers ─────────────────────────────────────────────────────────

export async function enqueueNewLead(leadId: string): Promise<void> {
  // Respeita horário comercial — se o lead chegar de madrugada, Ana só fala 7h
  const delay = clampToBusinessHours(env.business.firstContactDelayMs)
  await leadQueue.add(
    JOB_NAMES.SEND_INITIAL_MESSAGE,
    { leadId },
    {
      delay,
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 50 },
    },
  )
  log.info({ leadId, delayMs: delay }, 'Initial contact job queued (business-hours-aware)')
}

export async function enqueueIncomingMessage(data: {
  leadId: string
  conversationId: string
  message: string
  messageId: string
}): Promise<void> {
  await conversationQueue.add(JOB_NAMES.PROCESS_INCOMING_MESSAGE, data, {
    attempts: 3,
    backoff: { type: 'fixed', delay: 2000 },
    removeOnComplete: { count: 200 },
    removeOnFail: { count: 100 },
  })
}

export type FollowUpAttempt = 1 | 2 | 3 | 4 | 5

/** Compute the delay (in ms) for a given follow-up attempt.
 *  Step 4 targets the next day at 7 AM regardless of current time. */
function delayForAttempt(attempt: FollowUpAttempt): number {
  if (attempt === 1) return FOLLOW_UP_DELAYS.STEP_1
  if (attempt === 2) return FOLLOW_UP_DELAYS.STEP_2
  if (attempt === 3) return FOLLOW_UP_DELAYS.STEP_3
  if (attempt === 4) {
    const now = new Date()
    const next7am = new Date(now)
    next7am.setDate(now.getDate() + 1)
    next7am.setHours(FOLLOW_UP_DELAYS.STEP_4_HOUR, 0, 0, 0)
    return Math.max(60_000, next7am.getTime() - now.getTime())  // never less than 1 min
  }
  return FOLLOW_UP_DELAYS.STEP_5
}

const FOLLOW_UP_JOB_NAMES: Record<FollowUpAttempt, string> = {
  1: JOB_NAMES.FOLLOW_UP_1,
  2: JOB_NAMES.FOLLOW_UP_2,
  3: JOB_NAMES.FOLLOW_UP_3,
  4: JOB_NAMES.FOLLOW_UP_4,
  5: JOB_NAMES.FOLLOW_UP_5,
}

/**
 * Schedule a follow-up. `triggeringMessageAt` is the timestamp of the Ana
 * message that started the silence — the worker will skip the job if the
 * lead has sent any message after that timestamp.
 */
export async function enqueueFollowUp(
  leadId: string,
  attempt: FollowUpAttempt,
  triggeringMessageAt: Date,
): Promise<void> {
  // Follow-up só dispara em horário comercial
  const delay = clampToBusinessHours(delayForAttempt(attempt))
  await followUpQueue.add(
    FOLLOW_UP_JOB_NAMES[attempt],
    { leadId, attempt, triggeringMessageAt: triggeringMessageAt.toISOString() },
    {
      delay,
      attempts: 2,
      backoff: { type: 'fixed', delay: 10000 },
      // Unique per call so a fresh Ana message resets the timer with a new job
      jobId: `follow-up-${leadId}-${attempt}-${triggeringMessageAt.getTime()}`,
      removeOnComplete: { count: 200 },
      removeOnFail: { count: 100 },
    },
  )
  log.info({ leadId, attempt, delayMs: delay }, 'Follow-up job scheduled')
}

export async function enqueueReminder(
  data: { phone: string; name: string; consultantName: string; visitDate: Date; hoursUntil: number },
  runAt: Date,
): Promise<void> {
  const delay = Math.max(0, runAt.getTime() - Date.now())
  await notificationQueue.add(JOB_NAMES.SEND_VISIT_REMINDER, data, {
    delay,
    attempts: 3,
    backoff: { type: 'fixed', delay: 5000 },
    removeOnComplete: { count: 100 },
  })
}

export async function enqueueScheduledCallback(data: {
  leadId: string
  conversationId: string
  delayMinutes: number
  reason: string
}): Promise<void> {
  // Clamp delay between 1 minute and 24h to avoid abuse
  const minutes = Math.min(Math.max(data.delayMinutes, 1), 24 * 60)
  // Respeitar horário comercial — se o callback cairia de madrugada, joga pra manhã
  const delay = clampToBusinessHours(minutes * 60 * 1000)
  await scheduledCallbackQueue.add(
    JOB_NAMES.PROCESS_SCHEDULED_CALLBACK,
    data,
    {
      delay,
      attempts: 2,
      backoff: { type: 'fixed', delay: 10000 },
      // Tag per conversation+timestamp so multiple callbacks can stack
      jobId: `callback-${data.conversationId}-${Date.now()}`,
      removeOnComplete: { count: 200 },
      removeOnFail: { count: 100 },
    },
  )
  log.info({ leadId: data.leadId, delayMinutes: minutes, reason: data.reason }, 'Scheduled callback queued')
}

// ─── Workers ─────────────────────────────────────────────────────────────────

export function startWorkers(): void {
  startLeadWorker()
  startConversationWorker()
  startFollowUpWorker()
  startNotificationWorker()
  startScheduledCallbackWorker()
  log.info('All queue workers started')
}

function startScheduledCallbackWorker(): void {
  const worker = new Worker(
    QUEUE_NAMES.SCHEDULED_CALLBACK,
    async (job) => {
      log.info({ jobId: job.id, data: job.data }, 'Processing scheduled callback')
      const { processScheduledCallback } = await import('./callback.worker')
      await processScheduledCallback(
        job.data as { leadId: string; conversationId: string; delayMinutes: number; reason: string },
      )
    },
    { connection, concurrency: 5 },
  )

  worker.on('completed', (job) => log.debug({ jobId: job.id }, 'Callback job completed'))
  worker.on('failed', (job, err) => log.error({ jobId: job?.id, err }, 'Callback job failed'))
}

function startLeadWorker(): void {
  const worker = new Worker(
    QUEUE_NAMES.LEAD_PROCESSOR,
    async (job) => {
      log.info({ jobId: job.id, jobName: job.name, data: job.data }, 'Processing lead job')
      const { processNewLead } = await import('./lead.worker')
      await processNewLead(job.data as { leadId: string })
    },
    { connection, concurrency: 5 },
  )

  worker.on('completed', (job) => log.debug({ jobId: job.id }, 'Lead job completed'))
  worker.on('failed', (job, err) => log.error({ jobId: job?.id, err }, 'Lead job failed'))
}

function startConversationWorker(): void {
  const worker = new Worker(
    QUEUE_NAMES.CONVERSATION,
    async (job) => {
      log.info({ jobId: job.id, data: job.data }, 'Processing conversation job')
      const { handleIncomingMessage } = await import('../modules/conversations/conversations.service')
      await handleIncomingMessage(
        job.data as { leadId: string; conversationId: string; message: string; messageId: string },
      )
    },
    { connection, concurrency: 10 },
  )

  worker.on('completed', (job) => log.debug({ jobId: job.id }, 'Conversation job completed'))
  worker.on('failed', (job, err) => log.error({ jobId: job?.id, err }, 'Conversation job failed'))
}

function startFollowUpWorker(): void {
  const worker = new Worker(
    QUEUE_NAMES.FOLLOW_UP,
    async (job) => {
      log.info({ jobId: job.id, data: job.data }, 'Processing follow-up job')
      const { processFollowUp } = await import('./follow-up.worker')
      await processFollowUp(
        job.data as { leadId: string; attempt: number; triggeringMessageAt: string },
      )
    },
    { connection, concurrency: 5 },
  )

  worker.on('completed', (job) => log.debug({ jobId: job.id }, 'Follow-up job completed'))
  worker.on('failed', (job, err) => log.error({ jobId: job?.id, err }, 'Follow-up job failed'))
}

function startNotificationWorker(): void {
  const worker = new Worker(
    QUEUE_NAMES.NOTIFICATION,
    async (job) => {
      if (job.name === JOB_NAMES.SEND_VISIT_REMINDER) {
        const { sendVisitReminder } = await import('../modules/notifications/notifications.service')
        const data = job.data as { phone: string; name: string; consultantName: string; visitDate: Date; hoursUntil: number }
        await sendVisitReminder(data.phone, data.name, data.consultantName, new Date(data.visitDate), data.hoursUntil)
      }
    },
    { connection, concurrency: 5 },
  )

  worker.on('failed', (job, err) => log.error({ jobId: job?.id, err }, 'Notification job failed'))
}

export { monitorRedis as redisConnection }
