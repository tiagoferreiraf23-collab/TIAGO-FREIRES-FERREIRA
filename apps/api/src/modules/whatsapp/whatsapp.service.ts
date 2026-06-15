import axios, { AxiosError, AxiosInstance } from 'axios'
import { env } from '../../config'
import { createChildLogger } from '../../logger'

const log = createChildLogger('whatsapp')

// ─── HTTP clients (one per backend) ──────────────────────────────────────────

const evolutionApi: AxiosInstance = axios.create({
  baseURL: env.evolution.apiUrl,
  headers: { apikey: env.evolution.apiKey, 'Content-Type': 'application/json' },
  timeout: 15000,
})

const wahaApi: AxiosInstance = axios.create({
  baseURL: env.waha.apiUrl,
  headers: {
    'Content-Type': 'application/json',
    ...(env.waha.apiKey ? { 'X-Api-Key': env.waha.apiKey } : {}),
  },
  timeout: 30000,
})

const metaCloudApi: AxiosInstance = axios.create({
  baseURL: `https://graph.facebook.com/${env.meta.graphApiVersion}`,
  headers: {
    'Content-Type': 'application/json',
    ...(env.meta.cloudAccessToken ? { Authorization: `Bearer ${env.meta.cloudAccessToken}` } : {}),
  },
  timeout: 15000,
})

// ─── Meta Cloud media download ──────────────────────────────────────────────
// Cloud API delivers media via 2-step: GET /{media_id} → URL, then GET URL → bytes.
// Both calls need the same bearer token.

export async function downloadMetaMedia(
  mediaId: string,
): Promise<{ data: Buffer; mimeType: string } | null> {
  if (!env.meta.cloudAccessToken) return null
  try {
    const meta = await metaCloudApi.get<{ url?: string; mime_type?: string }>(`/${mediaId}`)
    const url = meta.data.url
    const mimeType = meta.data.mime_type ?? 'application/octet-stream'
    if (!url) {
      log.warn({ mediaId }, 'Meta media metadata returned no URL')
      return null
    }
    const bin = await axios.get(url, {
      responseType: 'arraybuffer',
      headers: { Authorization: `Bearer ${env.meta.cloudAccessToken}` },
      timeout: 30000,
    })
    return { data: Buffer.from(bin.data as ArrayBuffer), mimeType }
  } catch (err) {
    log.error({ err, mediaId }, 'Failed to download Meta media')
    return null
  }
}

// ─── Retry helper ────────────────────────────────────────────────────────────

function isRetryable(err: unknown): boolean {
  if (err instanceof AxiosError) {
    const status = err.response?.status
    if (!status) return true
    if (status >= 500) return true
  }
  return false
}

async function withRetry<T>(
  fn: () => Promise<T>,
  { attempts = 3, baseDelayMs = 2000, label = 'operation' }: { attempts?: number; baseDelayMs?: number; label?: string } = {},
): Promise<T> {
  let lastErr: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (attempt < attempts && isRetryable(err)) {
        const delay = baseDelayMs * attempt
        log.warn({ attempt, attempts, delay, label }, 'Transient failure — retrying')
        await new Promise((r) => setTimeout(r, delay))
        continue
      }
      throw err
    }
  }
  throw lastErr
}

// ─── Phone formatting helpers ────────────────────────────────────────────────

function formatPhone(phone: string): string {
  if (phone.includes('@')) return phone
  const cleaned = phone.replace(/\D/g, '')
  if (cleaned.startsWith('55') && cleaned.length >= 12) return cleaned
  if (cleaned.length === 11 || cleaned.length === 10) return `55${cleaned}`
  return cleaned
}

// WAHA chatId format: "5511999999999@c.us"
function toWahaChatId(phone: string): string {
  if (phone.includes('@')) {
    // Normalize @s.whatsapp.net / @lid to @c.us
    return phone.replace(/@s\.whatsapp\.net$/, '@c.us').replace(/@lid$/, '@c.us')
  }
  return `${formatPhone(phone)}@c.us`
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

// ─── Public API — dispatches to the configured provider ──────────────────────

export async function sendTextMessage(phone: string, text: string): Promise<string | null> {
  if (env.whatsapp.provider === 'meta') return sendTextMeta(phone, text)
  if (env.whatsapp.provider === 'waha') return sendTextWAHA(phone, text)
  return sendTextEvolution(phone, text)
}

export async function sendMediaMessage(
  phone: string,
  mediaUrl: string,
  mediaType: 'image' | 'video' | 'document',
  caption?: string,
): Promise<string | null> {
  if (env.whatsapp.provider === 'meta') return sendMediaMeta(phone, mediaUrl, mediaType, caption)
  if (env.whatsapp.provider === 'waha') return sendMediaWAHA(phone, mediaUrl, mediaType, caption)
  return sendMediaEvolution(phone, mediaUrl, mediaType, caption)
}

export async function getInstanceStatus(): Promise<string> {
  if (env.whatsapp.provider === 'meta') return getStatusMeta()
  if (env.whatsapp.provider === 'waha') return getStatusWAHA()
  return getStatusEvolution()
}

export async function reconnectInstance(): Promise<void> {
  if (env.whatsapp.provider === 'meta') {
    log.info('Meta Cloud API has no session concept — nothing to reconnect')
    return
  }
  if (env.whatsapp.provider === 'waha') return reconnectWAHA()
  return reconnectEvolution()
}

// ─── Evolution implementation ────────────────────────────────────────────────

async function sendTextEvolution(phone: string, text: string): Promise<string | null> {
  try {
    const formattedPhone = formatPhone(phone)
    const response = await withRetry(
      () =>
        evolutionApi.post(`/message/sendText/${env.evolution.instanceName}`, {
          number: formattedPhone,
          text,
          delay: 1200,
        }),
      { label: `evo:sendText:${formattedPhone}` },
    )
    const data = response.data as { key?: { id?: string }; exists?: boolean }
    if (data.exists === false) {
      log.warn({ phone: formattedPhone }, 'Evolution returned exists:false')
      return null
    }
    const messageId = data?.key?.id ?? null
    log.info({ phone: formattedPhone, messageId, provider: 'evolution' }, 'Text message sent')
    return messageId
  } catch (err) {
    log.error({ phone, err }, 'Evolution: failed to send text')
    return null
  }
}

async function sendMediaEvolution(
  phone: string,
  mediaUrl: string,
  mediaType: 'image' | 'video' | 'document',
  caption?: string,
): Promise<string | null> {
  try {
    const formattedPhone = formatPhone(phone)
    const endpoint = `/message/send${capitalize(mediaType)}/${env.evolution.instanceName}`
    const payload =
      mediaType === 'document'
        ? { number: formattedPhone, document: mediaUrl, fileName: 'material-solar.pdf', caption }
        : { number: formattedPhone, [mediaType]: mediaUrl, caption }
    const response = await withRetry(
      () => evolutionApi.post(endpoint, payload),
      { label: `evo:sendMedia:${mediaType}:${formattedPhone}` },
    )
    const messageId = (response.data as { key?: { id?: string } })?.key?.id ?? null
    log.info({ phone: formattedPhone, mediaType, messageId, provider: 'evolution' }, 'Media message sent')
    return messageId
  } catch (err) {
    log.error({ phone, mediaType, err }, 'Evolution: failed to send media')
    return null
  }
}

async function getStatusEvolution(): Promise<string> {
  try {
    const response = await evolutionApi.get(
      `/instance/fetchInstances?instanceName=${env.evolution.instanceName}`,
    )
    const body = response.data as
      | { value?: Array<{ connectionStatus?: string }> }
      | Array<{ connectionStatus?: string }>
    const list = Array.isArray(body)
      ? body
      : ((body as { value?: Array<{ connectionStatus?: string }> }).value ?? [])
    return list[0]?.connectionStatus ?? 'disconnected'
  } catch {
    return 'error'
  }
}

async function reconnectEvolution(): Promise<void> {
  try {
    await evolutionApi.delete(`/instance/logout/${env.evolution.instanceName}`)
  } catch (err) {
    log.warn({ err }, 'Evolution: logout before reconnect failed')
  }
  try {
    await evolutionApi.get(`/instance/connect/${env.evolution.instanceName}`)
    log.info('Evolution reconnect triggered')
  } catch (err) {
    log.error({ err }, 'Evolution: failed to trigger reconnect')
  }
}

// ─── WAHA implementation ─────────────────────────────────────────────────────
// WAHA API docs: https://waha.devlike.pro/docs/

async function sendTextWAHA(phone: string, text: string): Promise<string | null> {
  try {
    const chatId = toWahaChatId(phone)
    const { data } = await withRetry(
      () =>
        wahaApi.post<{ id?: { id?: string; _serialized?: string } }>('/api/sendText', {
          session: env.waha.session,
          chatId,
          text,
        }),
      { label: `waha:sendText:${chatId}` },
    )
    const messageId = data.id?._serialized ?? data.id?.id ?? null
    log.info({ phone: chatId, messageId, provider: 'waha' }, 'Text message sent')
    return messageId
  } catch (err) {
    log.error({ phone, err }, 'WAHA: failed to send text')
    return null
  }
}

async function sendMediaWAHA(
  phone: string,
  mediaUrl: string,
  mediaType: 'image' | 'video' | 'document',
  caption?: string,
): Promise<string | null> {
  try {
    const chatId = toWahaChatId(phone)
    const endpoint =
      mediaType === 'image' ? '/api/sendImage' :
      mediaType === 'video' ? '/api/sendVideo' :
      '/api/sendFile'
    const filename =
      mediaType === 'document' ? 'material-solar.pdf' :
      mediaType === 'video' ? 'video.mp4' :
      'image.jpg'
    const { data } = await withRetry(
      () =>
        wahaApi.post<{ id?: { id?: string; _serialized?: string } }>(endpoint, {
          session: env.waha.session,
          chatId,
          file: { mimetype: undefined, filename, url: mediaUrl },
          caption: caption ?? '',
        }),
      { label: `waha:sendMedia:${mediaType}:${chatId}` },
    )
    const messageId = data.id?._serialized ?? data.id?.id ?? null
    log.info({ phone: chatId, mediaType, messageId, provider: 'waha' }, 'Media message sent')
    return messageId
  } catch (err) {
    log.error({ phone, mediaType, err }, 'WAHA: failed to send media')
    return null
  }
}

async function getStatusWAHA(): Promise<string> {
  try {
    const { data } = await wahaApi.get<{ status?: string; name?: string }>(
      `/api/sessions/${env.waha.session}`,
    )
    // WAHA statuses: STARTING, SCAN_QR_CODE, WORKING, FAILED, STOPPED
    const status = (data.status ?? 'unknown').toLowerCase()
    return status === 'working' ? 'open' : status
  } catch {
    return 'error'
  }
}

async function reconnectWAHA(): Promise<void> {
  try {
    // Stop session, then start fresh
    await wahaApi.post(`/api/sessions/${env.waha.session}/stop`).catch(() => {})
    await new Promise((r) => setTimeout(r, 1500))
    await wahaApi.post('/api/sessions/start', { name: env.waha.session })
    log.info('WAHA session restart triggered — fetch QR at GET /api/whatsapp/qr')
  } catch (err) {
    log.error({ err }, 'WAHA: failed to restart session')
  }
}

// Bootstraps the WAHA session on server start (idempotent — safe to call multiple times)
export async function bootstrapWhatsApp(): Promise<void> {
  if (env.whatsapp.provider !== 'waha') return
  try {
    // Check whether the session already exists
    const status = await getStatusWAHA()
    if (status === 'error' || status === 'unknown' || status === 'stopped') {
      log.info({ session: env.waha.session }, 'WAHA session not active — starting')
      await wahaApi.post('/api/sessions/start', { name: env.waha.session }).catch((err) => {
        log.warn({ err }, 'WAHA start returned non-2xx (may already be running)')
      })
    } else {
      log.info({ session: env.waha.session, status }, 'WAHA session already initialized')
    }
  } catch (err) {
    log.error({ err }, 'WAHA bootstrap failed — start manually via POST /api/whatsapp/reconnect')
  }
}

/** Returns the current QR code — either as raw base64 (no prefix) or full data URL.
 *  For Evolution we trigger /instance/connect which returns the QR; for WAHA we
 *  fetch /auth/qr. The /api/whatsapp/qr route handles both formats transparently.
 */
export async function getQrCode(): Promise<string | null> {
  if (env.whatsapp.provider === 'waha') {
    try {
      const response = await wahaApi.get(`/api/${env.waha.session}/auth/qr`, {
        responseType: 'arraybuffer',
        headers: { Accept: 'image/png' },
      })
      return Buffer.from(response.data as ArrayBuffer).toString('base64')
    } catch (err) {
      log.error({ err }, 'WAHA: failed to fetch QR code')
      return null
    }
  }

  // Evolution: GET /instance/connect/{name} returns { base64: 'data:image/png;base64,...' }
  try {
    const response = await evolutionApi.get(`/instance/connect/${env.evolution.instanceName}`)
    const data = response.data as { base64?: string; code?: string }
    return data.base64 ?? null   // returns the full data URL ("data:image/png;base64,...")
  } catch (err) {
    log.error({ err }, 'Evolution: failed to fetch QR code')
    return null
  }
}

// ─── Meta Cloud API implementation ───────────────────────────────────────────
// Docs: https://developers.facebook.com/docs/whatsapp/cloud-api

/** Meta expects raw international format with no '+', no '@', no JID suffix */
function toMetaPhone(phone: string): string {
  if (phone.includes('@')) {
    // Strip @c.us, @s.whatsapp.net, @lid → keep just the digits
    phone = phone.split('@')[0]
  }
  const cleaned = phone.replace(/\D/g, '')
  if (cleaned.startsWith('55') && cleaned.length >= 12) return cleaned
  if (cleaned.length === 11 || cleaned.length === 10) return `55${cleaned}`
  return cleaned
}

async function sendTextMeta(phone: string, text: string): Promise<string | null> {
  if (!env.meta.cloudPhoneNumberId || !env.meta.cloudAccessToken) {
    log.error('Meta Cloud API not configured — set META_CLOUD_PHONE_NUMBER_ID and META_CLOUD_ACCESS_TOKEN')
    return null
  }
  try {
    const to = toMetaPhone(phone)
    const { data } = await withRetry(
      () =>
        metaCloudApi.post<{ messages?: Array<{ id: string }> }>(
          `/${env.meta.cloudPhoneNumberId}/messages`,
          {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to,
            type: 'text',
            text: { body: text, preview_url: false },
          },
        ),
      { label: `meta:sendText:${to}` },
    )
    const messageId = data.messages?.[0]?.id ?? null
    log.info({ phone: to, messageId, provider: 'meta' }, 'Text message sent')
    return messageId
  } catch (err) {
    if (err instanceof AxiosError) {
      // Common Cloud API errors are shaped { error: { message, code, error_subcode, ... } }
      const errBody = err.response?.data as { error?: { message?: string; code?: number; error_data?: unknown } }
      log.error(
        { phone, status: err.response?.status, metaError: errBody?.error, provider: 'meta' },
        'Meta: failed to send text',
      )
    } else {
      log.error({ phone, err }, 'Meta: failed to send text')
    }
    return null
  }
}

async function sendMediaMeta(
  phone: string,
  mediaUrl: string,
  mediaType: 'image' | 'video' | 'document',
  caption?: string,
): Promise<string | null> {
  if (!env.meta.cloudPhoneNumberId || !env.meta.cloudAccessToken) {
    log.error('Meta Cloud API not configured')
    return null
  }
  try {
    const to = toMetaPhone(phone)
    const mediaPayload: Record<string, unknown> = { link: mediaUrl }
    if (caption) mediaPayload.caption = caption
    if (mediaType === 'document') mediaPayload.filename = 'material-solar.pdf'
    const { data } = await withRetry(
      () =>
        metaCloudApi.post<{ messages?: Array<{ id: string }> }>(
          `/${env.meta.cloudPhoneNumberId}/messages`,
          {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to,
            type: mediaType,
            [mediaType]: mediaPayload,
          },
        ),
      { label: `meta:sendMedia:${mediaType}:${to}` },
    )
    const messageId = data.messages?.[0]?.id ?? null
    log.info({ phone: to, mediaType, messageId, provider: 'meta' }, 'Media message sent')
    return messageId
  } catch (err) {
    log.error({ phone, mediaType, err }, 'Meta: failed to send media')
    return null
  }
}

async function getStatusMeta(): Promise<string> {
  if (!env.meta.cloudPhoneNumberId || !env.meta.cloudAccessToken) return 'not_configured'
  try {
    // Hitting the phone-number endpoint validates both PNI and token
    await metaCloudApi.get(`/${env.meta.cloudPhoneNumberId}`)
    return 'open'
  } catch (err) {
    if (err instanceof AxiosError && err.response?.status === 401) return 'unauthorized'
    return 'error'
  }
}

// ─── Misc (Evolution-only) ───────────────────────────────────────────────────

export async function markAsRead(phone: string, messageId: string): Promise<void> {
  if (env.whatsapp.provider !== 'evolution') return
  try {
    await evolutionApi.post(`/message/markMessageAsRead/${env.evolution.instanceName}`, {
      readMessages: [{ remoteJid: `${formatPhone(phone)}@s.whatsapp.net`, fromMe: false, id: messageId }],
    })
  } catch (err) {
    log.warn({ phone, messageId, err }, 'Failed to mark message as read')
  }
}

export async function createInstance(): Promise<void> {
  if (env.whatsapp.provider !== 'evolution') return
  try {
    await evolutionApi.post('/instance/create', {
      instanceName: env.evolution.instanceName,
      qrcode: true,
      integration: 'WHATSAPP-BAILEYS',
    })
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err)
    if (errorMessage.includes('already exists') || errorMessage.includes('409')) return
    throw err
  }
}

export async function setWebhook(webhookUrl: string): Promise<void> {
  if (env.whatsapp.provider !== 'evolution') return
  try {
    await evolutionApi.post(`/webhook/set/${env.evolution.instanceName}`, {
      url: webhookUrl,
      byEvents: true,
      base64: false,
      events: ['APPLICATION_STARTUP', 'MESSAGES_UPSERT', 'MESSAGES_UPDATE', 'SEND_MESSAGE', 'CONNECTION_UPDATE'],
    })
    log.info({ webhookUrl }, 'WhatsApp webhook configured')
  } catch (err) {
    log.error({ err }, 'Failed to set WhatsApp webhook')
  }
}
