'use client'

import { useEffect, useState } from 'react'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, LineChart, Line } from 'recharts'

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000'

interface Metrics {
  total: number
  contacted: number
  qualified: number
  scheduled: number
  won: number
  contactRate: number
  responseRate: number
  qualificationRate: number
  schedulingRate: number
  conversionRate: number
  period: string
}

interface StatCardProps {
  label: string
  value: string | number
  sub?: string
  color?: string
  trend?: 'up' | 'down' | 'neutral'
}

function StatCard({ label, value, sub, color = 'text-gray-900', trend }: StatCardProps) {
  const trendIcon = trend === 'up' ? '↑' : trend === 'down' ? '↓' : ''
  const trendColor = trend === 'up' ? 'text-green-600' : trend === 'down' ? 'text-red-500' : ''

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5">
      <p className="text-sm text-gray-500 mb-1">{label}</p>
      <p className={`text-3xl font-bold ${color}`}>{value}</p>
      {sub && (
        <p className={`text-sm mt-1 ${trendColor || 'text-gray-400'}`}>
          {trendIcon && <span className="mr-1">{trendIcon}</span>}
          {sub}
        </p>
      )}
    </div>
  )
}

const funnelData = (m: Metrics) => [
  { stage: 'Leads', value: m.total, fill: '#6366f1' },
  { stage: 'Contactados', value: m.contacted, fill: '#8b5cf6' },
  { stage: 'Qualificados', value: m.qualified, fill: '#a855f7' },
  { stage: 'Agendados', value: m.scheduled, fill: '#f59e0b' },
  { stage: 'Ganhos', value: m.won, fill: '#10b981' },
]

export default function DashboardPage() {
  const [metrics, setMetrics] = useState<Metrics | null>(null)
  const [period, setPeriod] = useState<'today' | 'week' | 'month'>('today')
  const [loading, setLoading] = useState(true)
  const [liveMetrics, setLiveMetrics] = useState<{ total: number; scheduled: number; timestamp: string } | null>(null)

  useEffect(() => {
    fetchMetrics(period)
  }, [period])

  // SSE for live updates
  useEffect(() => {
    const es = new EventSource(`${API_URL}/api/analytics/stream`)
    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data as string) as { total: number; scheduled: number; timestamp: string }
        setLiveMetrics(data)
      } catch (_) {}
    }
    es.onerror = () => es.close()
    return () => es.close()
  }, [])

  async function fetchMetrics(p: string) {
    setLoading(true)
    try {
      const res = await fetch(`${API_URL}/api/analytics/metrics?period=${p}`)
      const data = await res.json() as Metrics
      setMetrics(data)
    } catch (_) {
      // silently fail — shows stale data
    } finally {
      setLoading(false)
    }
  }

  const periodLabel = { today: 'Hoje', week: 'Esta semana', month: 'Este mês' }[period]

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Dashboard SDR</h1>
          <p className="text-sm text-gray-500 mt-1">Performance em tempo real — Ana</p>
        </div>
        <div className="flex gap-2">
          {(['today', 'week', 'month'] as const).map((p) => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                period === p
                  ? 'bg-solar-500 text-white'
                  : 'bg-white border border-gray-200 text-gray-600 hover:bg-gray-50'
              }`}
            >
              {{ today: 'Hoje', week: 'Semana', month: 'Mês' }[p]}
            </button>
          ))}
        </div>
      </div>

      {/* Live indicator */}
      {liveMetrics && (
        <div className="bg-green-50 border border-green-200 rounded-lg px-4 py-2 flex items-center gap-2 text-sm text-green-700">
          <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
          Dados ao vivo — {new Date(liveMetrics.timestamp).toLocaleTimeString('pt-BR')}
        </div>
      )}

      {/* KPI Cards */}
      {loading ? (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {[...Array(8)].map((_, i) => (
            <div key={i} className="bg-white rounded-xl border border-gray-200 p-5 h-24 animate-pulse" />
          ))}
        </div>
      ) : metrics ? (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard label="Total de Leads" value={metrics.total} sub={periodLabel} color="text-indigo-600" />
            <StatCard label="Contactados < 5min" value={`${metrics.contactRate}%`} sub={`${metrics.contacted} leads`} color="text-purple-600" trend="up" />
            <StatCard label="Agendados" value={metrics.scheduled} sub={`${metrics.schedulingRate}% dos qualificados`} color="text-solar-600" trend="up" />
            <StatCard label="Taxa de Conversão" value={`${metrics.conversionRate}%`} sub="lead → visita" color="text-emerald-600" />
          </div>

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard label="Taxa de Resposta" value={`${metrics.responseRate}%`} sub={`${metrics.contacted} responderam`} />
            <StatCard label="Qualificados" value={metrics.qualified} sub={`${metrics.qualificationRate}% dos contactados`} />
            <StatCard label="Ganhos" value={metrics.won} color="text-emerald-600" />
            <StatCard label="Em Atendimento" value={metrics.contacted - metrics.scheduled} sub="aguardando agendamento" />
          </div>

          {/* Funil de conversão */}
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <h2 className="text-base font-semibold text-gray-900 mb-4">Funil de Conversão — {periodLabel}</h2>
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={funnelData(metrics)} layout="vertical" margin={{ left: 20 }}>
                <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                <XAxis type="number" tick={{ fontSize: 12 }} />
                <YAxis dataKey="stage" type="category" tick={{ fontSize: 12 }} width={90} />
                <Tooltip
                  formatter={(value: number) => [value, 'Leads']}
                  contentStyle={{ fontSize: 12 }}
                />
                <Bar dataKey="value" radius={[0, 4, 4, 0]}>
                  {funnelData(metrics).map((entry, index) => (
                    <rect key={index} fill={entry.fill} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </>
      ) : (
        <div className="text-center py-12 text-gray-400">
          Não foi possível carregar as métricas. Verifique se a API está rodando.
        </div>
      )}
    </div>
  )
}
