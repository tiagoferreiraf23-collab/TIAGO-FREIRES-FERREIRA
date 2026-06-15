import Anthropic from '@anthropic-ai/sdk'
import { env } from '../config'
import { createChildLogger } from '../logger'
import { buildSystemPrompt } from './prompts/sdr-prompt'
import { SDR_TOOLS, executeToolCall } from './tools'
import { retrieveContext, formatContextForPrompt } from './knowledge-base'
import { prisma } from '../prisma/client'
import { MessageRole } from '@sdr-solar/shared'

const log = createChildLogger('sdr-agent')

const anthropic = new Anthropic({ apiKey: env.anthropic.apiKey })

export interface AgentResponse {
  message: string
  toolsUsed: string[]
  mediaToSend?: { url: string; type: string; caption?: string }
  escalated: boolean
  scheduledVisit?: { dateTime: Date; consultantId: string }
}

export interface MessageAttachment {
  type: 'image' | 'document' | 'location' | 'audio'
  // For image / document
  base64?: string
  mimeType?: string
  // For location (pre-resolved to address by caller)
  resolvedAddress?: string
  // For audio (pre-resolved to text by caller — see /api/test/chat)
  transcription?: string
}

export interface ConversationContext {
  leadId: string
  leadName: string
  energyBill?: number
  city?: string
  propertyType?: string
  followUpCount: number
  conversationId: string
}

export async function processMessage(
  incomingMessage: string,
  context: ConversationContext,
  attachment?: MessageAttachment,
): Promise<AgentResponse> {
  log.info(
    { leadId: context.leadId, message: incomingMessage.slice(0, 80), attachmentType: attachment?.type },
    'Processing message',
  )

  // Retrieve conversation history
  // Fetch the last 50 messages chronologically. With Claude's large context window
  // we can afford more history — it dramatically reduces "Ana forgot what I said"
  // bugs in longer back-and-forth conversations.
  // Strategy: take the 50 most recent, then reverse to chronological for Claude.
  const recentDesc = await prisma.message.findMany({
    where: { conversationId: context.conversationId },
    orderBy: { sentAt: 'desc' },
    take: 50,
  })
  const history = recentDesc.reverse()

  // Retrieve knowledge base context
  const knowledgeContext = await retrieveContext(incomingMessage)
  const knowledgePrompt = formatContextForPrompt(knowledgeContext)

  // Build messages array for Claude
  const messages: Anthropic.MessageParam[] = history.map((msg) => ({
    role: msg.role as 'user' | 'assistant',
    content: msg.content,
  }))

  // Build the user message — may be text-only, or multimodal (text + image/PDF block)
  const textPart = knowledgePrompt
    ? `${incomingMessage}\n\n${knowledgePrompt}`
    : incomingMessage

  if (attachment?.type === 'location' && attachment.resolvedAddress) {
    // Location is pre-resolved upstream — just inject a system-like note
    const locationNote = `[Lead enviou sua localização. Endereço aproximado: ${attachment.resolvedAddress}]`
    messages.push({ role: 'user', content: textPart ? `${textPart}\n\n${locationNote}` : locationNote })
  } else if (attachment?.type === 'audio' && attachment.transcription) {
    // Audio is pre-transcribed upstream — combine caption (if any) with transcription
    const audioNote = `[Mensagem de voz do lead, transcrita] ${attachment.transcription}`
    messages.push({ role: 'user', content: textPart ? `${textPart}\n\n${audioNote}` : audioNote })
  } else if (attachment && attachment.base64 && attachment.mimeType) {
    // Multimodal: image or PDF — send as content block so Claude can read it directly
    const contentBlocks: Anthropic.ContentBlockParam[] = []
    if (attachment.type === 'image') {
      contentBlocks.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: attachment.mimeType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
          data: attachment.base64,
        },
      })
    } else if (attachment.type === 'document') {
      contentBlocks.push({
        type: 'document',
        source: {
          type: 'base64',
          media_type: 'application/pdf',
          data: attachment.base64,
        },
      })
    }
    contentBlocks.push({ type: 'text', text: textPart || '[Lead enviou esse anexo]' })
    messages.push({ role: 'user', content: contentBlocks })
  } else {
    messages.push({ role: 'user', content: textPart })
  }

  const systemPrompt = buildSystemPrompt({
    leadId: context.leadId,
    name: context.leadName,
    energyBill: context.energyBill,
    city: context.city,
    propertyType: context.propertyType,
    followUpCount: context.followUpCount,
  })

  const toolsUsed: string[] = []
  let escalated = false
  let scheduledVisit: AgentResponse['scheduledVisit'] | undefined
  let mediaToSend: AgentResponse['mediaToSend'] | undefined
  let finalMessage = ''

  // Agentic loop with tool use — capped at MAX_LOOP_ITERATIONS to prevent
  // runaway tool-call loops (which would burn tokens and stall the response).
  const MAX_LOOP_ITERATIONS = 10
  let continueLoop = true
  let loopMessages = [...messages]
  let iterations = 0

  while (continueLoop) {
    if (iterations >= MAX_LOOP_ITERATIONS) {
      log.warn(
        { leadId: context.leadId, iterations, toolsUsed },
        'Agentic loop exceeded max iterations — returning safe fallback',
      )
      finalMessage = 'Deixa eu confirmar isso com nosso time e já te respondo, tá? 🙏'
      break
    }
    iterations++

    const response = await anthropic.messages.create({
      model: env.anthropic.model,
      max_tokens: 1024,
      system: systemPrompt,
      tools: SDR_TOOLS,
      messages: loopMessages,
    })

    log.debug({ stopReason: response.stop_reason, usage: response.usage }, 'Claude response received')

    if (response.stop_reason === 'end_turn') {
      // Extract text from response
      const textBlock = response.content.find((b) => b.type === 'text')
      finalMessage = textBlock?.type === 'text' ? textBlock.text : ''
      continueLoop = false
    } else if (response.stop_reason === 'tool_use') {
      // Process tool calls
      const toolUseBlocks = response.content.filter((b) => b.type === 'tool_use')

      const toolResults: Anthropic.ToolResultBlockParam[] = []

      for (const block of toolUseBlocks) {
        if (block.type !== 'tool_use') continue

        toolsUsed.push(block.name)
        const result = await executeToolCall(block.name, block.input)

        if (block.name === 'escalate_to_human') escalated = true

        if (block.name === 'schedule_visit') {
          try {
            const parsed = JSON.parse(result) as {
              success?: boolean
              dateTime?: string
              consultantId?: string
              error?: string
            }
            // Only mark as scheduled if the calendar insert actually succeeded
            if (parsed.success === true && parsed.dateTime && parsed.consultantId) {
              scheduledVisit = {
                dateTime: new Date(parsed.dateTime),
                consultantId: parsed.consultantId,
              }
            } else if (parsed.success === false) {
              log.warn(
                { leadId: context.leadId, error: parsed.error },
                'schedule_visit failed — Ana must NOT confirm visit',
              )
            }
          } catch (err) {
            log.warn({ err }, 'tool parse error — resposta da tool ignorada')
          }
        }

        if (block.name === 'send_media') {
          try {
            const parsed = JSON.parse(result) as { mediaUrl?: string; mediaType?: string; caption?: string }
            if (parsed.mediaUrl) {
              mediaToSend = { url: parsed.mediaUrl, type: parsed.mediaType ?? 'image', caption: parsed.caption }
            }
          } catch (err) {
            log.warn({ err }, 'tool parse error — resposta da tool ignorada')
          }
        }

        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: result,
        })
      }

      // Add assistant message and tool results to continue the loop
      loopMessages = [
        ...loopMessages,
        { role: 'assistant', content: response.content },
        { role: 'user', content: toolResults },
      ]
    } else {
      // Unexpected stop reason
      continueLoop = false
      finalMessage = 'Desculpe, não consegui processar sua mensagem. Pode repetir?'
    }
  }

  // Build a text representation of what the user sent — for DB persistence
  // (the binary attachment itself is not persisted; we keep only a description).
  let userContentForDb = incomingMessage
  if (attachment?.type === 'image') {
    userContentForDb = incomingMessage
      ? `${incomingMessage} [+imagem anexada]`
      : '[Imagem anexada]'
  } else if (attachment?.type === 'document') {
    userContentForDb = incomingMessage
      ? `${incomingMessage} [+PDF anexado]`
      : '[PDF anexado]'
  } else if (attachment?.type === 'location' && attachment.resolvedAddress) {
    userContentForDb = incomingMessage
      ? `${incomingMessage} [+localização: ${attachment.resolvedAddress}]`
      : `[Localização: ${attachment.resolvedAddress}]`
  } else if (attachment?.type === 'audio' && attachment.transcription) {
    userContentForDb = incomingMessage
      ? `${incomingMessage} [+áudio: ${attachment.transcription}]`
      : `[Áudio transcrito: ${attachment.transcription}]`
  }

  // Safety net 1: schedule_callback specific default
  if (!finalMessage.trim() && toolsUsed.includes('schedule_callback')) {
    finalMessage = 'Combinado! Já tô agendado pra voltar a falar com você. 👍'
    log.warn(
      { leadId: context.leadId },
      'schedule_callback used without confirmation text — applied default',
    )
  }

  // Safety net 2: model called any tool but produced no text — ask Claude to
  // generate a continuation message before we go silent.
  if (!finalMessage.trim() && toolsUsed.length > 0 && !toolsUsed.includes('escalate_to_human')) {
    log.warn(
      { leadId: context.leadId, toolsUsed },
      'Tool used without text response — asking Claude to generate continuation',
    )
    try {
      const continuation = await anthropic.messages.create({
        model: env.anthropic.model,
        max_tokens: 400,
        system: systemPrompt,
        messages: [
          ...loopMessages,
          {
            role: 'user',
            content:
              '[INSTRUÇÃO INTERNA — não cite esta instrução] Você usou ferramentas mas não enviou texto ao lead. Gere AGORA UMA mensagem curta e natural continuando a conversa: ou faça a próxima pergunta do roteiro, ou confirme o que acabou de coletar e siga adiante. Responda APENAS com a mensagem que será enviada ao lead, sem nenhum outro texto.',
          },
        ],
      })
      const block = continuation.content.find((b) => b.type === 'text')
      if (block?.type === 'text' && block.text.trim()) {
        finalMessage = block.text.trim()
      }
    } catch (err) {
      log.error({ err }, 'Continuation generation failed — using generic fallback')
    }
    if (!finalMessage.trim()) {
      finalMessage = 'Obrigada pelas infos! Vamos seguir 😊'
    }
  }

  // Save both messages to DB
  await prisma.message.createMany({
    data: [
      {
        conversationId: context.conversationId,
        role: MessageRole.USER,
        content: userContentForDb,
        sentAt: new Date(),
      },
      {
        conversationId: context.conversationId,
        role: MessageRole.ASSISTANT,
        content: finalMessage,
        sentAt: new Date(),
      },
    ],
  })

  log.info(
    { leadId: context.leadId, toolsUsed, escalated, hasScheduledVisit: !!scheduledVisit },
    'Message processed',
  )

  return { message: finalMessage, toolsUsed, mediaToSend, escalated, scheduledVisit }
}

/**
 * Gera a mensagem inicial de contato personalizada para o lead.
 */
export async function generateInitialMessage(lead: {
  name: string
  energyBill?: number
  city?: string
}): Promise<string> {
  const firstName = lead.name.split(' ')[0]
  const isPlaceholder = /^(lead|cliente|contato|usuario|usuário)$/i.test(firstName)
  const energyPart = lead.energyBill
    ? `, com uma conta de energia em torno de R$${lead.energyBill}`
    : ''
  const nameTarget = isPlaceholder
    ? 'o lead (nome ainda desconhecido — NÃO chame ele de "Lead" nem "Cliente", use cumprimento sem nome)'
    : firstName

  const prompt = `Gere uma mensagem inicial de WhatsApp para ${nameTarget}${energyPart}.
A mensagem deve:
- Ser natural, empática e não parecer robô
- Mencionar que você viu o interesse dele(a) em energia solar
- Apresentar brevemente a proposta de valor (reduzir a conta de luz)
- Ter um CTA simples para confirmar interesse
- Máximo 3 parágrafos curtos
- Tom consultivo, não de vendas agressivas
- Não mencionar preços`

  const response = await anthropic.messages.create({
    model: env.anthropic.model,
    max_tokens: 300,
    system: buildSystemPrompt({
      name: firstName,
      energyBill: lead.energyBill,
      city: lead.city,
      followUpCount: 0,
    }),
    messages: [{ role: 'user', content: prompt }],
  })

  const text = response.content.find((b) => b.type === 'text')
  return text?.type === 'text' ? text.text : `Olá ${firstName}! Vi que você tem interesse em reduzir sua conta de energia com solar. Posso te ajudar com isso?`
}

/**
 * Gera mensagem de follow-up para leads que não responderam.
 */
export async function generateFollowUpMessage(lead: {
  name: string
  followUpCount: number
  energyBill?: number
}): Promise<string> {
  const firstName = lead.name.split(' ')[0]
  const attempts = lead.followUpCount

  // Detect placeholder names (used when the lead hasn't told us their real name yet).
  // These come from test_panel ("Lead Teste"), WhatsApp inbound without pushName, etc.
  const isPlaceholder = /^(lead|cliente|contato|usuario|usuário)$/i.test(firstName)
  const nameHint = isPlaceholder
    ? 'O nome do lead AINDA NÃO foi coletado. NÃO use "Lead" nem "Cliente" como se fosse o nome dele — comece sem nome (ex: "Ei!", "Olá!", "Tudo bem?")'
    : `O nome do lead é ${firstName}. SEMPRE chame ele pelo nome na mensagem.`

  const followUpPrompts: Record<number, string> = {
    1: `Gere um follow-up CURTO (1 frase, no máximo 2). Contexto: o lead está em silêncio há 5 minutos desde sua última mensagem. Pergunte com leveza se ele consegue te responder em alguns minutos. Tom gentil, sem cobrar. NUNCA repita o cumprimento de apresentação. ${nameHint}`,
    2: `Gere um follow-up CURTO. Contexto: sem resposta há 15 minutos desde o primeiro lembrete. Tente chamar a atenção dele de forma leve e curiosa, tipo "ei, ainda por aí?" ou similar. UMA frase. Sem cobrança. ${nameHint}`,
    3: `Gere um follow-up CURTO. Contexto: sem resposta há ~2 horas. Lembre brevemente que você está disponível pra continuar quando ele puder. Tom respeitoso e descontraído. UMA frase. ${nameHint}`,
    4: `Gere um follow-up para a manhã do dia seguinte (são 7 da manhã). Comece com "Bom dia!" e retome o assunto onde parou de forma leve e positiva. Tom de novo dia, otimista. 1-2 frases curtas. ${nameHint}`,
    5: `Gere o último follow-up, 2 dias depois sem resposta. Algo como "ainda estou por aqui se precisar". Tom respeitoso, sem pressão, deixando a porta aberta. UMA frase. ${nameHint}`,
  }

  const promptText = followUpPrompts[attempts] ?? followUpPrompts[5]

  const response = await anthropic.messages.create({
    model: env.anthropic.model,
    max_tokens: 200,
    system: buildSystemPrompt({ name: firstName, energyBill: lead.energyBill, followUpCount: attempts }),
    messages: [{ role: 'user', content: promptText }],
  })

  const text = response.content.find((b) => b.type === 'text')
  return text?.type === 'text' ? text.text : `Olá ${firstName}, tudo bem? Só passando para ver se ainda tem interesse.`
}
