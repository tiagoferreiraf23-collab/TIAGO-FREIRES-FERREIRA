import { PrismaClient } from '@prisma/client'
import { createChildLogger } from '../logger'

const log = createChildLogger('prisma')

declare global {
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined
}

export const prisma =
  global.__prisma ??
  new PrismaClient({
    log: [
      { level: 'query' as const, emit: 'event' as const },
      { level: 'error' as const, emit: 'event' as const },
      { level: 'warn' as const, emit: 'event' as const },
    ],
  })

// $on types are narrowed from the log config above
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(prisma as any).$on('error', (e: unknown) => log.error(e, 'Prisma error'))
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(prisma as any).$on('warn', (e: unknown) => log.warn(e, 'Prisma warning'))

if (process.env.NODE_ENV !== 'production') {
  global.__prisma = prisma
}

export async function connectDatabase(): Promise<void> {
  await prisma.$connect()
  log.info('Database connected')
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect()
  log.info('Database disconnected')
}
