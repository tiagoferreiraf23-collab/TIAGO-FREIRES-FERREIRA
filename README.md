# SDR Solar IA — Sistema Completo de Vendas com IA

SDR (Sales Development Representative) 100% automatizado com IA para integradora de energia solar residencial. Recebe leads do Meta Ads, inicia contato via WhatsApp em menos de 5 minutos, qualifica, agenda visitas técnicas e registra tudo no CRM.

## Arquitetura

```
Meta Ads Lead → Webhook → BullMQ → Agente IA (Claude) → WhatsApp
                                         ↓
                              Google Calendar + CRM + Notificações
                                         ↓
                              Dashboard Next.js (métricas em tempo real)
```

## Stack

| Camada | Tecnologia |
|--------|-----------|
| Backend | Node.js + TypeScript + Fastify |
| IA / LLM | Anthropic Claude (claude-sonnet-4) com tool use |
| Filas | BullMQ + Redis |
| Banco de dados | PostgreSQL + Prisma ORM |
| WhatsApp | Evolution API (unofficial) |
| Agendamento | Google Calendar API |
| CRM | HubSpot API |
| Dashboard | Next.js 14 + Tailwind + Recharts |
| Infra | Docker Compose |
| Monitoring | Prometheus + Grafana |

## Início rápido

### 1. Clone e configure o ambiente

```bash
git clone <repo>
cd sdr-solar-ia
cp .env.example .env
# Edite o .env com suas chaves de API
```

### 2. Suba a infraestrutura

```bash
docker-compose up -d postgres redis evolution-api
```

### 3. Configure o banco de dados

```bash
cd apps/api
npm install
npx prisma migrate dev --name init
npx prisma db seed
```

### 4. Configure a Evolution API (WhatsApp)

```bash
# Acesse http://localhost:8080 e configure a instância
# Escaneie o QR code com o WhatsApp do número SDR
```

### 5. Inicie em desenvolvimento

```bash
# Na raiz do projeto:
npm install
npm run dev
```

A API estará em `http://localhost:3000` e o dashboard em `http://localhost:3001`.

## Configuração das integrações

### Meta Ads (Lead Ads)

1. No [Meta Business Manager](https://business.facebook.com), vá em **Configurações → Leads de anúncios → Webhooks**
2. Adicione o endpoint: `https://seudominio.com/webhooks/meta`
3. Configure o token de verificação (mesmo valor em `META_VERIFY_TOKEN`)
4. Assine ao evento `leadgen`

### Google Calendar

1. Acesse o [Google Cloud Console](https://console.cloud.google.com)
2. Crie um projeto e ative a **Google Calendar API**
3. Crie credenciais OAuth 2.0
4. Gere o refresh token rodando: `npx tsx src/scripts/google-auth.ts`
5. Configure `GOOGLE_REFRESH_TOKEN` no `.env`

### HubSpot

1. Acesse **Configurações → Integrações → Chaves de API privadas**
2. Crie uma chave com escopos: `crm.objects.contacts.write`, `crm.objects.deals.write`
3. Configure `HUBSPOT_API_KEY` no `.env`

### Evolution API (WhatsApp)

```bash
# Criar instância
curl -X POST http://localhost:8080/instance/create \
  -H "apikey: $EVOLUTION_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"instanceName": "sdr-solar", "qrcode": true}'

# Configurar webhook para receber mensagens
curl -X POST http://localhost:8080/webhook/set/sdr-solar \
  -H "apikey: $EVOLUTION_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://seudominio.com/webhooks/whatsapp", "byEvents": true, "events": ["MESSAGES_UPSERT"]}'
```

## Fluxo de conversa

```
Lead recebido → +2 min → Mensagem inicial personalizada (Claude)
      ↓
Lead responde → Claude analisa intenção → 
  INTERESSE ALTO  → Propõe agendamento imediato
  INTERESSE MÉDIO → Nurturing + benefícios + proposta de agendamento
  OBJEÇÃO         → Script específico por tipo de objeção
  NÃO QUALIFICADO → Descarta com educação
  ESCALADA        → Notifica equipe via Slack + WhatsApp
      ↓
Agendamento → Google Calendar → Lembrança 24h e 2h antes
      ↓
CRM atualizado → Equipe notificada
```

### Follow-ups automáticos (lead sem resposta)

| Tempo | Ação |
|-------|------|
| +2 horas | Follow-up 1 — gentil, diferente da primeira mensagem |
| +24 horas | Follow-up 2 — benefício específico (ex: 90% de economia) |
| +72 horas | Follow-up 3 — última tentativa, respeitosa |

## API Endpoints

```
GET  /health                              — Health check
GET  /api/leads?status=&page=&limit=      — Lista de leads
GET  /api/leads/:id                       — Detalhes do lead
GET  /api/conversations?state=            — Lista de conversas
GET  /api/conversations/:id/messages      — Histórico de mensagens
GET  /api/analytics/metrics?period=       — Métricas (today/week/month)
GET  /api/analytics/stream                — SSE em tempo real
GET  /api/consultants                     — Lista de consultores
POST /webhooks/meta                       — Webhook Meta Lead Ads
POST /webhooks/whatsapp                   — Webhook Evolution API
```

## Dashboard

Acesse `http://localhost:3001`

- **Dashboard** — KPIs em tempo real (SSE), funil de conversão
- **Leads** — Tabela paginada com filtro por status e score
- **Conversas** — Histórico completo de cada conversa com o SDR
- **Analytics** — Gráficos de funil, taxas e distribuição por período

## Métricas monitoradas

- Taxa de contato < 5 minutos
- Taxa de resposta
- Taxa de qualificação
- Taxa de agendamento
- Conversão geral (lead → visita agendada)
- Distribuição por estágio no funil

Grafana disponível em `http://localhost:3002` (admin/admin123).

## Deploy em produção

```bash
# Build completo
docker-compose up --build -d

# Ver logs
docker-compose logs -f api

# Migrations em produção
docker-compose exec api npx prisma migrate deploy
```

### Variáveis obrigatórias para produção

```
DATABASE_URL
REDIS_URL
ANTHROPIC_API_KEY
EVOLUTION_API_KEY
```

## Estrutura do projeto

```
sdr-solar-ia/
├── apps/
│   ├── api/                    # Backend Fastify + TypeScript
│   │   ├── src/
│   │   │   ├── ai/             # Agente Claude + RAG + tools
│   │   │   ├── modules/        # Leads, conversas, agendamento, CRM
│   │   │   ├── queues/         # Workers BullMQ
│   │   │   ├── webhooks/       # Meta Ads + WhatsApp
│   │   │   └── prisma/         # Schema + seed
│   │   └── prisma/
│   │       └── schema.prisma
│   └── dashboard/              # Next.js 14 + Tailwind
│       └── src/app/
│           ├── page.tsx        # Dashboard principal
│           ├── leads/          # Gestão de leads
│           ├── conversations/  # Histórico de conversas
│           └── analytics/      # Métricas e gráficos
├── packages/
│   └── shared/                 # Tipos TypeScript compartilhados
├── monitoring/
│   └── prometheus.yml
├── docker-compose.yml
└── .env.example
```

## Personalização

### Trocar o nome/persona do SDR

No `.env`:
```
SDR_NAME="Maria"
COMPANY_NAME="Solar Premium"
```

### Adicionar scripts à base de conhecimento

Execute seed customizado ou insira diretamente:
```sql
INSERT INTO "KnowledgeEntry" (id, category, question, answer, tags, embedding)
VALUES (gen_random_uuid(), 'objection', 'Minha pergunta', 'Minha resposta', ARRAY['tag1'], ARRAY[]::float[]);
```

### Adicionar consultores

```sql
INSERT INTO "Consultant" (id, name, phone, email, regions, "calendarId")
VALUES (gen_random_uuid(), 'João Silva', '5511999990003', 'joao@empresa.com', ARRAY['Zona Leste'], 'joao@empresa.com');
```

## Licença

MIT
