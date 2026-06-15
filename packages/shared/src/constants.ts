export const QUEUE_NAMES = {
  LEAD_PROCESSOR: 'lead-processor',
  CONVERSATION: 'conversation',
  FOLLOW_UP: 'follow-up',
  NOTIFICATION: 'notification',
  CALENDAR: 'calendar',
  SCHEDULED_CALLBACK: 'scheduled-callback',
} as const

export const JOB_NAMES = {
  PROCESS_NEW_LEAD: 'process-new-lead',
  SEND_INITIAL_MESSAGE: 'send-initial-message',
  PROCESS_INCOMING_MESSAGE: 'process-incoming-message',
  FOLLOW_UP_1: 'follow-up-1',
  FOLLOW_UP_2: 'follow-up-2',
  FOLLOW_UP_3: 'follow-up-3',
  FOLLOW_UP_4: 'follow-up-4',
  FOLLOW_UP_5: 'follow-up-5',
  SEND_VISIT_REMINDER: 'send-visit-reminder',
  UPDATE_CRM: 'update-crm',
  PROCESS_SCHEDULED_CALLBACK: 'process-scheduled-callback',
} as const

// 5-step cadence (cumulative from the lead's last silence):
// Step 1: 5 min after Ana's message
// Step 2: 15 min after step 1
// Step 3: 2 hours after step 2
// Step 4: next day at 7 AM (calculated at runtime)
// Step 5: 48 hours after step 4
export const FOLLOW_UP_DELAYS = {
  STEP_1: 5 * 60 * 1000,             // 5 min
  STEP_2: 15 * 60 * 1000,            // 15 min
  STEP_3: 2 * 60 * 60 * 1000,        // 2 h
  STEP_4_HOUR: 7,                    // 07:00 next day (computed)
  STEP_5: 48 * 60 * 60 * 1000,       // 48 h
  REMINDER_24H: 24 * 60 * 60 * 1000,
  REMINDER_2H: 2 * 60 * 60 * 1000,
} as const

export const LEAD_SCORE_WEIGHTS = {
  HIGH_ENERGY_BILL: 30,      // conta > R$400
  MEDIUM_ENERGY_BILL: 15,    // conta R$200-400
  OWN_PROPERTY: 25,
  HOUSE: 15,                 // casa > apartamento
  QUICK_RESPONSE: 20,        // respondeu < 30min
  MULTIPLE_CONTACTS: -10,    // já tentou contato antes
} as const

export const MIN_ENERGY_BILL = 200
export const MAX_ENERGY_BILL = 2000
export const INITIAL_CONTACT_DELAY_MS = 2 * 60 * 1000  // 2 minutos

export const BUSINESS_HOURS = {
  START: 8,
  END: 18,
} as const

export const MAX_MESSAGES_PER_CONVERSATION = 20
export const MAX_FOLLOW_UP_ATTEMPTS = 5
