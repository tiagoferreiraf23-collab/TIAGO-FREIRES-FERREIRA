export enum LeadStatus {
  NEW = 'NEW',
  CONTACTED = 'CONTACTED',
  QUALIFIED = 'QUALIFIED',
  SCHEDULED = 'SCHEDULED',
  VISITED = 'VISITED',
  PROPOSAL_SENT = 'PROPOSAL_SENT',
  WON = 'WON',
  LOST = 'LOST',
  DISQUALIFIED = 'DISQUALIFIED',
  ESCALATED = 'ESCALATED',
}

export enum ConversationState {
  INITIAL_CONTACT = 'INITIAL_CONTACT',
  QUALIFYING = 'QUALIFYING',
  SCHEDULING = 'SCHEDULING',
  CONFIRMED = 'CONFIRMED',
  NO_RESPONSE = 'NO_RESPONSE',
  ESCALATED = 'ESCALATED',
  CLOSED = 'CLOSED',
}

export enum MessageRole {
  USER = 'user',
  ASSISTANT = 'assistant',
  SYSTEM = 'system',
}

export enum LeadIntent {
  INTEREST_HIGH = 'INTEREST_HIGH',
  INTEREST_MEDIUM = 'INTEREST_MEDIUM',
  INTEREST_LOW = 'INTEREST_LOW',
  OBJECTION = 'OBJECTION',
  NOT_QUALIFIED = 'NOT_QUALIFIED',
  SCHEDULING = 'SCHEDULING',
  CONFIRMATION = 'CONFIRMATION',
  ESCALATE_HUMAN = 'ESCALATE_HUMAN',
  UNCLEAR = 'UNCLEAR',
}

export enum PropertyType {
  HOUSE = 'casa',
  APARTMENT = 'apartamento',
  COMMERCIAL = 'comercial',
  FARM = 'sitio_fazenda',
}

export interface Lead {
  id: string
  name: string
  phone: string
  email?: string
  city?: string
  neighborhood?: string
  energyBill?: number
  propertyType?: PropertyType
  ownProperty?: boolean
  source: string
  adId?: string
  formId?: string
  status: LeadStatus
  score: number
  consultantId?: string
  scheduledAt?: Date
  createdAt: Date
  updatedAt: Date
}

export interface Message {
  id: string
  conversationId: string
  role: MessageRole
  content: string
  sentAt: Date
  deliveredAt?: Date
  readAt?: Date
  metadata?: Record<string, unknown>
}

export interface Conversation {
  id: string
  leadId: string
  state: ConversationState
  messages: Message[]
  createdAt: Date
  updatedAt: Date
}

export interface Consultant {
  id: string
  name: string
  phone: string
  email: string
  regions: string[]
  calendarId: string
  active: boolean
}

export interface VisitSlot {
  consultantId: string
  consultantName: string
  startTime: Date
  endTime: Date
}

export interface SDRDecision {
  intent: LeadIntent
  confidence: number
  nextMessage: string
  shouldSchedule: boolean
  shouldEscalate: boolean
  escalationReason?: string
  extractedData?: {
    city?: string
    propertyType?: PropertyType
    ownProperty?: boolean
    preferredPeriod?: string
    energyBill?: number
  }
}

export interface MetaLeadPayload {
  leadgenId: string
  pageId: string
  adId: string
  formId: string
  createdTime: number
  fieldData: Array<{ name: string; values: string[] }>
}

export interface WhatsAppMessage {
  from: string
  to: string
  body: string
  timestamp: number
  messageId: string
  type: 'text' | 'audio' | 'image' | 'document' | 'location'
}

export interface DashboardMetrics {
  contactRateUnder5Min: number
  responseRate: number
  qualificationRate: number
  schedulingRate: number
  overallConversionRate: number
  avgTimeToSchedule: number
  costPerScheduledLead: number
  totalLeads: number
  totalContacted: number
  totalQualified: number
  totalScheduled: number
  leadsToday: number
  leadsThisWeek: number
  leadsThisMonth: number
}
