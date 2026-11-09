const { GoogleGenerativeAI } = require('@google/generative-ai');
const { config } = require('../config');

let genAI = null;
if (config.gemini.apiKey) {
  genAI = new GoogleGenerativeAI(config.gemini.apiKey);
}

const PROMPT_COMPROVANTE = `
Você é um assistente especialista em análise de comprovantes financeiros, notas fiscais e cupons fiscais brasileiros.
Analise a imagem/documento enviado e retorne APENAS um objeto JSON válido (sem blocos markdown) com a seguinte estrutura exata:

{
  "eh_comprovante": true ou false,
  "tipo_lancamento": "Recebidos" | "Gastos" | "Investimentos",
  "categoria": "Matéria-prima" | "Transporte" | "Alimentação" | "Outros",
  "motivo_deducao": "Breve explicação de como deduziu o tipo e a categoria pelo estabelecimento/comprovante",
  "tipo_transacao": "Pix" | "Cartão de crédito" | "Cartão de débito" | "Transferência" | "Boleto" | "Cédula" | "Outro",
  "valor": número decimal (ex: 150.50) ou null se não identificado,
  "valor_formatado": "R$ 150,50" ou "Não identificado",
  "data_pagamento": "DD/MM/AAAA" ou "Não identificada",
  "hora_pagamento": "HH:MM" ou "",
  "pagador": "Nome de quem pagou" ou "Não identificado",
  "recebedor": "Nome de quem recebeu / estabelecimento" ou "Não identificado",
  "instituicao": "Banco ou instituição financeira" ou "Não identificada",
  "id_transacao": "Código E2E do PIX / Autenticação / Chave de acesso" ou "Não identificado",
  "resumo": "Breve descrição em 1 frase"
}

Regras importantes para dedução inteligente:
1. "tipo_lancamento":
   - Use "Recebidos" se o comprovante indicar "Pix recebido", "Transferência recebida", "Depósito recebido", ou quando o titular Marcos (ex: "Marcos Santos" / "Marcos dos Santos Pinheiro") figurar como RECEBEDOR/DESTINATÁRIO do dinheiro.
   - Use "Investimentos" se o comprovante for de aplicação financeira, CDB, RDB, Tesouro Direto, Caixinha, Poupança, Ações, Fundos Imobiliários, Corretora ou Criptomoedas.
   - Use "Gastos" para pagamentos efetuados, compras no cartão, Pix enviados, boletos pagos ou cupons/notas fiscais de consumo.
2. "categoria" (deduza pelo nome/ramo de atividade do estabelecimento recebedor ou pelos itens da nota):
   - "Alimentação": Restaurantes, padarias, supermercados, mercados, lanchonetes, iFood, cafés, açougues, docerias, pizzarias, distribuidoras de alimentos/bebidas.
   - "Transporte": Postos de combustível, Uber, 99, táxi, estacionamentos, pedágios, oficinas mecânicas, autopeças, passagens aéreas/rodoviárias, transporte/frete.
   - "Matéria-prima": Insumos de produção, embalagens, papelaria técnica/gráfica, tecidos, materiais de fabricação, fornecedores de insumos ou atacado de materiais.
   - "Outros": Demais estabelecimentos (vestuário, fotos/eventos, saúde/farmácia, serviços, assinaturas, transferências para pessoas físicas sem ramo específico, etc.).
3. Em "data_pagamento", extraia a DATA REAL em que o pagamento/compra ocorreu no formato DD/MM/AAAA (ex: "23/03/2026"). Se o ano tiver 2 dígitos (ex: 23/03/26), converta para 4 dígitos ("23/03/2026").
4. Se a imagem NÃO for um comprovante de pagamento, recibo, cupom ou nota fiscal, defina "eh_comprovante": false.
`;

/**
 * Analisa um buffer de imagem ou PDF usando o Google Gemini Vision,
 * deduzindo automaticamente Tipo (Recebidos/Gastos/Investimentos) e Categoria pelo estabelecimento!
 *
 * @param {Buffer} fileBuffer Buffer do arquivo recebido no WhatsApp
 * @param {string} mimeType Tipo MIME (ex: image/jpeg, image/png, application/pdf)
 * @returns {Promise<Object>} Dados extraídos e deduzidos do comprovante
 */
async function analyzeReceipt(fileBuffer, mimeType = 'image/jpeg') {
  if (!genAI) {
    return {
      eh_comprovante: true,
      tipo_lancamento: 'Gastos',
      categoria: 'Outros',
      motivo_deducao: 'Chave Gemini não configurada',
      tipo_transacao: 'Outro',
      valor: null,
      valor_formatado: 'Não identificado',
      data_pagamento: new Date().toLocaleDateString('pt-BR'),
      hora_pagamento: new Date().toLocaleTimeString('pt-BR', {
        hour: '2-digit',
        minute: '2-digit',
      }),
      pagador: 'Não identificado',
      recebedor: 'Não identificado',
      instituicao: 'Não identificada',
      id_transacao: 'Não identificado',
      resumo: 'Chave Gemini não configurada',
    };
  }

  try {
    const model = genAI.getGenerativeModel({
      model: config.gemini.model,
      generationConfig: {
        responseMimeType: 'application/json',
      },
    });

    const imagePart = {
      inlineData: {
        data: fileBuffer.toString('base64'),
        mimeType,
      },
    };

    const result = await model.generateContent([PROMPT_COMPROVANTE, imagePart]);
    const responseText = result.response.text().trim();

    const cleanedJson = responseText
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/, '');

    const parsed = JSON.parse(cleanedJson);
    return {
      eh_comprovante: parsed.eh_comprovante ?? true,
      tipo_lancamento: parsed.tipo_lancamento || 'Gastos',
      categoria: parsed.categoria || 'Outros',
      motivo_deducao: parsed.motivo_deducao || '',
      tipo_transacao: parsed.tipo_transacao || 'Outro',
      valor: parsed.valor ?? null,
      valor_formatado: parsed.valor_formatado || 'Não identificado',
      data_pagamento:
        parsed.data_pagamento || new Date().toLocaleDateString('pt-BR'),
      hora_pagamento: parsed.hora_pagamento || '',
      pagador: parsed.pagador || 'Não identificado',
      recebedor: parsed.recebedor || 'Não identificado',
      instituicao: parsed.instituicao || 'Não identificada',
      id_transacao: parsed.id_transacao || 'Não identificado',
      resumo: parsed.resumo || '',
    };
  } catch (error) {
    console.error('❌ Erro ao analisar comprovante no Gemini:', error.message);
    return {
      eh_comprovante: true,
      tipo_lancamento: 'Gastos',
      categoria: 'Outros',
      motivo_deducao: '',
      tipo_transacao: 'Outro',
      valor: null,
      valor_formatado: 'Não identificado',
      data_pagamento: 'Não identificada',
      hora_pagamento: '',
      pagador: 'Não identificado',
      recebedor: 'Não identificado',
      instituicao: 'Não identificada',
      id_transacao: 'Não identificado',
      resumo: `Falha na extração automática: ${error.message}`,
    };
  }
}

/**
 * Interpreta a resposta do usuário na etapa de confirmação de valor/dados.
 * Permite confirmar com 1 comando ou alterar Tipo, Categoria, Valor, Data, Meio de pagamento, etc.
 */
async function interpretConfirmationReply(userText, currentData) {
  const trimmed = userText.trim();
  const normalized = trimmed.toLowerCase();

  // 1. Confirmação direta
  if (
    [
      'sim',
      's',
      '1',
      'confirmar',
      'confirmo',
      'ok',
      'pode salvar',
      'salvar',
      'isso',
      'certo',
      'correto',
    ].includes(normalized)
  ) {
    return {
      acao: 'CONFIRMAR',
      dados_atualizados: currentData,
      resposta_bot: 'Confirmado!',
    };
  }

  // 2. Cancelamento direto
  if (
    [
      'nao',
      'não',
      'n',
      '2',
      'cancelar',
      'cancela',
      'descartar',
      'apagar',
      'sair',
    ].includes(normalized)
  ) {
    return {
      acao: 'CANCELAR',
      dados_atualizados: currentData,
      resposta_bot: 'Registro cancelado.',
    };
  }

  // 3. Se o usuário digitou diretamente um novo valor numérico (ex: "26.90", "26,90", "R$ 150,00")
  const numericMatch = trimmed.match(/^(?:r\$\s*)?(\d+(?:[.,]\d{1,2})?)$/i);
  if (numericMatch) {
    const rawNum = parseFloat(numericMatch[1].replace(',', '.'));
    if (!isNaN(rawNum) && rawNum > 0) {
      const formatted = rawNum.toLocaleString('pt-BR', {
        style: 'currency',
        currency: 'BRL',
      });
      return {
        acao: 'CONFIRMAR',
        dados_atualizados: {
          ...currentData,
          valor: rawNum,
          valor_formatado: formatted,
        },
        resposta_bot: `Valor ajustado para ${formatted} e confirmado!`,
      };
    }
  }

  // 4. Usa o Gemini para interpretar correções em linguagem natural (Tipo, Categoria, Valor, Data, Recebedor...)
  if (!genAI) {
    return {
      acao: 'CONVERSAR',
      dados_atualizados: currentData,
      resposta_bot:
        'Digite *Confirmar* para salvar, digite outro valor (ex: *26.90*), ou digite *Cancelar*.',
    };
  }

  try {
    const model = genAI.getGenerativeModel({
      model: config.gemini.model,
      generationConfig: {
        responseMimeType: 'application/json',
      },
    });

    const prompt = `
Você é um assistente financeiro no WhatsApp ajudando a revisar os dados de um comprovante antes de salvar.

Dados atuais do comprovante:
${JSON.stringify(currentData, null, 2)}

Mensagem do usuário:
"${userText}"

Retorne APENAS um JSON válido com a estrutura:
{
  "acao": "CONFIRMAR" | "CANCELAR" | "EDITAR" | "CONVERSAR",
  "dados_atualizados": {
    "tipo_lancamento": "Recebidos" | "Gastos" | "Investimentos",
    "categoria": "Matéria-prima" | "Transporte" | "Alimentação" | "Outros" (ou categoria personalizada pedida pelo usuário),
    "tipo_transacao": "Pix" | "Cartão de crédito" | "Cartão de débito" | "Transferência" | "Boleto" | "Cédula" | "Outro",
    "valor": numero_decimal_ou_null,
    "valor_formatado": "R$ ...",
    "data_pagamento": "DD/MM/AAAA",
    "hora_pagamento": "HH:MM",
    "pagador": "...",
    "recebedor": "...",
    "instituicao": "..."
  },
  "resposta_bot": "Mensagem curta em português"
}

Regras:
- Se o usuário corrigiu o tipo (ex: "é recebido", "foi investimento", "é gasto"), a categoria (ex: "categoria transporte", "é matéria-prima", "alimentação"), o valor, a data ou o recebedor, atualize os campos correspondentes em "dados_atualizados" e use "EDITAR" (ou "CONFIRMAR" se ele também pediu para salvar).
- Sempre mantenha "data_pagamento" no formato DD/MM/AAAA.
`;

    const result = await model.generateContent(prompt);
    const cleanedJson = result.response
      .text()
      .trim()
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/, '');

    const parsed = JSON.parse(cleanedJson);
    return {
      acao: parsed.acao || 'CONVERSAR',
      dados_atualizados: { ...currentData, ...(parsed.dados_atualizados || {}) },
      resposta_bot:
        parsed.resposta_bot ||
        'Digite *Confirmar* para salvar ou *Cancelar* para descartar.',
    };
  } catch (err) {
    console.error('❌ Erro ao interpretar mensagem com IA:', err.message);
    return {
      acao: 'CONVERSAR',
      dados_atualizados: currentData,
      resposta_bot:
        'Digite *Confirmar* para salvar, informe alguma correção ou digite *Cancelar*.',
    };
  }
}

module.exports = { analyzeReceipt, interpretConfirmationReply };
