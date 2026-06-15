'use client'

import { useEffect, useMemo, useRef, useState } from 'react'

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000'

// ─── Types ──────────────────────────────────────────────────────────────────
interface Lead {
  id: string
  name: string
  phone: string
  city?: string | null
  energyBill?: number | null
  propertyType?: string | null
  status?: string | null
  scheduledAt?: string | null
}
interface LastMessage {
  role: string
  content: string
  sentAt: string
  metadata?: { humanSent?: boolean } | null
}
interface ConversationSummary {
  id: string
  leadId: string
  state: string
  aiPaused: boolean
  updatedAt: string
  messageCount: number
  lead: Lead
  lastMessage: LastMessage | null
}
interface Message {
  id: string
  role: string
  content: string
  sentAt: string
  metadata?: { humanSent?: boolean; followUpAttempt?: number; kind?: string } | null
}

// ─── Helpers ────────────────────────────────────────────────────────────────
function formatRelativeTime(iso: string): string {
  const date = new Date(iso)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMin = Math.floor(diffMs / 60000)
  if (diffMin < 1) return 'agora'
  if (diffMin < 60) return `${diffMin}m`
  const diffH = Math.floor(diffMin / 60)
  if (diffH < 24) return `${diffH}h`
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (date.toDateString() === yesterday.toDateString()) return 'ontem'
  return date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })
}

const STATE_STYLES: Record<string, string> = {
  INITIAL_CONTACT: 'bg-gray-700 text-gray-300',
  QUALIFYING: 'bg-purple-900/60 text-purple-200',
  SCHEDULING: 'bg-amber-900/60 text-amber-200',
  CONFIRMED: 'bg-green-900/60 text-green-200',
  ESCALATED: 'bg-orange-900/60 text-orange-200',
  CLOSED: 'bg-gray-800 text-gray-400',
  NO_RESPONSE: 'bg-red-900/60 text-red-300',
}
function stateClass(state: string): string {
  return STATE_STYLES[state] ?? 'bg-gray-700 text-gray-300'
}

// ─── Component ──────────────────────────────────────────────────────────────
export default function InboxPage() {
  const [conversations, setConversations] = useState<ConversationSummary[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedConv, setSelectedConv] = useState<ConversationSummary | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [search, setSearch] = useState('')
  const [stateFilter, setStateFilter] = useState<string>('')
  const [humanInput, setHumanInput] = useState('')
  const [sending, setSending] = useState(false)
  const [loading, setLoading] = useState(true)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void fetchConversations()
  }, [stateFilter])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length, selectedId])

  // SSE — real-time updates
  useEffect(() => {
    const es = new EventSource(`${API_URL}/api/inbox/stream`)
    es.onmessage = (e) => {
      try {
        const ev = JSON.parse(e.data as string) as {
          type: string
          updated: Array<{ id: string; state: string; aiPaused: boolean; updatedAt: string }>
          newMessages: Array<{ id: string; conversationId: string; role: string; content: string; sentAt: string }>
        }
        if (ev.type !== 'update') return
        if (ev.updated.length > 0 || ev.newMessages.length > 0) void fetchConversations()
        if (selectedId && ev.newMessages.some((m) => m.conversationId === selectedId)) {
          setMessages((prev) => {
            const known = new Set(prev.map((m) => m.id))
            const toAdd = ev.newMessages
              .filter((m) => m.conversationId === selectedId && !known.has(m.id))
              .map((m) => ({ id: m.id, role: m.role, content: m.content, sentAt: m.sentAt, metadata: null }))
            return [...prev, ...toAdd]
          })
        }
      } catch (_) {}
    }
    es.onerror = () => es.close()
    return () => es.close()
  }, [selectedId])

  async function fetchConversations() {
    try {
      const params = new URLSearchParams()
      if (stateFilter) params.set('state', stateFilter)
      const res = await fetch(`${API_URL}/api/inbox/conversations?${params}`)
      const data = (await res.json()) as { conversations: ConversationSummary[] }
      setConversations(data.conversations)
    } catch (_) {
    } finally {
      setLoading(false)
    }
  }

  async function selectConversation(conv: ConversationSummary) {
    setSelectedId(conv.id)
    setSelectedConv(conv)
    setMessages([])
    try {
      const res = await fetch(`${API_URL}/api/inbox/conversations/${conv.id}/messages`)
      const data = (await res.json()) as { messages: Message[]; conversation: ConversationSummary; lead: Lead }
      setMessages(data.messages)
      // Refresh full lead data from server (sidebar shows extra fields)
      setSelectedConv({ ...conv, lead: { ...conv.lead, ...data.lead } })
    } catch (_) {}
  }

  async function toggleAI() {
    if (!selectedConv) return
    const newPaused = !selectedConv.aiPaused
    try {
      await fetch(`${API_URL}/api/inbox/conversations/${selectedConv.id}/pause`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paused: newPaused }),
      })
      setSelectedConv({ ...selectedConv, aiPaused: newPaused })
      void fetchConversations()
    } catch (_) {}
  }

  async function sendHumanReply() {
    const text = humanInput.trim()
    if (!text || !selectedConv) return
    setSending(true)
    try {
      await fetch(`${API_URL}/api/inbox/conversations/${selectedConv.id}/reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text }),
      })
      setHumanInput('')
    } catch (_) {
    } finally {
      setSending(false)
    }
  }

  const filtered = useMemo(() => {
    if (!search) return conversations
    const s = search.toLowerCase()
    return conversations.filter(
      (c) => c.lead.name.toLowerCase().includes(s) || c.lead.phone.includes(s),
    )
  }, [conversations, search])

  // Compute tool usage from messages (best-effort — show what's known)
  const toolsUsed = useMemo(() => {
    const tools = new Set<string>()
    for (const m of messages) {
      if (m.metadata?.humanSent) tools.add('reposta_humana')
      if (m.metadata?.followUpAttempt) tools.add(`follow_up_${m.metadata.followUpAttempt}`)
      if (m.metadata?.kind === 'scheduled_callback') tools.add('schedule_callback')
    }
    return [...tools]
  }, [messages])

  return (
    <div className="fixed inset-0 left-64 bg-[#0f0f12] text-gray-200 flex" style={{ minWidth: 0 }}>
      {/* ─── COLUNA 1: Lista de conversas ─────────────────────────────────── */}
      <aside className="w-80 bg-[#18181b] border-r border-[#2a2a2e] flex flex-col flex-shrink-0">
        <div className="px-4 py-3 border-b border-[#2a2a2e]">
          <h1 className="text-base font-semibold text-gray-100">Inbox</h1>
          <p className="text-xs text-gray-500 mt-0.5">{conversations.length} conversas</p>
        </div>

        <div className="p-3 border-b border-[#2a2a2e] space-y-2">
          <input
            type="text"
            placeholder="🔍 Buscar nome ou telefone"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full bg-[#27272a] text-gray-200 placeholder-gray-500 border border-[#3f3f46] rounded-md px-3 py-1.5 text-sm focus:outline-none focus:border-amber-500"
          />
          <select
            value={stateFilter}
            onChange={(e) => setStateFilter(e.target.value)}
            className="w-full bg-[#27272a] text-gray-200 border border-[#3f3f46] rounded-md px-3 py-1.5 text-sm focus:outline-none"
          >
            <option value="">Todos os estados</option>
            <option value="INITIAL_CONTACT">Contato inicial</option>
            <option value="QUALIFYING">Qualificando</option>
            <option value="SCHEDULING">Agendando</option>
            <option value="CONFIRMED">Visita confirmada</option>
            <option value="ESCALATED">Escalado</option>
            <option value="CLOSED">Fechada</option>
            <option value="NO_RESPONSE">Sem resposta</option>
          </select>
        </div>

        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <p className="text-center text-xs text-gray-500 py-6">Carregando…</p>
          ) : filtered.length === 0 ? (
            <p className="text-center text-xs text-gray-500 py-6">Nenhuma conversa</p>
          ) : (
            filtered.map((c) => {
              const isSelected = c.id === selectedId
              const preview = c.lastMessage
                ? c.lastMessage.content.slice(0, 50) + (c.lastMessage.content.length > 50 ? '…' : '')
                : '(sem mensagens)'
              const fromMe = c.lastMessage?.role === 'assistant'
              const fromHuman = c.lastMessage?.metadata?.humanSent
              return (
                <button
                  key={c.id}
                  onClick={() => selectConversation(c)}
                  className={`w-full text-left px-3 py-2.5 border-b border-[#27272a] hover:bg-[#27272a] transition-colors ${
                    isSelected ? 'bg-[#27272a] border-l-2 border-l-amber-500' : ''
                  }`}
                >
                  <div className="flex items-start gap-2">
                    <div className="w-9 h-9 rounded-full bg-gradient-to-br from-amber-500 to-orange-600 flex items-center justify-center text-white font-semibold text-sm flex-shrink-0">
                      {c.lead.name.charAt(0).toUpperCase()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-sm font-medium text-gray-100 truncate">{c.lead.name}</p>
                        <span className="text-[10px] text-gray-500 flex-shrink-0">
                          {c.lastMessage ? formatRelativeTime(c.lastMessage.sentAt) : ''}
                        </span>
                      </div>
                      <p className="text-xs text-gray-500 truncate mt-0.5">
                        {fromMe ? (fromHuman ? '👤 ' : '🤖 ') : '👥 '}
                        {preview}
                      </p>
                      <div className="mt-1 flex items-center gap-1.5">
                        <span className={`text-[9px] px-1.5 py-0.5 rounded ${stateClass(c.state)}`}>
                          {c.state}
                        </span>
                        {c.aiPaused && (
                          <span className="text-[9px] px-1.5 py-0.5 rounded bg-orange-900/60 text-orange-200">
                            ⏸ pausada
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                </button>
              )
            })
          )}
        </div>
      </aside>

      {/* ─── COLUNA 2: Conversa selecionada ───────────────────────────────── */}
      <section className="flex-1 flex flex-col min-w-0">
        {!selectedConv ? (
          <div className="flex-1 flex items-center justify-center text-gray-500">
            <div className="text-center">
              <p className="text-5xl mb-3">💬</p>
              <p className="text-sm">Selecione uma conversa pra começar</p>
            </div>
          </div>
        ) : (
          <>
            {/* Header */}
            <header className="px-4 py-3 bg-[#18181b] border-b border-[#2a2a2e] flex items-center justify-between">
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-10 h-10 rounded-full bg-gradient-to-br from-amber-500 to-orange-600 flex items-center justify-center text-white font-semibold flex-shrink-0">
                  {selectedConv.lead.name.charAt(0).toUpperCase()}
                </div>
                <div className="min-w-0">
                  <p className="font-semibold text-gray-100 truncate">{selectedConv.lead.name}</p>
                  <p className="text-xs text-gray-500 truncate">
                    {selectedConv.lead.phone}
                    {selectedConv.lead.city ? ` · ${selectedConv.lead.city}` : ''}
                  </p>
                </div>
              </div>
              <button
                onClick={toggleAI}
                className={`flex-shrink-0 text-xs px-3 py-1.5 rounded-md font-medium transition-colors ${
                  selectedConv.aiPaused
                    ? 'bg-orange-600 text-white hover:bg-orange-700'
                    : 'bg-green-700 text-green-100 hover:bg-green-600'
                }`}
              >
                {selectedConv.aiPaused ? '👤 Modo Humano' : '🤖 Ana ativa'}
              </button>
            </header>

            {selectedConv.aiPaused && (
              <div className="bg-orange-900/40 border-b border-orange-800/60 px-4 py-1.5 text-xs text-orange-200 text-center">
                ⏸ Ana pausada — suas mensagens vão direto pro lead como atendente humano
              </div>
            )}

            {/* Mensagens */}
            <div className="flex-1 overflow-y-auto px-6 py-4 space-y-2 bg-[#0f0f12]">
              {messages.length === 0 ? (
                <div className="text-center text-gray-500 text-sm py-8">Sem mensagens ainda</div>
              ) : (
                messages.map((m) => {
                  const isAssistant = m.role === 'assistant'
                  const isHuman = m.metadata?.humanSent === true
                  return (
                    <div key={m.id} className={`flex ${isAssistant ? 'justify-end' : 'justify-start'}`}>
                      <div
                        className={`max-w-[70%] rounded-lg px-3 py-2 text-sm ${
                          isAssistant
                            ? isHuman
                              ? 'bg-orange-900/40 text-orange-100 border border-orange-800/60'
                              : 'bg-green-700 text-white'
                            : 'bg-[#27272a] text-gray-100'
                        }`}
                      >
                        {isAssistant && (
                          <p className="text-[10px] opacity-70 mb-0.5">{isHuman ? '👤 Humano' : '🤖 Ana'}</p>
                        )}
                        <p className="whitespace-pre-wrap leading-snug">{m.content}</p>
                        <p className="text-[10px] opacity-50 mt-1 text-right">
                          {new Date(m.sentAt).toLocaleTimeString('pt-BR', {
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </p>
                      </div>
                    </div>
                  )
                })
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* Composer */}
            <div className="bg-[#18181b] border-t border-[#2a2a2e] px-4 py-3">
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  placeholder={
                    selectedConv.aiPaused
                      ? 'Digite sua resposta como humano…'
                      : 'Pause a Ana primeiro pra responder manualmente'
                  }
                  value={humanInput}
                  onChange={(e) => setHumanInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && selectedConv.aiPaused) void sendHumanReply()
                  }}
                  disabled={!selectedConv.aiPaused || sending}
                  className="flex-1 bg-[#27272a] text-gray-200 placeholder-gray-500 border border-[#3f3f46] rounded-md px-4 py-2 text-sm focus:outline-none focus:border-amber-500 disabled:bg-[#1c1c1f] disabled:text-gray-600 disabled:cursor-not-allowed"
                />
                <button
                  onClick={sendHumanReply}
                  disabled={!selectedConv.aiPaused || !humanInput.trim() || sending}
                  className="px-4 py-2 bg-amber-500 hover:bg-amber-600 disabled:bg-[#27272a] disabled:text-gray-600 disabled:cursor-not-allowed text-white text-sm font-medium rounded-md transition-colors"
                >
                  {sending ? '...' : 'Enviar'}
                </button>
              </div>
            </div>
          </>
        )}
      </section>

      {/* ─── COLUNA 3: Sidebar de dados ───────────────────────────────────── */}
      {selectedConv && (
        <aside className="w-80 bg-[#18181b] border-l border-[#2a2a2e] overflow-y-auto p-4 space-y-3 flex-shrink-0">
          <div className="bg-[#27272a] rounded-lg p-3">
            <h2 className="text-[11px] font-semibold uppercase text-gray-500 tracking-wide mb-2">
              Estado da conversa
            </h2>
            <span className={`text-xs px-2 py-1 rounded ${stateClass(selectedConv.state)}`}>
              {selectedConv.state}
            </span>
          </div>

          <div className="bg-[#27272a] rounded-lg p-3">
            <h2 className="text-[11px] font-semibold uppercase text-gray-500 tracking-wide mb-2">
              Dados do lead
            </h2>
            <div className="space-y-1 text-sm">
              <Field label="Nome" value={selectedConv.lead.name} />
              <Field label="Telefone" value={selectedConv.lead.phone} />
              <Field label="Cidade" value={selectedConv.lead.city} />
              <Field
                label="Conta de luz"
                value={selectedConv.lead.energyBill ? `R$ ${selectedConv.lead.energyBill}` : null}
              />
              <Field label="Tipo de imóvel" value={selectedConv.lead.propertyType} />
              <Field label="Status" value={selectedConv.lead.status} />
            </div>
          </div>

          <div className="bg-[#27272a] rounded-lg p-3">
            <h2 className="text-[11px] font-semibold uppercase text-gray-500 tracking-wide mb-2">
              Ferramentas usadas
            </h2>
            {toolsUsed.length === 0 ? (
              <p className="text-xs text-gray-600 italic">nenhuma chamada</p>
            ) : (
              <div className="flex flex-wrap gap-1">
                {toolsUsed.map((t) => (
                  <span key={t} className="text-[10px] bg-blue-900/60 text-blue-200 px-2 py-0.5 rounded">
                    {t}
                  </span>
                ))}
              </div>
            )}
          </div>

          <div className="bg-[#27272a] rounded-lg p-3">
            <h2 className="text-[11px] font-semibold uppercase text-gray-500 tracking-wide mb-2">
              Visita agendada
            </h2>
            {selectedConv.lead.scheduledAt ? (
              <div className="text-sm">
                <p className="text-gray-200">
                  {new Date(selectedConv.lead.scheduledAt).toLocaleString('pt-BR', {
                    weekday: 'long',
                    day: '2-digit',
                    month: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </p>
                <a
                  href="https://calendar.google.com/"
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs text-amber-400 hover:underline mt-1 inline-block"
                >
                  Abrir Google Calendar →
                </a>
              </div>
            ) : (
              <p className="text-xs text-gray-600 italic">nenhuma visita</p>
            )}
          </div>

          <div className="bg-[#27272a] rounded-lg p-3">
            <h2 className="text-[11px] font-semibold uppercase text-gray-500 tracking-wide mb-2">
              Métricas
            </h2>
            <div className="space-y-1 text-sm">
              <Field label="Mensagens" value={String(selectedConv.messageCount)} />
              <Field
                label="Última atividade"
                value={selectedConv.lastMessage ? formatRelativeTime(selectedConv.lastMessage.sentAt) : '—'}
              />
            </div>
          </div>
        </aside>
      )}
    </div>
  )
}

function Field({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="flex justify-between items-baseline gap-2">
      <span className="text-gray-500 text-xs">{label}</span>
      <span className="text-gray-200 text-xs font-medium text-right truncate">{value || '—'}</span>
    </div>
  )
}
