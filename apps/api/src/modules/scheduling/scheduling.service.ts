import { google } from 'googleapis'
import dayjs from 'dayjs'
import 'dayjs/locale/pt-br'
import { env } from '../../config'
import { createChildLogger } from '../../logger'
import { prisma } from '../../prisma/client'
import { LeadStatus } from '@sdr-solar/shared'
import type { VisitSlot } from '@sdr-solar/shared'

dayjs.locale('pt-br')

const log = createChildLogger('scheduling')

function getCalendarClient() {
  const auth = new google.auth.OAuth2(
    env.google.clientId,
    env.google.clientSecret,
    env.google.redirectUri,
  )
  auth.setCredentials({ refresh_token: env.google.refreshToken })
  return google.calendar({ version: 'v3', auth })
}

export async function checkCalendar(
  city: string,
  preferredPeriod?: 'manha' | 'tarde' | 'noite' | 'qualquer',
): Promise<VisitSlot[]> {
  try {
    const consultants = await prisma.consultant.findMany({
      where: {
        active: true,
        regions: { hasSome: [city, 'Todas as regiões'] },
      },
    })

    if (consultants.length === 0) {
      // Fallback: return any active consultant
      const allConsultants = await prisma.consultant.findMany({ where: { active: true } })
      if (allConsultants.length === 0) return []
      consultants.push(...allConsultants)
    }

    const slots: VisitSlot[] = []
    const calendar = getCalendarClient()

    const startDate = dayjs().add(1, 'day').startOf('day')
    const endDate = startDate.add(7, 'day').endOf('day')

    // Track if at least one calendar lookup succeeded. If all of them fail
    // (e.g. revoked OAuth token), we fall back to default slots instead of
    // misleadingly returning an empty array (which Ana would phrase as "agenda lotada").
    let anyConsultantSucceeded = false

    for (const consultant of consultants) {
      try {
        const busyResponse = await calendar.freebusy.query({
          requestBody: {
            timeMin: startDate.toISOString(),
            timeMax: endDate.toISOString(),
            items: [{ id: consultant.calendarId }],
          },
        })
        anyConsultantSucceeded = true

        const busySlots = busyResponse.data.calendars?.[consultant.calendarId]?.busy ?? []

        // Generate available 2-hour slots on business days
        let current = startDate
        while (current.isBefore(endDate)) {
          const dayOfWeek = current.day()
          if (dayOfWeek !== 0 && dayOfWeek !== 6) {
            // Not weekend
            // Slots cheios de hora em hora — visita dura 2h, mas mostramos só o início.
            // Manhã: 8-11 (last start 11h, ends 13h) | Tarde: 12-17 | Noite: 18-19 (last start 19h, ends 21h)
            // Noite só oferece se lead pedir explicitamente.
            const hourSlots = preferredPeriod === 'manha'
              ? [8, 9, 10, 11]
              : preferredPeriod === 'tarde'
              ? [12, 13, 14, 15, 16, 17]
              : preferredPeriod === 'noite'
              ? [18, 19]
              : [8, 9, 10, 11, 12, 13, 14, 15, 16, 17]   // 'qualquer': não oferece 18-19h espontaneamente

            for (const hour of hourSlots) {
              const slotStart = current.hour(hour).minute(0).second(0)
              const slotEnd = slotStart.add(2, 'hour')

              const isBusy = busySlots.some((busy) => {
                const busyStart = dayjs(busy.start ?? '')
                const busyEnd = dayjs(busy.end ?? '')
                return slotStart.isBefore(busyEnd) && slotEnd.isAfter(busyStart)
              })

              if (!isBusy) {
                slots.push({
                  consultantId: consultant.id,
                  consultantName: consultant.name,
                  startTime: slotStart.toDate(),
                  endTime: slotEnd.toDate(),
                })
              }

              if (slots.length >= 6) break
            }
          }
          current = current.add(1, 'day')
          if (slots.length >= 6) break
        }
      } catch (err) {
        log.warn({ consultantId: consultant.id, err }, 'Failed to check consultant calendar')
      }
    }

    // If NO calendar lookup worked (auth revoked, API down, etc.), fall back to
    // generic slots so Ana can still offer something instead of saying "lotado".
    if (!anyConsultantSucceeded) {
      log.warn(
        'All Google Calendar lookups failed — using fallback slots. Likely cause: revoked refresh_token. Visit /auth/google to reauthorize.',
      )
      return await generateFallbackSlots()
    }

    return slots.sort((a, b) => a.startTime.getTime() - b.startTime.getTime())
  } catch (err) {
    log.error({ city, err }, 'Failed to check calendar')
    return await generateFallbackSlots()
  }
}

export async function scheduleVisit(
  leadId: string,
  dateTime: Date,
  consultantId: string,
): Promise<{ success: boolean; error?: string; eventId?: string; dateTime?: string; consultantName?: string; consultantId?: string }> {
  try {
    const [lead, consultantById] = await Promise.all([
      prisma.lead.findUnique({ where: { id: leadId } }),
      prisma.consultant.findUnique({ where: { id: consultantId } }),
    ])

    if (!lead) {
      log.warn({ leadId }, 'scheduleVisit: lead not found')
      return { success: false, error: 'lead_not_found' }
    }

    // Resolve consultant. Ana sometimes hallucinates a "humanized" ID like
    // "cons_tiago_fortaleza" instead of using the real CUID from check_calendar.
    // Fallback: if there is exactly one active consultant, use it.
    let consultant = consultantById
    if (!consultant) {
      const actives = await prisma.consultant.findMany({ where: { active: true } })
      if (actives.length === 1) {
        consultant = actives[0]
        log.warn(
          { requestedId: consultantId, resolvedId: consultant.id },
          'scheduleVisit: consultantId not found, falling back to the only active consultant',
        )
      } else if (actives.length > 1) {
        log.warn(
          { requestedId: consultantId, activeCount: actives.length },
          'scheduleVisit: consultantId not found and multiple consultants active — cannot disambiguate',
        )
        return {
          success: false,
          error: 'invalid_consultantId',
        }
      } else {
        log.warn('scheduleVisit: no active consultant exists in DB')
        return { success: false, error: 'no_active_consultant' }
      }
    }

    const calendar = getCalendarClient()
    const endTime = dayjs(dateTime).add(2, 'hour').toDate()

    const event = await calendar.events.insert({
      calendarId: consultant.calendarId,
      requestBody: {
        summary: `Visita Técnica Solar - ${lead.name}`,
        description: `Lead: ${lead.name}\nTelefone: ${lead.phone}\nCidade: ${lead.city ?? 'N/A'}\nConta de Luz: R$${lead.energyBill ?? 'N/A'}\nFonte: ${lead.source}`,
        start: { dateTime: dateTime.toISOString(), timeZone: 'America/Sao_Paulo' },
        end: { dateTime: endTime.toISOString(), timeZone: 'America/Sao_Paulo' },
        attendees: [
          { email: consultant.email, displayName: consultant.name },
          ...(lead.email ? [{ email: lead.email, displayName: lead.name }] : []),
        ],
        reminders: {
          useDefault: false,
          overrides: [
            { method: 'email', minutes: 1440 }, // 24h
            { method: 'popup', minutes: 60 },   // 1h
          ],
        },
      },
    })

    await prisma.lead.update({
      where: { id: leadId },
      data: {
        status: LeadStatus.SCHEDULED as unknown as 'NEW',
        scheduledAt: dateTime,
        consultantId: consultant.id,   // resolved (may differ from requested if fallback was used)
      },
    })

    log.info(
      { leadId, consultantId: consultant.id, dateTime: dateTime.toISOString(), eventId: event.data.id },
      'Visit scheduled — event created in Google Calendar',
    )

    return {
      success: true,
      eventId: event.data.id ?? undefined,
      dateTime: dateTime.toISOString(),
      consultantName: consultant.name,
      consultantId: consultant.id,
    }
  } catch (err) {
    log.error({ leadId, consultantId, err }, 'Failed to schedule visit (Google Calendar insert failed)')
    return {
      success: false,
      error: 'calendar_insert_failed',
    }
  }
}

async function generateFallbackSlots(): Promise<VisitSlot[]> {
  // Use a real consultant from the DB instead of the string 'default' so that
  // schedule_visit() can actually find the row and create the calendar event.
  const consultant = await prisma.consultant.findFirst({
    where: { active: true },
    orderBy: { createdAt: 'asc' },
  })

  if (!consultant) {
    log.warn('No active consultant available — returning empty fallback slots')
    return []
  }

  const slots: VisitSlot[] = []
  const start = dayjs().add(2, 'day').hour(9).minute(0).second(0)

  for (let i = 0; i < 3; i++) {
    const day = start.add(i, 'day')
    if (day.day() !== 0 && day.day() !== 6) {
      slots.push({
        consultantId: consultant.id,
        consultantName: consultant.name,
        startTime: day.toDate(),
        endTime: day.add(2, 'hour').toDate(),
      })
    }
  }

  return slots
}
