const { GoogleGenerativeAI } = require('@google/generative-ai');
const { config } = require('../config');

let genAI = null;
if (config.gemini.apiKey) {
  genAI = new GoogleGenerativeAI(config.gemini.apiKey);
}

/**
 * Guarda até quando cada modelo deve ser evitado (ex: cota diária estourada).
 * modelName -> timestamp (ms)
 */
const modelCooldownUntil = new Map();

/**
 * Erro lançado quando todos os modelos configurados estão sem cota/indisponíveis.
 */
class GeminiQuotaError extends Error {
  constructor(retryAt) {
    super('Cota da IA esgotada em todos os modelos configurados');
    this.name = 'GeminiQuotaError';
    this.retryAt = retryAt;
  }
}

/**
 * Lê o tempo de espera sugerido pela API (ex: "retryDelay":"14922s") em segundos.
 */
function parseRetryDelaySeconds(message) {
  const match = String(message || '').match(/"retryDelay":"(\d+(?:\.\d+)?)s"/);
  return match ? Math.ceil(parseFloat(match[1])) : null;
}

/**
 * Formata quanto tempo falta até um timestamp (ex: "4h08min").
 */
function formatTimeUntil(timestamp) {
  const totalMin = Math.max(1, Math.ceil((timestamp - Date.now()) / 60000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m}min`;
  return `${h}h${String(m).padStart(2, '0')}min`;
}

/**
 * Chama o Gemini tentando cada modelo de GEMINI_MODEL em ordem.
 * Se um modelo estourar a cota (429), estiver sobrecarregado (503) ou não existir (404),
 * ele fica em espera e o próximo modelo é tentado automaticamente.
 *
 * @param {Array|string} parts Conteúdo da requisição (prompt + imagem)
 * @returns {Promise<string>} Texto da resposta
 */
async function generateWithFallback(parts) {
  const now = Date.now();
  const available = config.gemini.models.filter(
    (name) => (modelCooldownUntil.get(name) || 0) <= now
  );

  for (const modelName of available) {
    try {
      const model = genAI.getGenerativeModel({
        model: modelName,
        generationConfig: { responseMimeType: 'application/json' },
      });
      const result = await model.generateContent(parts);
      return result.response.text().trim();
    } catch (err) {
      const status = err.status || 0;
      const msg = String(err.message || '');

      if (status === 429 || msg.includes('[429')) {
        const delaySec = parseRetryDelaySeconds(msg) || 60;
        modelCooldownUntil.set(modelName, Date.now() + delaySec * 1000);
        console.warn(
          `⏳ Cota do modelo ${modelName} esgotada. Tentando o próximo modelo (volta em ${formatTimeUntil(Date.now() + delaySec * 1000)}).`
        );
        continue;
      }

      if (status === 503 || msg.includes('[503')) {
        modelCooldownUntil.set(modelName, Date.now() + 30 * 1000);
        console.warn(`⚠️ Modelo ${modelName} sobrecarregado. Tentando o próximo...`);
        continue;
      }

      if (status === 404 || msg.includes('[404')) {
        modelCooldownUntil.set(modelName, Date.now() + 24 * 60 * 60 * 1000);
        console.warn(
          `⚠️ Modelo ${modelName} não encontrado. Confira o nome em GEMINI_MODEL no .env.`
        );
        continue;
      }

      throw err;
    }
  }

  const nextRetry = Math.min(
    ...config.gemini.models.map((name) => modelCooldownUntil.get(name) || Date.now())
  );
  throw new GeminiQuotaError(nextRetry);
}

function cleanJsonText(text) {
  return text
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/, '');
}

/**
 * Resultado vazio usado quando a IA não consegue ler o comprovante.
 * O campo "erro_ia" avisa o bot para seguir pelo preenchimento manual.
 */
function emptyAnalysis(erroIa, mensagemErro) {
  return {
    eh_comprovante: true,
    tipo_lancamento: 'Gastos',
    categoria: 'Outros',
    tipo_transacao: 'Outro',
    valor: null,
    valor_formatado: 'Não identificado',
    data_pagamento: new Date().toLocaleDateString('pt-BR'),
    hora_pagamento: '',
    pagador: '',
    instituicao: 'Não identificada',
    id_transacao: 'Não identificado',
    itens_investimento: [],
    resumo: '',
    erro_ia: erroIa,
    erro_ia_mensagem: mensagemErro,
  };
}

const PROMPT_COMPROVANTE = `
Você é um assistente especialista em análise de comprovantes financeiros, notas fiscais, cupons fiscais e telas de investimentos brasileiros para controle financeiro pessoal.
Analise a imagem/documento enviado e retorne APENAS um objeto JSON válido (sem blocos markdown) com a seguinte estrutura exata:

{
  "eh_comprovante": true ou false,
  "tipo_lancamento": "Recebidos" | "Gastos" | "Investimentos",
  "categoria": "Matéria-prima" | "Transporte" | "Alimentação" | "Outros" (ou o tipo de ativo se for Investimentos, ex: "Renda Fixa", "Fundos de investimento", "Tesouro Direto", "Ações/FIIs"),
  "tipo_transacao": "Pix" | "Cartão de crédito" | "Cartão de débito" | "Transferência" | "Boleto" | "Cédula" | "Aplicação" | "Outro",
  "valor": número decimal do total (ex: 150000.92) ou null se não identificado,
  "valor_formatado": "R$ 150.000,92" ou "Não identificado",
  "data_pagamento": "DD/MM/AAAA" ou "Não identificada",
  "hora_pagamento": "HH:MM" ou "",
  "pagador": "Nome de quem enviou o valor (APENAS se tipo_lancamento for 'Recebidos', caso contrário retorne string vazia '')",
  "instituicao": "Banco ou corretora identificada na imagem, ou 'Não identificada' se não estiver explícito",
  "id_transacao": "Código E2E do PIX / Autenticação / Chave de acesso" ou "Não identificado",
  "itens_investimento": [
    {
      "nome_ativo": "Nome do investimento/ativo (ex: CDB 200%, Fundos XP Advisory, NTN-B Tesouro)",
      "categoria": "Classe do ativo (ex: Renda Fixa, Fundos de investimento, Tesouro Direto, Ações, Cripto)",
      "valor": número decimal (ex: 100000.00),
      "valor_formatado": "R$ 100.000,00"
    }
  ],
  "resumo": "Breve descrição em 1 frase"
}

Regras importantes para dedução inteligente:
1. "tipo_lancamento":
   - Use "Recebidos" se o comprovante indicar "Pix recebido", "Transferência recebida", "Depósito recebido", ou quando o titular Marcos (ex: "Marcos Santos" / "Marcos dos Santos Pinheiro") figurar como RECEBEDOR/DESTINATÁRIO do dinheiro.
   - Use "Investimentos" se a imagem mostrar aplicação financeira, carteira/composição de investimentos, "Total investido", CDB, RDB, LCI, LCA, Tesouro Direto (NTN-B, Selic, Prefixado), Fundos de investimento, Caixinha, Poupança, Ações, FIIs, Corretora ou Criptomoedas.
   - Use "Gastos" para pagamentos efetuados, compras no cartão, Pix enviados, boletos pagos ou cupons/notas fiscais de consumo.
2. MÚLTIPLOS INVESTIMENTOS ("itens_investimento"):
   - Quando "tipo_lancamento" for "Investimentos":
     - Se a imagem mostrar uma lista/composição com MAIS DE UM investimento (por exemplo: "CDB 200% - R$ 100.000,00", "Fundos XP Advisory - R$ 20.000,00", "NTN-B Tesouro - R$ 30.000,92"), extraia CADA UM deles separadamente dentro do array "itens_investimento"! Não pegue apenas o total: liste cada ativo individualmente em "itens_investimento".
     - Se houver apenas 1 investimento na imagem, coloque esse 1 investimento dentro de "itens_investimento".
   - Quando "tipo_lancamento" for "Gastos" ou "Recebidos", retorne "itens_investimento": [].
3. "pagador":
   - Preencha SOMENTE quando "tipo_lancamento" for "Recebidos" (indicando quem enviou/pagou o valor).
   - Se "tipo_lancamento" for "Gastos" ou "Investimentos", deixe "pagador": "".
4. "categoria" (para Gastos/Recebidos):
   - "Alimentação": Restaurantes, padarias, supermercados, mercados, lanchonetes, iFood, cafés, açougues, docerias, pizzarias, distribuidoras de alimentos/bebidas.
   - "Transporte": Postos de combustível, Uber, 99, táxi, estacionamentos, pedágios, oficinas mecânicas, autopeças, passagens aéreas/rodoviárias, transporte/frete.
   - "Matéria-prima": Insumos de produção, embalagens, papelaria técnica/gráfica, tecidos, materiais de fabricação, fornecedores de insumos ou atacado de materiais.
   - "Outros": Demais casos.
5. Em "data_pagamento", extraia a DATA REAL em que o pagamento/aplicação ocorreu no formato DD/MM/AAAA (ex: "23/03/2026"). Se não houver data definida na imagem (ex: "Data da conclusão: Não definida"), retorne "Não identificada".
`;

/**
 * Analisa um buffer de imagem ou PDF usando o Google Gemini Vision,
 * deduzindo automaticamente Tipo, Categoria e múltiplos investimentos!
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
      tipo_transacao: 'Outro',
      valor: null,
      valor_formatado: 'Não identificado',
      data_pagamento: new Date().toLocaleDateString('pt-BR'),
      hora_pagamento: new Date().toLocaleTimeString('pt-BR', {
        hour: '2-digit',
        minute: '2-digit',
      }),
      pagador: '',
      instituicao: 'Não identificada',
      id_transacao: 'Não identificado',
      itens_investimento: [],
      resumo: 'Chave Gemini não configurada',
    };
  }

  try {
    const imagePart = {
      inlineData: {
        data: fileBuffer.toString('base64'),
        mimeType,
      },
    };

    const responseText = await generateWithFallback([
      PROMPT_COMPROVANTE,
      imagePart,
    ]);
    const parsed = JSON.parse(cleanJsonText(responseText));
    const tipoLancamento = parsed.tipo_lancamento || 'Gastos';
    const dataPag =
      parsed.data_pagamento &&
      parsed.data_pagamento !== 'Não identificada' &&
      parsed.data_pagamento !== 'Não definida'
        ? parsed.data_pagamento
        : new Date().toLocaleDateString('pt-BR');

    return {
      eh_comprovante: parsed.eh_comprovante ?? true,
      tipo_lancamento: tipoLancamento,
      categoria:
        parsed.categoria ||
        (tipoLancamento === 'Investimentos' ? 'Investimentos' : 'Outros'),
      tipo_transacao:
        parsed.tipo_transacao ||
        (tipoLancamento === 'Investimentos' ? 'Aplicação' : 'Outro'),
      valor: parsed.valor ?? null,
      valor_formatado: parsed.valor_formatado || 'Não identificado',
      data_pagamento: dataPag,
      hora_pagamento: parsed.hora_pagamento || '',
      pagador: tipoLancamento === 'Recebidos' ? parsed.pagador || '' : '',
      instituicao: parsed.instituicao || 'Não identificada',
      id_transacao: parsed.id_transacao || 'Não identificado',
      itens_investimento: Array.isArray(parsed.itens_investimento)
        ? parsed.itens_investimento
        : [],
      resumo: parsed.resumo || '',
    };
  } catch (error) {
    if (error instanceof GeminiQuotaError) {
      const espera = formatTimeUntil(error.retryAt);
      console.error(
        `❌ Cota diária da IA esgotada em todos os modelos. Volta em ~${espera}.`
      );
      return emptyAnalysis(
        'COTA',
        `O limite diário gratuito da IA acabou (volta em ~${espera}).`
      );
    }

    console.error('❌ Erro ao analisar comprovante no Gemini:', error.message);
    return emptyAnalysis('FALHA', 'A IA não conseguiu ler este comprovante.');
  }
}

/**
 * Interpreta a resposta do usuário na etapa de confirmação de valor/dados.
 * Permite confirmar com 1 comando ou alterar Tipo, Categoria, Valor, Data, Banco ou Itens de Investimento.
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
  // (Ignorado quando há múltiplos investimentos, pois um número solto seria ambíguo — a IA interpreta abaixo.)
  const hasMultipleItems =
    Array.isArray(currentData.itens_investimento) &&
    currentData.itens_investimento.length > 1;
  const numericMatch = hasMultipleItems
    ? null
    : trimmed.match(/^(?:r\$\s*)?(\d+(?:[.,]\d{1,2})?)$/i);
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

  // 4. Correção de data sem gastar requisição da IA (ex: "data 15/03/2026" ou só "15/03/2026")
  const dateMatch = trimmed.match(
    /^(?:data\s*[:\-]?\s*)?(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?$/i
  );
  if (dateMatch) {
    const d = parseInt(dateMatch[1], 10);
    const m = parseInt(dateMatch[2], 10);
    let y = dateMatch[3]
      ? parseInt(dateMatch[3], 10)
      : new Date().getFullYear();
    if (y < 100) y += 2000;
    if (d >= 1 && d <= 31 && m >= 1 && m <= 12) {
      const novaData = `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y}`;
      return {
        acao: 'EDITAR',
        dados_atualizados: { ...currentData, data_pagamento: novaData },
        resposta_bot: `Data alterada para ${novaData}.`,
      };
    }
  }

  // 5. Usa o Gemini para interpretar correções em linguagem natural
  if (!genAI) {
    return {
      acao: 'CONVERSAR',
      dados_atualizados: currentData,
      resposta_bot:
        'Digite *Confirmar* para salvar, digite outro valor (ex: *26.90*), ou digite *Cancelar*.',
    };
  }

  try {
    const prompt = `
Você é um assistente financeiro pessoal no WhatsApp ajudando a revisar os dados de um comprovante ou investimento antes de salvar.

Dados atuais do registro:
${JSON.stringify(currentData, null, 2)}

Mensagem do usuário:
"${userText}"

Retorne APENAS um JSON válido com a estrutura:
{
  "acao": "CONFIRMAR" | "CANCELAR" | "EDITAR" | "CONVERSAR",
  "dados_atualizados": {
    "tipo_lancamento": "Recebidos" | "Gastos" | "Investimentos",
    "categoria": "...",
    "tipo_transacao": "...",
    "valor": numero_decimal_ou_null,
    "valor_formatado": "R$ ...",
    "data_pagamento": "DD/MM/AAAA",
    "hora_pagamento": "HH:MM",
    "pagador": "Nome de quem enviou o valor (APENAS se tipo_lancamento for 'Recebidos', senão '')",
    "instituicao": "Banco ou corretora",
    "itens_investimento": [
      {
        "nome_ativo": "...",
        "categoria": "...",
        "valor": numero_decimal,
        "valor_formatado": "R$ ..."
      }
    ]
  },
  "resposta_bot": "Mensagem curta em português"
}

Regras:
- Se o usuário alterou o banco/instituição, tipo, categoria, valor, data, pagador ou algum item de "itens_investimento", atualize em "dados_atualizados" e use "EDITAR" (ou "CONFIRMAR" se ele também pediu para salvar).
- Se "tipo_lancamento" não for "Recebidos", "pagador" deve ser "".
- Sempre mantenha "data_pagamento" no formato DD/MM/AAAA.
`;

    const responseText = await generateWithFallback(prompt);
    const parsed = JSON.parse(cleanJsonText(responseText));
    const merged = { ...currentData, ...(parsed.dados_atualizados || {}) };
    if (merged.tipo_lancamento !== 'Recebidos') {
      merged.pagador = '';
    }

    return {
      acao: parsed.acao || 'CONVERSAR',
      dados_atualizados: merged,
      resposta_bot:
        parsed.resposta_bot ||
        'Digite *Confirmar* para salvar ou *Cancelar* para descartar.',
    };
  } catch (err) {
    const semCota = err instanceof GeminiQuotaError;
    console.error(
      '❌ Erro ao interpretar mensagem com IA:',
      semCota ? 'cota esgotada' : err.message
    );
    return {
      acao: 'CONVERSAR',
      dados_atualizados: currentData,
      resposta_bot: semCota
        ? `⚠️ A IA está sem cota agora (volta em ~${formatTimeUntil(err.retryAt)}), então não consigo entender correções em texto livre.\n\nVocê ainda pode: digitar *Confirmar*, *Cancelar*, um novo valor (ex: *26.90*) ou uma nova data (ex: *15/03/2026*).`
        : 'Digite *Confirmar* para salvar, informe alguma correção ou digite *Cancelar*.',
    };
  }
}

module.exports = { analyzeReceipt, interpretConfirmationReply };
