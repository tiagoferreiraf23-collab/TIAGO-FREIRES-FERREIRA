import axios from 'axios'
import { env } from '../../config'
import { createChildLogger } from '../../logger'
import type { Lead } from '@sdr-solar/shared'

const log = createChildLogger('crm')

const hubspotApi = axios.create({
  baseURL: 'https://api.hubapi.com',
  headers: {
    Authorization: `Bearer ${env.hubspot.apiKey}`,
    'Content-Type': 'application/json',
  },
  timeout: 10000,
})

const HUBSPOT_STAGE_MAP: Record<string, string> = {
  NEW: 'appointmentscheduled',
  CONTACTED: 'appointmentscheduled',
  QUALIFIED: 'qualifiedtobuy',
  SCHEDULED: 'presentationscheduled',
  VISITED: 'decisionmakerboughtin',
  PROPOSAL_SENT: 'contractsent',
  WON: 'closedwon',
  LOST: 'closedlost',
  DISQUALIFIED: 'closedlost',
}

export async function syncLeadToHubspot(lead: Lead): Promise<string | null> {
  if (!env.hubspot.apiKey) return null

  try {
    const properties = {
      firstname: lead.name.split(' ')[0],
      lastname: lead.name.split(' ').slice(1).join(' '),
      phone: lead.phone,
      email: lead.email ?? '',
      city: lead.city ?? '',
      dealstage: HUBSPOT_STAGE_MAP[lead.status] ?? 'appointmentscheduled',
      hs_lead_status: lead.status,
      energia_solar_conta: lead.energyBill?.toString() ?? '',
      tipo_imovel: lead.propertyType ?? '',
      utm_source: lead.source,
      hs_analytics_source: 'PAID_SOCIAL',
    }

    // Check if contact already exists
    const searchResponse = await hubspotApi.post('/crm/v3/objects/contacts/search', {
      filterGroups: [{ filters: [{ propertyName: 'phone', operator: 'EQ', value: lead.phone }] }],
    })

    const existingContacts = (searchResponse.data as { results?: Array<{ id: string }> }).results ?? []

    if (existingContacts.length > 0) {
      await hubspotApi.patch(`/crm/v3/objects/contacts/${existingContacts[0].id}`, { properties })
      log.debug({ leadId: lead.id, hubspotId: existingContacts[0].id }, 'HubSpot contact updated')
      return existingContacts[0].id
    } else {
      const createResponse = await hubspotApi.post('/crm/v3/objects/contacts', { properties })
      const newId = (createResponse.data as { id: string }).id
      log.debug({ leadId: lead.id, hubspotId: newId }, 'HubSpot contact created')
      return newId
    }
  } catch (err) {
    log.warn({ leadId: lead.id, err }, 'Failed to sync to HubSpot')
    return null
  }
}

export async function createHubspotDeal(
  lead: Lead,
  contactId: string,
): Promise<string | null> {
  if (!env.hubspot.apiKey) return null

  try {
    const dealResponse = await hubspotApi.post('/crm/v3/objects/deals', {
      properties: {
        dealname: `Visita Solar - ${lead.name}`,
        dealstage: HUBSPOT_STAGE_MAP[lead.status] ?? 'appointmentscheduled',
        pipeline: 'default',
        amount: lead.energyBill ? (lead.energyBill * 12 * 0.15).toFixed(0) : '',
        closedate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      },
    })

    const dealId = (dealResponse.data as { id: string }).id

    // Associate deal with contact
    await hubspotApi.put(
      `/crm/v3/objects/deals/${dealId}/associations/contacts/${contactId}/3`,
      {},
    )

    log.debug({ leadId: lead.id, dealId }, 'HubSpot deal created')
    return dealId
  } catch (err) {
    log.warn({ leadId: lead.id, err }, 'Failed to create HubSpot deal')
    return null
  }
}
