# 🚀 Guia de Deploy — SDR Solar Ana (Railway)

Este guia leva o projeto do seu PC pra produção em Railway. Tempo total: **~2-3 horas** depois que você tem o domínio e o Meta aprovado.

---

## 📋 Pré-requisitos (faça ANTES do deploy)

- [ ] Conta no Railway: https://railway.app (signup com GitHub)
- [ ] Conta no GitHub: pra subir o código (Railway puxa de lá)
- [ ] Domínio comprado e ativo (ex: `ecolare.com.br`)
- [ ] WhatsApp Cloud API aprovado pela Meta com:
  - Phone Number ID
  - WABA ID
  - Token permanente (não o de 24h)
- [ ] Sua chave da OpenAI funcionando
- [ ] Sua chave do Google Maps habilitada
- [ ] Refresh token do Google Calendar válido

---

## 🪜 Passo 1 — Subir o código pro GitHub

```bash
# Na raiz do projeto
cd sdr-solar-ia
git init
git add .
git commit -m "Production-ready commit"

# Crie um repositório no github.com (privado!) e:
git branch -M main
git remote add origin https://github.com/SEU_USUARIO/sdr-solar-ana.git
git push -u origin main
```

**Importante:** o repositório deve ser **PRIVADO** — tem credenciais no `.env` que mesmo apagadas ficam no histórico do git.

---

## 🪜 Passo 2 — Criar projeto no Railway

1. Acesse https://railway.app/new
2. Clique em **"Deploy from GitHub repo"**
3. Autorize o Railway a acessar seu GitHub
4. Selecione `sdr-solar-ana`
5. Railway começa o build automaticamente

Aguarde ~3-5 minutos. O primeiro build é mais lento.

---

## 🪜 Passo 3 — Adicionar Postgres e Redis (plugins)

No projeto Railway:

1. Clique em **"+ New"** → **"Database"** → **"Add PostgreSQL"**
2. Clique em **"+ New"** → **"Database"** → **"Add Redis"**

Railway cria as variáveis `DATABASE_URL` e `REDIS_URL` automaticamente e injeta na sua API.

---

## 🪜 Passo 4 — Configurar variáveis de ambiente

No serviço da **API** (não no Postgres/Redis):

1. Clique no serviço → aba **"Variables"**
2. Clique em **"Raw Editor"**
3. Cole o conteúdo do arquivo `apps/api/.env.production.example`
4. **Substitua todos os `PLACEHOLDER`** pelos valores reais:
   - `ANTHROPIC_API_KEY` (a mesma do `.env` local)
   - `OPENAI_API_KEY` (mesma do local)
   - `META_CLOUD_*` (vêm da dashboard Meta)
   - `META_VERIFY_TOKEN` (escolha uma string aleatória — você usará no setup do webhook)
   - `META_APP_SECRET` (vem da Meta)
   - `GOOGLE_*` (mesmas do local)
   - `GOOGLE_REDIRECT_URI` → mude pra `https://SEU_DOMINIO/auth/google/callback`
5. **NÃO** adicione `DATABASE_URL` nem `REDIS_URL` — são injetadas automaticamente.

Clique em **"Update Variables"**. O Railway redeploy automaticamente.

---

## 🪜 Passo 5 — Configurar domínio

No serviço da API:

1. Aba **"Settings"** → role até **"Networking"**
2. Clique em **"Generate Domain"** — pega uma URL provisória tipo `xxx.up.railway.app` pra testar
3. Quando confirmar que está OK, clique em **"+ Custom Domain"**
4. Digite `api.ecolare.com.br` (ou outro subdomínio)
5. Railway mostra um registro **CNAME** pra você adicionar no seu provedor DNS

### No Registro.br (se você comprou lá):

1. Painel do domínio → **Editar Zona DNS**
2. Adicione:
   ```
   Tipo:  CNAME
   Nome:  api
   Valor: xxx.up.railway.app   (o que o Railway mostrou)
   TTL:   3600
   ```
3. Salve. Em 5-30 minutos o DNS propaga.

Railway emite certificado HTTPS automaticamente (Let's Encrypt).

---

## 🪜 Passo 6 — Reautorizar Google Calendar em produção

O `GOOGLE_REFRESH_TOKEN` que você usa local **NÃO funciona** em produção (porque o `redirect_uri` é diferente).

1. Acesse: `https://api.ecolare.com.br/auth/google`
2. Faça login com a conta do calendário do Tiago
3. Copie o `GOOGLE_REFRESH_TOKEN` que aparecer
4. Volte no Railway → Variables → substitua o `GOOGLE_REFRESH_TOKEN`
5. Antes disso, vá no **Google Cloud Console** → APIs e serviços → Credenciais → clique no Client ID OAuth → adicione **`https://api.ecolare.com.br/auth/google/callback`** em "URIs de redirecionamento autorizados"

---

## 🪜 Passo 7 — Configurar webhook na Meta

Na dashboard do app Meta:

1. **WhatsApp** → **Configuração** → seção **"Webhook"**
2. Clique em **"Editar"**
3. **URL de retorno:** `https://api.ecolare.com.br/webhooks/whatsapp`
4. **Token de verificação:** o valor que você setou em `META_VERIFY_TOKEN`
5. Clique em **"Verificar e salvar"** — Meta faz GET no seu webhook agora
6. Em **"Campos de webhook"** → assine `messages` e `message_status`

---

## 🪜 Passo 8 — Smoke test

```bash
# Health check
curl https://api.ecolare.com.br/health

# Status do WhatsApp (deve mostrar "open" se tudo OK)
curl https://api.ecolare.com.br/api/whatsapp/status
```

Mande mensagem pro número da Ana de outro celular. Verifique nos logs do Railway que:
- Webhook chegou
- AI processou
- Resposta foi enviada (`messageId` retornado)

---

## 🪜 Passo 9 — Configurar opcional: Sentry pra erros

1. Crie conta gratuita em https://sentry.io
2. Crie um projeto "Node.js"
3. Copie o DSN
4. Cole em `SENTRY_DSN` no Railway

(A integração no código ainda é placeholder — vou implementar quando você confirmar o DSN.)

---

## 🪜 Passo 10 — Configurar opcional: Slack notifications

1. https://api.slack.com/apps → **"Create New App"** → **"From scratch"**
2. **"Incoming Webhooks"** → ative → **"Add New Webhook to Workspace"**
3. Escolha um canal (ex: `#sdr-solar`)
4. Copie a URL → cole em `SLACK_WEBHOOK_URL` no Railway

A partir daí, escalações e visitas agendadas notificam o time.

---

## 💾 Backup do banco (faça ISSO assim que estiver em produção)

Railway tem backup diário gratuito do Postgres. Pra confirmar:

1. Vá no serviço Postgres → **"Settings"**
2. Confirme que **"Daily Backups"** está ativado

Pra backup manual em arquivo:
```bash
# Pega DATABASE_URL nas Variables do Railway Postgres
pg_dump "postgresql://..." > backup-$(date +%Y%m%d).sql
```

---

## 🩺 Monitoramento

- **Logs em tempo real:** Railway → serviço → aba **"Deployments"** → clique no deploy ativo → **"View Logs"**
- **Uptime:** https://uptimerobot.com/dashboard → adicione `https://api.ecolare.com.br/health` (free tier monitora cada 5 min)
- **Métricas:** Railway mostra CPU/RAM/network direto no painel

---

## 🚨 Quando algo dá errado

| Sintoma | Verificar |
|---------|-----------|
| Build falha | Logs do build no Railway → erro comum: variável faltando |
| API retorna 502 | `DATABASE_URL` faltando ou Postgres não conectado |
| Webhook Meta falha verificação | `META_VERIFY_TOKEN` diferente do que você digitou na Meta |
| Mensagens não chegam | Veja status no `/api/whatsapp/status` + logs de "Failed to send" |
| Calendário "lotado" | Token Google expirado — visite `/auth/google` de novo |
| OpenAI 401 | Chave revogada ou créditos zerados — confira em platform.openai.com |

---

## 📞 Quando o deploy estiver pronto

Me avise pra:
1. Testarmos juntos com 1 número real
2. Ajustarmos algo que ainda não esteja funcionando
3. Configurarmos integrações que ficaram pra depois (HubSpot, etc.)

Boa! 🚀
