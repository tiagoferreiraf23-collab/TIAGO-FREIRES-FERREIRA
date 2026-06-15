import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  console.log('Seeding database...')

  // ─── Remover consultores de exemplo antigos ────────────────────────────────
  await prisma.consultant.deleteMany({
    where: {
      email: { in: ['carlos@solarenergia.com', 'ana@solarenergia.com'] },
    },
  })

  // ─── Consultor real — Tiago Ferreira / Ecolare Solar ─────────────────────
  await prisma.consultant.upsert({
    where: { email: 'tiago.ferreiraf23@gmail.com' },
    update: {
      name: 'Tiago Ferreira',
      phone: '5588998032895',
      regions: ['Fortaleza', 'Ceará', 'CE', 'Todas as regiões do Ceará'],
      calendarId: '30342ac2599ff4afd63a580f267d2e200518e056917233dd55d6dceb6afa56cc@group.calendar.google.com',
      active: true,
    },
    create: {
      name: 'Tiago Ferreira',
      phone: '5588998032895',
      email: 'tiago.ferreiraf23@gmail.com',
      regions: ['Fortaleza', 'Ceará', 'CE', 'Todas as regiões do Ceará'],
      calendarId: '30342ac2599ff4afd63a580f267d2e200518e056917233dd55d6dceb6afa56cc@group.calendar.google.com',
      active: true,
    },
  })

  console.log('✅ Consultor Tiago Ferreira cadastrado.')

  // ─── Base de conhecimento (upsert por pergunta para evitar duplicatas) ────
  const knowledgeEntries = [
    {
      category: 'faq',
      question: 'Qual o custo de um sistema solar?',
      answer:
        'O custo varia conforme o tamanho do telhado e o consumo da residência. A Ecolare faz primeiro uma análise das imagens de satélite do telhado (para isso pedimos o endereço completo), e depois uma visita técnica gratuita para dimensionar o sistema ideal e apresentar uma proposta personalizada.',
      tags: ['preco', 'custo', 'quanto custa'],
    },
    {
      category: 'faq',
      question: 'A visita técnica tem custo?',
      answer:
        'Não! A visita técnica é completamente gratuita e sem compromisso. Nossa equipe vai até sua casa, analisa seu consumo e apresenta uma proposta personalizada.',
      tags: ['visita', 'gratuita', 'custo'],
    },
    {
      category: 'objection',
      question: 'Minha casa é alugada',
      answer:
        'Entendo! Nesse caso, a instalação dependeria de autorização do proprietário. Mas posso perguntar: você tem algum imóvel próprio onde poderia instalar? Ou conhece alguém que poderia se beneficiar?',
      tags: ['aluguel', 'alugada', 'locatario'],
    },
    {
      category: 'objection',
      question: 'Não tenho interesse',
      answer:
        'Tudo bem! Posso perguntar o motivo? Às vezes tenho informações que podem mudar a perspectiva. Muitos clientes não sabiam que é possível zerar a conta de luz pagando menos do que pagam hoje de energia.',
      tags: ['nao interesse', 'sem interesse', 'nao quero'],
    },
    {
      category: 'objection',
      question: 'Quanto custa? Me passa um preço',
      answer:
        'Boa pergunta! O valor depende do seu consumo específico — um sistema para quem paga R$200 é bem diferente de quem paga R$1.000. Por isso fazemos uma visita técnica gratuita: aí consigo te passar um valor exato e mostrar o retorno do investimento.',
      tags: ['preco', 'valor', 'quanto'],
    },
    {
      category: 'objection',
      question: 'Me manda um email / informações por email',
      answer:
        'Claro, posso te mandar um material! Mas o WhatsApp é mais rápido para esclarecer dúvidas. Para uma proposta precisa, precisamos de uma visita técnica — que é gratuita! Que tal agendarmos e você decide depois?',
      tags: ['email', 'manda email', 'informacoes'],
    },
    {
      category: 'product',
      question: 'Como funciona a energia solar?',
      answer:
        'Os painéis solares captam a luz do sol e a transformam em energia elétrica. Essa energia abastece sua casa durante o dia, e o excedente é injetado na rede elétrica gerando créditos que você usa à noite. Com isso, a conta de luz pode cair até 95%!',
      tags: ['como funciona', 'energia solar', 'paineis'],
    },
    {
      category: 'product',
      question: 'Funciona em dias nublados?',
      answer:
        'Sim! Os painéis produzem energia mesmo em dias nublados, com cerca de 10-30% da capacidade máxima. E os créditos acumulados nos dias ensolarados compensam os dias com menos sol.',
      tags: ['nublado', 'chuva', 'nuvem'],
    },
    {
      category: 'objection',
      question: 'Tenho medo de danificar o telhado',
      answer:
        'Entendemos! Os painéis modernos pesam entre 11 e 13 kg por metro quadrado e usam fixações especiais que não perfuram a telha. Oferecemos garantia de 10 anos contra qualquer dano estrutural causado pela instalação. A visita técnica avalia o telhado antes de qualquer decisão.',
      tags: ['telhado', 'dano', 'danificar', 'peso', 'colonial', 'telha'],
    },
    {
      category: 'objection',
      question: 'E se eu vender a casa? O que acontece com o contrato?',
      answer:
        'O contrato é transferível para o comprador do imóvel. Além disso, imóveis com sistema solar instalado são avaliados em média 4% a mais no mercado. Ou seja, o solar pode ser um diferencial positivo na hora da venda.',
      tags: ['vender', 'venda', 'imóvel', 'casa', 'transferir', 'contrato'],
    },
    {
      category: 'objection',
      question: 'Vou virar refém da empresa? O contrato é eterno?',
      answer:
        'Não! O contrato tem prazo definido e cláusula de rescisão prevista. Não é perpétuo. E como mencionado, pode ser transferido se você vender o imóvel. Nosso consultor explica todos os termos detalhadamente na visita, antes de qualquer assinatura.',
      tags: ['refém', 'preso', 'contrato', 'prazo', 'rescisão', 'sair'],
    },
    {
      category: 'case_study',
      question: 'Tem algum exemplo real de cliente que economizou?',
      answer:
        'Sim! Um cliente em Fortaleza pagava R$540/mês de energia. Após a instalação, a conta caiu para R$95/mês. Ele paga uma taxa mensal de R$210 — saldo positivo de R$235 todo mês desde o segundo mês de instalação. Em outro caso no Ceará, um cliente com conta de R$800 reduziu para R$120 e tem saldo mensal de R$380.',
      tags: ['exemplo', 'caso', 'cliente', 'economia', 'resultado', 'real'],
    },
    {
      category: 'objection',
      question: 'Por que pagar mensalidade se posso comprar o sistema de uma vez?',
      answer:
        'Boa comparação! A Ecolare trabalha com várias formas de pagamento — as principais são à vista, cartão de crédito em até 24x e financiamento próprio em até 120 meses. À vista o sistema é seu desde o início, mas exige capital imobilizado e os custos de manutenção/substituição de inversor ficam por sua conta. No financiamento da Ecolare: R$0 de entrada, manutenção, monitoramento 24h e garantia total inclusos. Qual modalidade combina mais com seu momento financeiro?',
      tags: ['comprar', 'compra', 'financiar', 'mensalidade', 'entrada', 'concorrente', 'mais barato', 'preço'],
    },
    {
      category: 'faq',
      question: 'Quais as formas de pagamento da Ecolare?',
      answer:
        'A Ecolare tem várias formas de pagamento flexíveis. As principais são: à vista, cartão de crédito em até 24x e financiamento próprio em até 120 meses (sem precisar de banco, com manutenção e monitoramento inclusos). Na visita o engenheiro detalha cada opção e outras condições que podem ser combinadas pro seu caso.',
      tags: ['pagamento', 'formas', 'pagar', 'financiamento', 'cartão', 'avista', 'à vista', 'parcelar', 'parcela', '24x', 'modalidade'],
    },
    {
      category: 'objection',
      question: 'Qual a degradação dos painéis ao longo dos anos?',
      answer:
        'Os painéis modernos degradam cerca de 0,5% ao ano — no décimo ano ainda produzem 95% da capacidade original. Vêm com garantia de performance de 25 anos. Nosso consultor mostra a curva de produção projetada para todo o período na visita técnica.',
      tags: ['degradação', 'durabilidade', 'anos', 'vida útil', 'garantia', 'painel'],
    },
  ]

  let created = 0
  let skipped = 0

  for (const entry of knowledgeEntries) {
    const existing = await prisma.knowledgeEntry.findFirst({
      where: { question: entry.question },
    })

    if (!existing) {
      await prisma.knowledgeEntry.create({
        data: { ...entry, embedding: [] },
      })
      created++
    } else {
      // Atualiza resposta e tags se já existir
      await prisma.knowledgeEntry.update({
        where: { id: existing.id },
        data: { answer: entry.answer, tags: entry.tags, active: true },
      })
      skipped++
    }
  }

  console.log(`✅ Knowledge base: ${created} criadas, ${skipped} atualizadas.`)
  console.log('Seed concluído!')
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect())
