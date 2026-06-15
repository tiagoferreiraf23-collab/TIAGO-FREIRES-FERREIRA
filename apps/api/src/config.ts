import { config } from 'dotenv'
config({ override: true })

function requireEnv(key: string): string {
  const value = process.env[key]
  if (!value) throw new Error(`Missing required env var: ${key}`)
  return value
}

function optionalEnv(key: string, fallback = ''): string {
  return process.env[key] ?? fallback
}

export const env = {
  port: parseInt(optionalEnv('PORT', '3000')),
  nodeEnv: optionalEnv('NODE_ENV', 'development'),
  isProduction: process.env.NODE_ENV === 'production',

  company: {
    name: optionalEnv('COMPANY_NAME', 'Ecolare Solar'),
    city: optionalEnv('COMPANY_CITY', 'São Paulo'),
    sdrName: optionalEnv('SDR_NAME', 'Ana'),
  },

  database: {
    url: requireEnv('DATABASE_URL'),
  },

  redis: {
    url: optionalEnv('REDIS_URL', 'redis://localhost:6379'),
  },

  anthropic: {
    apiKey: requireEnv('ANTHROPIC_API_KEY'),
    model: optionalEnv('ANTHROPIC_MODEL', 'claude-sonnet-4-20250514'),
  },

  openai: {
    apiKey: optionalEnv('OPENAI_API_KEY'),
    whisperModel: optionalEnv('OPENAI_WHISPER_MODEL', 'whisper-1'),
  },

  whatsapp: {
    // 'evolution' (Baileys) | 'waha' (Puppeteer) | 'meta' (Cloud API oficial)
    provider: (optionalEnv('WHATSAPP_PROVIDER', 'evolution') as 'evolution' | 'waha' | 'meta'),
  },

  evolution: {
    apiUrl: optionalEnv('EVOLUTION_API_URL', 'http://localhost:8080'),
    apiKey: requireEnv('EVOLUTION_API_KEY'),
    instanceName: optionalEnv('EVOLUTION_INSTANCE_NAME', 'sdr-solar'),
  },

  waha: {
    apiUrl: optionalEnv('WAHA_URL', 'http://localhost:3001'),
    apiKey: optionalEnv('WAHA_API_KEY', ''),
    session: optionalEnv('WAHA_SESSION', 'default'),
  },

  meta: {
    verifyToken: optionalEnv('META_VERIFY_TOKEN'),
    appSecret: optionalEnv('META_APP_SECRET'),
    accessToken: optionalEnv('META_ACCESS_TOKEN'),
    pageId: optionalEnv('META_PAGE_ID'),
    // Cloud API (oficial WhatsApp)
    cloudPhoneNumberId: optionalEnv('META_CLOUD_PHONE_NUMBER_ID'),
    cloudAccessToken: optionalEnv('META_CLOUD_ACCESS_TOKEN'),
    cloudWabaId: optionalEnv('META_CLOUD_WABA_ID'),
    graphApiVersion: optionalEnv('META_GRAPH_VERSION', 'v20.0'),
  },

  google: {
    clientId: optionalEnv('GOOGLE_CLIENT_ID'),
    clientSecret: optionalEnv('GOOGLE_CLIENT_SECRET'),
    redirectUri: optionalEnv('GOOGLE_REDIRECT_URI'),
    refreshToken: optionalEnv('GOOGLE_REFRESH_TOKEN'),
    mapsApiKey: optionalEnv('GOOGLE_MAPS_API_KEY'),
  },

  hubspot: {
    apiKey: optionalEnv('HUBSPOT_API_KEY'),
  },

  notifications: {
    slackWebhookUrl: optionalEnv('SLACK_WEBHOOK_URL'),
    teamWhatsappGroupId: optionalEnv('TEAM_WHATSAPP_GROUP_ID'),
  },

  sentry: {
    dsn: optionalEnv('SENTRY_DSN'),
  },

  business: {
    firstContactDelayMs: parseInt(optionalEnv('FIRST_CONTACT_DELAY_MINUTES', '2')) * 60 * 1000,
    hoursStart: parseInt(optionalEnv('BUSINESS_HOURS_START', '8')),
    hoursEnd: parseInt(optionalEnv('BUSINESS_HOURS_END', '18')),
    minQualificationScore: parseInt(optionalEnv('MIN_QUALIFICATION_SCORE', '50')),
  },

  logLevel: optionalEnv('LOG_LEVEL', 'info'),
} as const
