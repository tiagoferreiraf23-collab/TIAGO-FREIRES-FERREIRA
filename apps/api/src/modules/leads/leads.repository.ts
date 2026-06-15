import { prisma } from '../../prisma/client'
import { LeadStatus, LEAD_SCORE_WEIGHTS } from '@sdr-solar/shared'

export async function createLead(data: {
  name: string
  phone: string
  whatsappJid?: string
  email?: string
  city?: string
  energyBill?: number
  propertyType?: string
  source?: string
  adId?: string
  formId?: string
}) {
  const score = calculateInitialScore(data)

  return prisma.lead.create({
    data: {
      ...data,
      source: data.source ?? 'meta_ads',
      score,
      status: LeadStatus.NEW as unknown as 'NEW',
    },
  })
}

export async function findLeadByPhone(phone: string) {
  // Normalize: strip JID suffix (@s.whatsapp.net, @c.us, @lid, etc.)
  const stripped = phone.replace(/@\w+\.?\w*$/, '')
  const cleaned = stripped.replace(/\D/g, '')
  const variants = [cleaned, `55${cleaned}`, cleaned.replace(/^55/, '')]

  return prisma.lead.findFirst({
    where: {
      OR: [
        { phone: { in: variants } },
        { whatsappJid: phone },
      ],
    },
    include: {
      conversations: {
        include: { messages: { orderBy: { sentAt: 'asc' }, take: 30 } },
        orderBy: { createdAt: 'desc' },
        take: 1,
      },
    },
  })
}

export async function findLeadsForFollowUp() {
  return prisma.lead.findMany({
    where: {
      status: { in: ['CONTACTED'] as unknown as ['CONTACTED'] },
      followUpCount: { lt: 3 },
      lastContactAt: { lt: new Date(Date.now() - 2 * 60 * 60 * 1000) }, // 2h+ ago
    },
    include: { conversations: { include: { messages: { orderBy: { sentAt: 'desc' }, take: 1 } } } },
  })
}

export async function getMetrics(startDate: Date, endDate: Date) {
  const [total, contacted, qualified, scheduled, won] = await Promise.all([
    prisma.lead.count({ where: { createdAt: { gte: startDate, lte: endDate } } }),
    prisma.lead.count({
      where: {
        createdAt: { gte: startDate, lte: endDate },
        status: { in: ['CONTACTED', 'QUALIFIED', 'SCHEDULED', 'VISITED', 'WON'] as unknown as ['CONTACTED'] },
      },
    }),
    prisma.lead.count({
      where: {
        createdAt: { gte: startDate, lte: endDate },
        status: { in: ['QUALIFIED', 'SCHEDULED', 'VISITED', 'WON'] as unknown as ['CONTACTED'] },
      },
    }),
    prisma.lead.count({
      where: {
        createdAt: { gte: startDate, lte: endDate },
        status: { in: ['SCHEDULED', 'VISITED', 'WON'] as unknown as ['CONTACTED'] },
      },
    }),
    prisma.lead.count({
      where: {
        createdAt: { gte: startDate, lte: endDate },
        status: 'WON' as unknown as 'NEW',
      },
    }),
  ])

  return { total, contacted, qualified, scheduled, won }
}

function calculateInitialScore(data: {
  energyBill?: number
  propertyType?: string
}): number {
  let score = 0

  if (data.energyBill) {
    if (data.energyBill >= 400) score += LEAD_SCORE_WEIGHTS.HIGH_ENERGY_BILL
    else if (data.energyBill >= 200) score += LEAD_SCORE_WEIGHTS.MEDIUM_ENERGY_BILL
  }

  if (data.propertyType === 'casa') score += LEAD_SCORE_WEIGHTS.HOUSE

  return Math.min(score, 100)
}
