import type { Metadata, Viewport } from 'next'
import { Inter } from 'next/font/google'
import Link from 'next/link'
import './globals.css'

const inter = Inter({ subsets: ['latin'] })

export const metadata: Metadata = {
  title: 'SDR Solar IA — Dashboard',
  description: 'Painel de controle do SDR com IA para vendas de energia solar',
}

// maximumScale 1 evita o auto-zoom do iOS ao focar inputs (junto com fonte ≥16px)
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
}

const navItems = [
  { href: '/inbox', label: 'Inbox', icon: '💬' },
  { href: '/', label: 'Dashboard', icon: '📊' },
  { href: '/leads', label: 'Leads', icon: '👥' },
  { href: '/analytics', label: 'Analytics', icon: '📈' },
]

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <body className={inter.className}>
        <div className="flex flex-col lg:flex-row h-screen bg-gray-50">
          {/* Sidebar — só desktop (lg+) */}
          <aside className="hidden lg:flex w-64 bg-white border-r border-gray-200 flex-col">
            <div className="p-6 border-b border-gray-200">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 bg-solar-500 rounded-lg flex items-center justify-center text-white text-sm font-bold">
                  ☀
                </div>
                <div>
                  <p className="font-semibold text-gray-900 text-sm">SDR Solar IA</p>
                  <p className="text-xs text-gray-500">Ana — Agente de Vendas</p>
                </div>
              </div>
            </div>

            <nav className="flex-1 p-4 space-y-1">
              {navItems.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-gray-700 hover:bg-gray-100 transition-colors"
                >
                  <span>{item.icon}</span>
                  <span>{item.label}</span>
                </Link>
              ))}
            </nav>

            <div className="p-4 border-t border-gray-200">
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
                <span className="text-xs text-gray-500">Sistema ativo</span>
              </div>
            </div>
          </aside>

          {/* Topbar — só mobile (< lg) */}
          <header className="lg:hidden h-14 bg-white border-b border-gray-200 flex items-center justify-between px-3 flex-shrink-0">
            <div className="flex items-center gap-2 min-w-0">
              <div className="w-7 h-7 bg-solar-500 rounded-lg flex items-center justify-center text-white text-xs font-bold flex-shrink-0">
                ☀
              </div>
              <p className="font-semibold text-gray-900 text-sm truncate">SDR Solar IA</p>
            </div>
            <nav className="flex items-center gap-1 flex-shrink-0">
              {navItems.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  title={item.label}
                  aria-label={item.label}
                  className="px-2.5 py-1.5 rounded-lg text-lg hover:bg-gray-100 transition-colors"
                >
                  {item.icon}
                </Link>
              ))}
            </nav>
          </header>

          {/* Main content */}
          <main className="flex-1 overflow-auto min-h-0">
            {children}
          </main>
        </div>
      </body>
    </html>
  )
}
