import pino from 'pino'
import { env } from './config'

// Em prod, default 'info' (não DEBUG). Pode subir pra 'warn' se quiser ainda menos.
const effectiveLevel = env.isProduction ? (env.logLevel || 'info') : (env.logLevel || 'debug')

export const logger = pino({
  level: effectiveLevel,
  transport: env.isProduction
    ? undefined  // JSON estruturado em prod (Railway/Datadog/Sentry parseiam direto)
    : {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname',
        },
      },
  base: { service: 'sdr-api' },
  serializers: {
    err: pino.stdSerializers.err,
    req: pino.stdSerializers.req,
    res: pino.stdSerializers.res,
  },
  // Redact dados sensíveis automaticamente — token, password, authorization headers
  redact: {
    paths: [
      'token', '*.token', 'access_token', '*.access_token',
      'password', '*.password',
      'authorization', '*.authorization',
      'req.headers.authorization',
      'req.headers.cookie',
      'apikey', '*.apikey',
      'META_CLOUD_ACCESS_TOKEN', '*.META_CLOUD_ACCESS_TOKEN',
      'OPENAI_API_KEY', '*.OPENAI_API_KEY',
      'ANTHROPIC_API_KEY', '*.ANTHROPIC_API_KEY',
    ],
    censor: '[REDACTED]',
  },
})

export function createChildLogger(module: string) {
  return logger.child({ module })
}
