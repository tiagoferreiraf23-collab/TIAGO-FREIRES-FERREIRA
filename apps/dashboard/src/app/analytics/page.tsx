'use client'

import { useEffect, useState } from 'react'
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
} from 'recharts'

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000'

const PERIODS = [
  { key: 'today', label: 'Hoje' },
  { key: 'week', label: '7 dias' },
  { key: 'month', label: '30 dias' },
] as const

interface PeriodMetrics {
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
}

const PIE_COLORS = ['#6366f1', '#8b5cf6', '#a855f7', '#f59e0b', '#10b981']

export default function AnalyticsPage() {
  const [period, setPeriod] = useState<'today' | 'week' | 'month'>('month')
  const [data, setData] = useState<PeriodMetrics | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    fetch(`${API_URL}/api/analytics/metrics?period=${period}`)
      .then((r) => r.json())
      .then((d: PeriodMetrics) => { setData(d); setLoading(false) })
      .catch(() => setLoading(false))
  }, [period])

  const funnelData = data
    ? [
        { name: 'Leads Recebidos', value: data.total },
        { name: 'Contactados', value: data.contacted },
        { name: 'Qualificados', value: data.qualified },
        { name: 'Agendados', value: data.scheduled },
        { name: 'Ganhos', value: data.won },
      ]
    : []

  const ratesData = data
    ? [
        { metric: 'Contato <5min', value: data.contactRate },
        { metric: 'Resposta', value: data.responseRate },
        { metric: 'Qualificação', value: data.qualificationRate },
        { metric: 'Agendamento', value: data.schedulingRate },
        { metric: 'Conversão geral', value: data.conversionRate },
      ]
    : []

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Analytics</h1>
          <p className="text-sm text-gray-500 mt-1">Métricas de performance do SDR Ana</p>
        </div>
        <div className="flex gap-2">
          {PERIODS.map((p) => (
            <button
              key={p.key}
              onClick={() => setPeriod(p.key)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                period === p.key
                  ? 'bg-indigo-600 text-white'
                  : 'bg-white border border-gray-200 text-gray-600 hover:bg-gray-50'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="grid grid-cols-2 gap-6">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="bg-white rounded-xl border border-gray-200 h-64 animate-pulse" />
          ))}
        </div>
      ) : data ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Funil */}
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <h2 className="text-sm font-semibold text-gray-700 mb-4">Funil de Conversão</h2>
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={funnelData} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                <XAxis type="number" tick={{ fontSize: 11 }} />
                <YAxis dataKey="name" type="category" tick={{ fontSize: 11 }} width={110} />
                <Tooltip contentStyle={{ fontSize: 12 }} />
                <Bar dataKey="value" fill="#6366f1" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* Taxas */}
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <h2 className="text-sm font-semibold text-gray-700 mb-4">Taxas de Conversão (%)</h2>
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={ratesData}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="metric" tick={{ fontSize: 10 }} />
                <YAxis tick={{ fontSize: 11 }} domain={[0, 100]} unit="%" />
                <Tooltip formatter={(v: number) => [`${v}%`, 'Taxa']} contentStyle={{ fontSize: 12 }} />
                <Bar dataKey="value" fill="#f59e0b" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* Distribuição por status */}
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <h2 className="text-sm font-semibold text-gray-700 mb-4">Distribuição por Estágio</h2>
            <ResponsiveContainer width="100%" height={260}>
              <PieChart>
                <Pie
                  data={funnelData.filter((d) => d.value > 0)}
                  dataKey="value"
                  nameKey="name"
                  cx="50%"
                  cy="50%"
                  outerRadius={90}
                  label={({ name, percent }) => `${name.split(' ')[0]} ${(percent * 100).toFixed(0)}%`}
                  labelLine={false}
                >
                  {funnelData.map((_, index) => (
                    <Cell key={index} fill={PIE_COLORS[index % PIE_COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip contentStyle={{ fontSize: 12 }} />
              </PieChart>
            </ResponsiveContainer>
          </div>

          {/* Resumo em números */}
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <h2 className="text-sm font-semibold text-gray-700 mb-4">Resumo do Período</h2>
            <div className="space-y-4">
              {[
                { label: 'Total de leads recebidos', value: data.total, unit: 'leads' },
                { label: 'Contactados em < 5 min', value: `${data.contactRate}%`, unit: `(${data.contacted} leads)` },
                { label: 'Taxa de resposta', value: `${data.responseRate}%`, unit: '' },
                { label: 'Qualificados', value: data.qualified, unit: 'leads' },
                { label: 'Visitas agendadas', value: data.scheduled, unit: 'visitas' },
                { label: 'Vendas ganhas', value: data.won, unit: 'ganhos' },
                { label: 'Conversão lead → visita', value: `${data.conversionRate}%`, unit: '' },
              ].map((row) => (
                <div key={row.label} className="flex items-center justify-between">
                  <span className="text-sm text-gray-600">{row.label}</span>
                  <span className="text-sm font-semibold text-gray-900">
                    {row.value} <span className="text-gray-400 font-normal text-xs">{row.unit}</span>
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <div className="text-center py-16 text-gray-400">Erro ao carregar métricas</div>
      )}
    </div>
  )
}
