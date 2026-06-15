import { redirect } from 'next/navigation'

// Página antiga substituída — agora redireciona pro /inbox novo (3 colunas dark theme)
export default function ConversationsRedirect() {
  redirect('/inbox')
}
