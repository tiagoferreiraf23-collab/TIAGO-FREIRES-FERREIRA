import * as Sentry from '@sentry/node'
import { env } from './config'

if (env.sentry.dsn) {
  Sentry.init({
    dsn: env.sentry.dsn,
    environment: env.nodeEnv,
    tracesSampleRate: 0.1,
    beforeSend(event) {
      const url = event.request?.url ?? ''
      if (url.includes('/health')) return null
      return event
    },
  })
}

export { Sentry }
