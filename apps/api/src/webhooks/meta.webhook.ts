import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import crypto from 'crypto'
import axios from 'axios'
import { env } from '../config'
import { createChildLogger } from '../logger'
import { processMetaLead } from '../modules/leads/leads.service'
import type { MetaLeadPayload } from '@sdr-solar/shared'

const log = createChildLogger('webhook:meta')

interface MetaWebhookBody {
  object: string
  entry: Array<{
    id: string
    changes: Array<{
      field: string
      value: {
        leadgen_id: string
        page_id: string
        ad_id: string
        form_id: string
        created_time: number
        field_data?: Array<{ name: string; values: string[] }>
      }
    }>
  }>
}

export async function registerMetaWebhook(app: FastifyInstance): Promise<void> {
  // Webhook verification (GET)
  app.get('/webhooks/meta', async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as Record<string, string>
    const mode = query['hub.mode']
    const token = query['hub.verify_token']
    const challenge = query['hub.challenge']

    if (mode === 'subscribe' && token === env.meta.verifyToken) {
      log.info('Meta webhook verified successfully')
      return reply.send(challenge)
    }

    log.warn({ mode, token }, 'Meta webhook verification failed')
    return reply.code(403).send({ error: 'Forbidden' })
  })

  // Webhook events (POST)
  // config.rawBody is injected by fastify-rawbody plugin — not in core Fastify types
  app.post('/webhooks/meta', {
    config: { rawBody: true } as Record<string, unknown>,
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      // Verify signature
      const signature = (request.headers['x-hub-signature-256'] as string) ?? ''
      const rawBody = (request as unknown as { rawBody: Buffer }).rawBody

      if (!verifyMetaSignature(rawBody, signature)) {
        log.warn('Invalid Meta webhook signature')
        return reply.code(401).send({ error: 'Invalid signature' })
      }

      const body = request.body as MetaWebhookBody

      if (body.object !== 'page') {
        return reply.send({ status: 'ok' })
      }

      // Process each lead event asynchronously
      for (const entry of body.entry) {
        for (const change of entry.changes) {
          if (change.field !== 'leadgen') continue

          const value = change.value

          try {
            // If field_data is included directly (not always the case)
            if (value.field_data && value.field_data.length > 0) {
              const payload: MetaLeadPayload = {
                leadgenId: value.leadgen_id,
                pageId: value.page_id,
                adId: value.ad_id,
                formId: value.form_id,
                createdTime: value.created_time,
                fieldData: value.field_data,
              }
              processMetaLead(payload).catch((err) =>
                log.error({ err, leadgenId: value.leadgen_id }, 'Failed to process Meta lead'),
              )
            } else {
              // Fetch full lead data from Graph API
              fetchAndProcessLead(value.leadgen_id, value.page_id, value.ad_id, value.form_id, value.created_time).catch(
                (err) => log.error({ err, leadgenId: value.leadgen_id }, 'Failed to fetch Meta lead'),
              )
            }
          } catch (err) {
            log.error({ err, leadgenId: value.leadgen_id }, 'Error processing Meta lead event')
          }
        }
      }

      return reply.send({ status: 'ok' })
    },
  })
}

async function fetchAndProcessLead(
  leadgenId: string,
  pageId: string,
  adId: string,
  formId: string,
  createdTime: number,
): Promise<void> {
  try {
    const response = await axios.get(`https://graph.facebook.com/v20.0/${leadgenId}`, {
      params: { access_token: env.meta.accessToken, fields: 'field_data,id,created_time' },
    })

    const data = response.data as { field_data: Array<{ name: string; values: string[] }>; id: string }

    const payload: MetaLeadPayload = {
      leadgenId,
      pageId,
      adId,
      formId,
      createdTime,
      fieldData: data.field_data,
    }

    await processMetaLead(payload)
  } catch (err) {
    log.error({ err, leadgenId }, 'Failed to fetch lead from Meta Graph API')
    throw err
  }
}

function verifyMetaSignature(rawBody: Buffer, signature: string): boolean {
  if (!env.meta.appSecret || !signature) return true // Skip in development
  const expected = `sha256=${crypto
    .createHmac('sha256', env.meta.appSecret)
    .update(rawBody)
    .digest('hex')}`
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))
  } catch {
    return false
  }
}
