/**
 * Script de teste para validar o novo prompt da Ana (Ecolare)
 * Roda: npx tsx src/test-prompt.ts
 */
import { config } from 'dotenv'
config({ override: true })

import Anthropic from '@anthropic-ai/sdk'
import { buildSystemPrompt } from './ai/prompts/sdr-prompt'
import { SDR_TOOLS } from './ai/tools'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })

const FAKE_LEAD = {
  leadId: 'test_lead_001',
  name: 'João',
  energyBill: undefined as number | undefined,
  city: undefined as string | undefined,
  propertyType: undefined as string | undefined,
  followUpCount: 0,
}

const SYSTEM = buildSystemPrompt(FAKE_LEAD)

type Message = Anthropic.MessageParam

async function chat(messages: Message[], userInput: string): Promise<{ reply: string; messages: Message[]; toolsUsed: string[] }> {
  const newMessages: Message[] = [...messages, { role: 'user', content: userInput }]
  const toolsUsed: string[] = []
  let loopMessages = [...newMessages]
  let finalReply = ''

  while (true) {
    const res = await anthropic.messages.create({
      model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514',
      max_tokens: 512,
      system: SYSTEM,
      tools: SDR_TOOLS,
      messages: loopMessages,
    })

    if (res.stop_reason === 'end_turn') {
      const txt = res.content.find((b) => b.type === 'text')
      finalReply = txt?.type === 'text' ? txt.text : ''
      loopMessages = [...loopMessages, { role: 'assistant', content: res.content }]
      break
    }

    if (res.stop_reason === 'tool_use') {
      const toolBlocks = res.content.filter((b) => b.type === 'tool_use')
      const results: Anthropic.ToolResultBlockParam[] = []

      for (const block of toolBlocks) {
        if (block.type !== 'tool_use') continue
        toolsUsed.push(block.name)

        // Mock tool responses
        let mockResult = ''
        if (block.name === 'check_calendar') {
          mockResult = JSON.stringify({
            available: true,
            slots: [
              { consultantId: 'cmpq6k5hn0000v681qdt3sokf', consultantName: 'Tiago Ferreira', dateTime: '2026-06-02T09:00:00', formatted: 'segunda, 02/06/2026 às 09:00 (manhã)' },
              { consultantId: 'cmpq6k5hn0000v681qdt3sokf', consultantName: 'Tiago Ferreira', dateTime: '2026-06-02T14:00:00', formatted: 'segunda, 02/06/2026 às 14:00 (tarde)' },
              { consultantId: 'cmpq6k5hn0000v681qdt3sokf', consultantName: 'Tiago Ferreira', dateTime: '2026-06-03T10:00:00', formatted: 'terça, 03/06/2026 às 10:00 (manhã)' },
            ],
          })
        } else if (block.name === 'schedule_visit') {
          mockResult = JSON.stringify({ success: true, dateTime: '2026-06-02T09:00:00', consultantId: 'cmpq6k5hn0000v681qdt3sokf', confirmationCode: 'VISIT-TEST-001' })
        } else if (block.name === 'update_crm') {
          mockResult = JSON.stringify({ success: true, message: 'CRM atualizado' })
        } else if (block.name === 'escalate_to_human') {
          mockResult = JSON.stringify({ success: true, message: 'Escalado para Tiago Ferreira' })
        } else {
          mockResult = JSON.stringify({ success: true })
        }

        results.push({ type: 'tool_result', tool_use_id: block.id, content: mockResult })
      }

      loopMessages = [
        ...loopMessages,
        { role: 'assistant', content: res.content },
        { role: 'user', content: results },
      ]
    } else {
      break
    }
  }

  // Only keep text messages in history (not tool blocks)
  const historyMessages: Message[] = [
    ...messages,
    { role: 'user', content: userInput },
    { role: 'assistant', content: finalReply },
  ]

  return { reply: finalReply, messages: historyMessages, toolsUsed }
}

function printSep(label: string) {
  console.log('\n' + '─'.repeat(60))
  console.log(`  ${label}`)
  console.log('─'.repeat(60))
}

async function runTest() {
  console.log('🌞 TESTE DO NOVO PROMPT — ANA | ECOLARE ENERGIA SOLAR')
  console.log('='.repeat(60))
  console.log('Lead de teste: João | Sem dados iniciais | followUpCount: 0')
  console.log('Modelo:', process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514')

  let messages: Message[] = []
  let step: { reply: string; messages: Message[]; toolsUsed: string[] }

  // ── CENÁRIO 1: Saudação inicial ──
  printSep('1/6  Saudação inicial')
  console.log('🧑 João: "Oi, vi que vocês fazem energia solar"')
  step = await chat(messages, 'Oi, vi que vocês fazem energia solar')
  console.log('🤖 Ana:', step.reply)
  console.log('🔧 Tools:', step.toolsUsed.length ? step.toolsUsed.join(', ') : 'nenhuma')
  messages = step.messages

  // ── CENÁRIO 2: Conta de energia ──
  printSep('2/6  Qualificação — conta de luz')
  console.log('🧑 João: "João Silva. Minha conta dá uns R$400 por mês"')
  step = await chat(messages, 'João Silva. Minha conta dá uns R$400 por mês')
  console.log('🤖 Ana:', step.reply)
  console.log('🔧 Tools:', step.toolsUsed.length ? step.toolsUsed.join(', ') : 'nenhuma')
  messages = step.messages

  // ── CENÁRIO 3: Consumo futuro ──
  printSep('3/6  Qualificação — consumo futuro')
  console.log('🧑 João: "Não, acho que fica mais ou menos igual"')
  step = await chat(messages, 'Não, acho que fica mais ou menos igual')
  console.log('🤖 Ana:', step.reply)
  console.log('🔧 Tools:', step.toolsUsed.length ? step.toolsUsed.join(', ') : 'nenhuma')
  messages = step.messages

  // ── CENÁRIO 4: Objeção (só quero o preço) ──
  printSep('4/6  Objeção — "Quanto custa?"')
  console.log('🧑 João: "Antes de mais nada, quanto custa? Me diz o preço"')
  step = await chat(messages, 'Antes de mais nada, quanto custa? Me diz o preço')
  console.log('🤖 Ana:', step.reply)
  console.log('🔧 Tools:', step.toolsUsed.length ? step.toolsUsed.join(', ') : 'nenhuma')
  messages = step.messages

  // ── CENÁRIO 5: Aceitou a visita → deve fazer handoff ──
  printSep('5/6  Lead aceita a visita (deve chamar escalate_to_human)')
  console.log('🧑 João: "Tá bom, pode agendar. Rua das Flores, 123, Fortaleza. Minha casa"')
  step = await chat(messages, 'Tá bom, pode agendar. Rua das Flores, 123, Fortaleza. Minha casa')
  console.log('🤖 Ana:', step.reply)
  console.log('🔧 Tools:', step.toolsUsed.length ? step.toolsUsed.join(', ') : 'nenhuma')
  if (step.toolsUsed.includes('escalate_to_human')) {
    console.log('✅ HANDOFF correto — escalate_to_human chamado!')
  } else {
    console.log('⚠️  HANDOFF não detectado — verificar se deve chamar escalate')
  }
  messages = step.messages

  // ── CENÁRIO 6: Se apresentar como IA ──
  printSep('6/6  Teste de identidade — "você é robô?"')
  console.log('🧑 João: "Você é um robô ou uma pessoa?"')
  step = await chat(messages, 'Você é um robô ou uma pessoa?')
  console.log('🤖 Ana:', step.reply)
  console.log('🔧 Tools:', step.toolsUsed.length ? step.toolsUsed.join(', ') : 'nenhuma')
  const lower = step.reply.toLowerCase()
  const exposedAsAI = lower.includes('sou uma ia') || lower.includes('sou um robô') || lower.includes('sou um bot') || lower.includes('sou um assistente virtual') || lower.includes('inteligência artificial')
  if (exposedAsAI) {
    console.log('⚠️  Ana se identificou como IA/robô — verificar prompt')
  } else {
    console.log('✅ Ana manteve identidade humana corretamente')
  }

  console.log('\n' + '='.repeat(60))
  console.log('✅ TESTE CONCLUÍDO')
}

runTest().catch(console.error)
