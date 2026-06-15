import { prisma } from '../prisma/client'
import { createChildLogger } from '../logger'

const log = createChildLogger('knowledge-base')

export interface KnowledgeContext {
  relevant: Array<{ question: string; answer: string; category: string }>
  summary: string
}

/**
 * Busca contexto relevante da base de conhecimento para uma mensagem.
 * Usa busca por keywords simples (pode ser substituído por busca vetorial com embeddings).
 */
export async function retrieveContext(userMessage: string): Promise<KnowledgeContext> {
  const lowerMessage = userMessage.toLowerCase()

  const entries = await prisma.knowledgeEntry.findMany({
    where: { active: true },
    select: { category: true, question: true, answer: true, tags: true },
    take: 50,
    orderBy: { updatedAt: 'desc' },
  })

  const scored = entries
    .map((entry) => {
      let score = 0
      const tags = entry.tags.map((t) => t.toLowerCase())
      for (const tag of tags) {
        if (lowerMessage.includes(tag)) score += 2
      }
      const questionWords = entry.question.toLowerCase().split(/\s+/)
      for (const word of questionWords) {
        if (word.length > 3 && lowerMessage.includes(word)) score += 1
      }
      return { ...entry, score }
    })
    .filter((e) => e.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)

  const relevant = scored.map(({ question, answer, category }) => ({
    question,
    answer,
    category,
  }))

  const summary =
    relevant.length > 0
      ? `Contexto relevante encontrado:\n${relevant.map((r) => `[${r.category.toUpperCase()}] ${r.question}: ${r.answer}`).join('\n\n')}`
      : ''

  log.debug({ messagePreview: userMessage.slice(0, 50), foundEntries: relevant.length }, 'Knowledge base query')

  return { relevant, summary }
}

/**
 * Formata o contexto da base de conhecimento para incluir no prompt.
 */
export function formatContextForPrompt(context: KnowledgeContext): string {
  if (context.relevant.length === 0) return ''
  return `\n\n--- CONTEXTO RELEVANTE DA BASE DE CONHECIMENTO ---\n${context.summary}\n--- FIM DO CONTEXTO ---\n`
}
