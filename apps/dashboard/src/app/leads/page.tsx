'use client'

import { useEffect, useState } from 'react'

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000'

interface Lead {
  id: string
  name: string
  phone: string
  city?: string
  energyBill?: number
  status: string
  score: number
  createdAt: string
  scheduledAt?: string
  consultant?: { name: string }
  conversations: Array<{
    id: string
    state: string
    _count: { messages: number }
  }>
}

const STATUS_CONFIG: Record<string, { label: string; color: string }> = {
  NEW: { label: 'Novo', color: 'bg-gray-100 text-gray-700' },
  CONTACTED: { label: 'Contactado', color: 'bg-blue-100 text-blue-700' },
  QUALIFIED: { label: 'Qualificado', color: 'bg-purple-100 text-purple-700' },
  SCHEDULED: { label: 'Agendado', color: 'bg-solar-100 text-solar-700' },
  VISITED: { label: 'Visitado', color: 'bg-indigo-100 text-indigo-700' },
  WON: { label: 'Ganho', color: 'bg-green-100 text-green-700' },
  LOST: { label: 'Perdido', color: 'bg-red-100 text-red-700' },
  DISQUALIFIED: { label: 'Desqualificado', color: 'bg-gray-100 text-gray-500' },
}

export default function LeadsPage() {
  const [leads, setLeads] = useState<Lead[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [status, setStatus] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetchLeads()
  }, [page, status])

  async function fetchLeads() {
    setLoading(true)
    try {
      const params = new URLSearchParams({ page: page.toString(), limit: '20' })
      if (status) params.set('status', status)
      const res = await fetch(`${API_URL}/api/leads?${params}`)
      const data = await res.json() as { data: Lead[]; total: number }
      setLeads(data.data)
      setTotal(data.total)
    } catch (_) {} finally {
      setLoading(false)
    }
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Leads</h1>
          <p className="text-sm text-gray-500 mt-1">{total} leads no total</p>
        </div>
        <select
          value={status}
          onChange={(e) => { setStatus(e.target.value); setPage(1) }}
          className="border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white"
        >
          <option value="">Todos os status</option>
          {Object.entries(STATUS_CONFIG).map(([key, { label }]) => (
            <option key={key} value={key}>{label}</option>
          ))}
        </select>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100 bg-gray-50">
              <th className="text-left px-4 py-3 font-medium text-gray-500">Lead</th>
              <th className="text-left px-4 py-3 font-medium text-gray-500">Cidade</th>
              <th className="text-left px-4 py-3 font-medium text-gray-500">Conta</th>
              <th className="text-left px-4 py-3 font-medium text-gray-500">Score</th>
              <th className="text-left px-4 py-3 font-medium text-gray-500">Status</th>
              <th className="text-left px-4 py-3 font-medium text-gray-500">Msgs</th>
              <th className="text-left px-4 py-3 font-medium text-gray-500">Criado</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {loading ? (
              [...Array(10)].map((_, i) => (
                <tr key={i}>
                  {[...Array(7)].map((_, j) => (
                    <td key={j} className="px-4 py-3">
                      <div className="h-4 bg-gray-100 rounded animate-pulse" />
                    </td>
                  ))}
                </tr>
              ))
            ) : leads.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-12 text-center text-gray-400">
                  Nenhum lead encontrado
                </td>
              </tr>
            ) : (
              leads.map((lead) => {
                const cfg = STATUS_CONFIG[lead.status] ?? { label: lead.status, color: 'bg-gray-100 text-gray-700' }
                const msgs = lead.conversations.reduce((s, c) => s + c._count.messages, 0)
                return (
                  <tr key={lead.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3">
                      <p className="font-medium text-gray-900">{lead.name}</p>
                      <p className="text-gray-400 text-xs">{lead.phone}</p>
                    </td>
                    <td className="px-4 py-3 text-gray-600">{lead.city ?? '—'}</td>
                    <td className="px-4 py-3 text-gray-600">
                      {lead.energyBill ? `R$${lead.energyBill.toLocaleString('pt-BR')}` : '—'}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <div className="w-16 h-1.5 bg-gray-100 rounded-full">
                          <div
                            className="h-1.5 bg-solar-500 rounded-full"
                            style={{ width: `${lead.score}%` }}
                          />
                        </div>
                        <span className="text-xs text-gray-500">{lead.score}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${cfg.color}`}>
                        {cfg.label}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-600">{msgs}</td>
                    <td className="px-4 py-3 text-gray-400 text-xs">
                      {new Date(lead.createdAt).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>

        {/* Pagination */}
        {total > 20 && (
          <div className="px-4 py-3 border-t border-gray-100 flex items-center justify-between">
            <p className="text-sm text-gray-500">
              Mostrando {((page - 1) * 20) + 1}–{Math.min(page * 20, total)} de {total}
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page === 1}
                className="px-3 py-1 text-sm border border-gray-200 rounded-lg disabled:opacity-40 hover:bg-gray-50"
              >
                Anterior
              </button>
              <button
                onClick={() => setPage((p) => p + 1)}
                disabled={page * 20 >= total}
                className="px-3 py-1 text-sm border border-gray-200 rounded-lg disabled:opacity-40 hover:bg-gray-50"
              >
                Próxima
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
