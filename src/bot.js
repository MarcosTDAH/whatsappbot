const path = require('path');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');

const { config, validateConfig } = require('./config');
const {
  analyzeReceipt,
  interpretConfirmationReply,
} = require('./services/geminiService');
const {
  extractMonthInfo,
  uploadToDrive,
  appendReceiptToSheet,
} = require('./services/googleService');

const logger = pino({ level: 'silent' });

/**
 * Armazena a sessão de conversa ativa por chat (remoteJid -> estado do fluxo).
 */
const activeSessions = new Map();

const TIPOS_REGISTRO = {
  1: 'Recebidos',
  2: 'Gastos',
  3: 'Investimentos',
};

const CATEGORIAS = {
  1: 'Matéria-prima',
  2: 'Transporte',
  3: 'Alimentação',
  4: 'Outros',
};

const MEIOS_PAGAMENTO = {
  1: 'Transferência',
  2: 'Pix',
  3: 'Cartão de crédito',
  4: 'Cartão de débito',
  5: 'Cédula',
};

const MENU_TIPO =
  `O que deseja registrar?\n\n` +
  `1 - Recebidos\n` +
  `2 - Gastos\n` +
  `3 - Investimentos`;

const MENU_CATEGORIA =
  `Categoria?\n\n` +
  `1 - Matéria-prima\n` +
  `2 - Transporte\n` +
  `3 - Alimentação\n` +
  `4 - Outros`;

const MENU_MEIO_PAGAMENTO =
  `Meio de pagamento?\n\n` +
  `1 - Transferência\n` +
  `2 - Pix\n` +
  `3 - Cartão de crédito\n` +
  `4 - Cartão de débito\n` +
  `5 - Cédula`;

/**
 * Limpa caracteres inválidos para nome de arquivo no Google Drive.
 */
function sanitizeFileName(str) {
  return String(str || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 40);
}

/**
 * Extrai o conteúdo real da mensagem (desempacotando mensagens temporárias/viewOnce).
 */
function unwrapMessageContent(message) {
  if (!message) return null;
  if (message.ephemeralMessage?.message) {
    return unwrapMessageContent(message.ephemeralMessage.message);
  }
  if (message.viewOnceMessage?.message) {
    return unwrapMessageContent(message.viewOnceMessage.message);
  }
  if (message.viewOnceMessageV2?.message) {
    return unwrapMessageContent(message.viewOnceMessageV2.message);
  }
  if (message.documentWithCaptionMessage?.message) {
    return unwrapMessageContent(message.documentWithCaptionMessage.message);
  }
  return message;
}

/**
 * Identifica se a mensagem contém imagem ou documento (PDF/imagem) válido para análise.
 */
function extractMediaInfo(msgContent) {
  if (!msgContent) return null;

  if (msgContent.imageMessage) {
    const img = msgContent.imageMessage;
    return {
      type: 'image',
      mimeType: img.mimetype || 'image/jpeg',
      caption: img.caption || '',
      extension: img.mimetype?.includes('png') ? 'png' : 'jpg',
    };
  }

  if (msgContent.documentMessage) {
    const doc = msgContent.documentMessage;
    const mime = doc.mimetype || '';
    const isPdf = mime === 'application/pdf';
    const isImage = mime.startsWith('image/');

    if (isPdf || isImage) {
      let ext = 'pdf';
      if (isImage) {
        ext = mime.includes('png') ? 'png' : 'jpg';
      }
      return {
        type: 'document',
        mimeType: mime,
        caption: doc.caption || doc.fileName || '',
        extension: ext,
      };
    }
  }

  return null;
}

/**
 * Extrai texto de uma mensagem comum ou resposta do WhatsApp.
 */
function extractTextMessage(msgContent) {
  if (!msgContent) return '';
  if (typeof msgContent.conversation === 'string') {
    return msgContent.conversation.trim();
  }
  if (typeof msgContent.extendedTextMessage?.text === 'string') {
    return msgContent.extendedTextMessage.text.trim();
  }
  return '';
}

/**
 * Formata a lista de investimentos quando houver 1 ou múltiplos ativos.
 */
function formatInvestmentItemsList(analysis) {
  const itens = Array.isArray(analysis.itens_investimento)
    ? analysis.itens_investimento
    : [];

  if (itens.length === 0) {
    return `• *${analysis.categoria || 'Investimento'}* — *${analysis.valor_formatado || 'Não identificado'}*`;
  }

  return itens
    .map((item, idx) => {
      const cat =
        item.categoria && item.categoria !== item.nome_ativo
          ? ` (${item.categoria})`
          : '';
      const val =
        item.valor_formatado ||
        (typeof item.valor === 'number'
          ? item.valor.toLocaleString('pt-BR', {
              style: 'currency',
              currency: 'BRL',
            })
          : 'Não identificado');
      return `${idx + 1}. *${item.nome_ativo || 'Ativo'}*${cat} — *${val}*`;
    })
    .join('\n');
}

/**
 * Monta a pergunta de qual banco está sendo depositado o investimento.
 */
function buildAskInvestmentBankPrompt(session) {
  const { analysis } = session;
  const itensText = formatInvestmentItemsList(analysis);
  const totalText = analysis.valor_formatado || 'Não identificado';

  return (
    `📈 *Investimento(s) Identificado(s) pela IA:*\n\n` +
    `${itensText}\n` +
    `💰 *Total:* ${totalText}\n\n` +
    `🏦 *Em qual banco ou corretora está sendo depositado este investimento?*\n` +
    `_(Digite o nome da instituição, ex: XP, Nubank, Itaú, BTG, Inter)_`
  );
}

/**
 * Monta a mensagem de confirmação mostrando o que a IA deduziu do comprovante.
 * Só exibe "Pagador (Quem enviou)" quando o tipo for "Recebidos".
 * Quando for "Investimentos", mostra a lista de investimentos e o banco informado.
 */
function buildValueConfirmationPrompt(session) {
  const { analysis, tipoLancamento, categoria } = session;
  const monthInfo = extractMonthInfo(analysis.data_pagamento);
  const valorDetectado = analysis.valor_formatado || 'Não identificado';
  const tipoFinal = tipoLancamento || analysis.tipo_lancamento || 'Gastos';
  const categoriaFinal = categoria || analysis.categoria || 'Outros';

  if (tipoFinal === 'Investimentos') {
    const itensText = formatInvestmentItemsList(analysis);
    return (
      `🤖 *Resumo do(s) Investimento(s):*\n\n` +
      `📂 *Tipo:* Investimentos\n` +
      `🏦 *Banco / Corretora:* ${analysis.instituicao || 'Não informado'}\n` +
      `📅 *Data:* ${monthInfo.normalizedDate}\n` +
      `📁 *Pasta no Drive:* ${monthInfo.monthFolderName}\n\n` +
      `📊 *Composição a ser registrada na planilha:*\n` +
      `${itensText}\n` +
      `💰 *Total:* ${valorDetectado}\n\n` +
      `👉 Digite *Confirmar* (ou *Sim*) para salvar todos os itens, ou peça qualquer alteração (ex: _"muda banco para BTG"_, _"data 15/03/2026"_, _"muda valor do CDB para 90000"_).`
    );
  }

  let details =
    `🤖 *Comprovante Analisado pela IA:*\n\n` +
    `📂 *Tipo:* ${tipoFinal}\n` +
    `🏷️ *Categoria:* ${categoriaFinal}\n` +
    `💳 *Meio:* ${analysis.tipo_transacao || 'Outro'}\n` +
    `💰 *Valor:* ${valorDetectado}\n` +
    `📅 *Data do Pagamento:* ${monthInfo.normalizedDate}\n` +
    `📁 *Pasta no Drive:* ${monthInfo.monthFolderName}`;

  if (tipoFinal === 'Recebidos') {
    details += `\n👤 *Pagador (Quem enviou):* ${analysis.pagador || 'Não identificado'}`;
  }

  details += `\n\n👉 Digite *Confirmar* (ou *Sim*) para salvar, digite outro valor (ex: *26.90*), ou peça qualquer alteração (ex: _"muda categoria para Transporte"_, _"é Recebidos"_, _"pagador: João"_).`;

  return details;
}

/**
 * Finaliza a sessão salvando o comprovante na pasta do mês correspondente ao pagamento
 * no Google Drive e registrando 1 ou múltiplas linhas no Google Sheets.
 */
async function finalizeAndSaveSession(sock, remoteJid, session, triggerMsg) {
  const { hasMedia, buffer, mediaInfo, analysis } = session;

  const tipoLancamento =
    session.tipoLancamento || analysis.tipo_lancamento || 'Gastos';
  const categoria = session.categoria || analysis.categoria || 'Outros';

  // Garante que pagador só é mantido quando for Recebidos
  const pagadorRecebidos =
    tipoLancamento === 'Recebidos' ? analysis.pagador || '' : '';
  analysis.pagador = pagadorRecebidos;

  const monthInfo = extractMonthInfo(analysis.data_pagamento);
  analysis.data_pagamento = monthInfo.normalizedDate;

  const now = new Date();
  const timePrefix = now.toTimeString().slice(0, 8).replace(/:/g, '-');
  const dateForFile = monthInfo.normalizedDate.split('/').reverse().join('-');

  let fileName = '';
  if (hasMedia && buffer && mediaInfo) {
    const cleanTipo = sanitizeFileName(tipoLancamento || 'Comprovante');
    const cleanCat = sanitizeFileName(
      tipoLancamento === 'Investimentos'
        ? analysis.instituicao || 'Investimento'
        : categoria || 'Geral'
    );
    const cleanValor = sanitizeFileName(
      analysis.valor_formatado && analysis.valor_formatado !== 'Não identificado'
        ? analysis.valor_formatado
        : 'sem_valor'
    );

    fileName = `${cleanTipo}_${cleanCat}_${dateForFile}_${timePrefix}_${cleanValor}.${mediaInfo.extension}`;

    await sock.sendMessage(remoteJid, {
      text: `Enviando comprovante para o Google Drive (Pasta: *${monthInfo.monthFolderName}*)...`,
    });
  }

  const receivedAt = now.toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
  });

  const receiptMetadata = {
    receivedAt,
    ...analysis,
    tipo_lancamento: tipoLancamento,
    categoria,
    pagador: pagadorRecebidos,
    mes_competencia: monthInfo.monthCompetencia,
    pasta_mes: monthInfo.monthFolderName,
  };

  console.log(
    `☁️  Salvando registro [${tipoLancamento} - ${categoria}] no mês ${monthInfo.monthFolderName}...`
  );

  const driveFile = await uploadToDrive(
    hasMedia ? buffer : null,
    fileName,
    mediaInfo?.mimeType || '',
    receiptMetadata
  );

  await appendReceiptToSheet({
    ...receiptMetadata,
    driveLink: driveFile.webViewLink,
  });

  console.log(
    `✅ Registro concluído com sucesso! Pasta: ${monthInfo.monthFolderName}`
  );

  let finalMessage = '';
  if (tipoLancamento === 'Investimentos') {
    const itensText = formatInvestmentItemsList(analysis);
    finalMessage =
      `Registrado com sucesso ✅\n\n` +
      `📂 *Tipo:* Investimentos\n` +
      `🏦 *Banco / Corretora:* ${analysis.instituicao || 'Não informado'}\n` +
      `📊 *Investimentos registrados:*\n${itensText}\n` +
      `💰 *Total:* ${analysis.valor_formatado || 'Não identificado'}\n` +
      `📅 *Data:* ${monthInfo.normalizedDate}\n` +
      `📁 *Pasta do Mês:* ${monthInfo.monthFolderName}`;
  } else {
    finalMessage =
      `Registrado com sucesso ✅\n\n` +
      `📂 *Tipo:* ${tipoLancamento}\n` +
      `🏷️ *Categoria:* ${categoria}\n` +
      `💳 *Meio:* ${analysis.tipo_transacao || 'Outro'}\n` +
      `💰 *Valor:* ${analysis.valor_formatado || 'Não identificado'}\n` +
      `📅 *Data do Pagamento:* ${monthInfo.normalizedDate}\n` +
      `📁 *Pasta do Mês:* ${monthInfo.monthFolderName}`;

    if (tipoLancamento === 'Recebidos' && pagadorRecebidos) {
      finalMessage += `\n👤 *Pagador (Quem enviou):* ${pagadorRecebidos}`;
    }
  }

  if (hasMedia && driveFile.webViewLink) {
    finalMessage += `\n🔗 *Drive:* ${driveFile.webViewLink}`;
  }

  await sock.sendMessage(
    remoteJid,
    { text: finalMessage },
    { quoted: triggerMsg }
  );
}

/**
 * Resolve uma opção digitada pelo usuário (número ou nome por extenso).
 */
function matchMenuOption(inputText, optionsMap) {
  const clean = inputText.trim();
  if (optionsMap[clean]) return optionsMap[clean];

  const lower = clean.toLowerCase();
  for (const [, val] of Object.entries(optionsMap)) {
    if (val.toLowerCase() === lower) return val;
  }
  return null;
}

/**
 * Coloca a sessão na primeira etapa do preenchimento manual (usado quando a IA está indisponível)
 * e devolve a pergunta a ser enviada. A foto continua na sessão e é salva no final.
 */
function advanceToManualDetails(session) {
  if (session.tipoLancamento === 'Investimentos') {
    session.step = 'AWAITING_BANCO_SEM_FOTO';
    return '🏦 *Em qual banco ou corretora está sendo depositado este investimento?*';
  }
  session.step = 'AWAITING_CATEGORIA';
  return MENU_CATEGORIA;
}

async function startBot() {
  validateConfig();

  const authFolder = path.resolve(__dirname, '..', 'auth_info_baileys');
  const { state, saveCreds } = await useMultiFileAuthState(authFolder);

  let version = [2, 3000, 1015901307];
  try {
    const latest = await fetchLatestBaileysVersion();
    version = latest.version;
  } catch {
    // Usa versão padrão caso falhe a busca
  }

  const sock = makeWASocket({
    version,
    logger,
    auth: state,
    printQRInTerminal: false,
    browser: ['Bot Comprovantes', 'Chrome', '1.0.0'],
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\n==========================================================');
      console.log('📱 ESCANEIE O QR CODE ABAIXO NO SEU WHATSAPP:');
      console.log('   (WhatsApp > Aparelhos conectados > Conectar aparelho)');
      console.log('==========================================================\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      console.log(
        `⚠️ Conexão encerrada (Código: ${statusCode}). Reconectando: ${shouldReconnect}`
      );

      if (shouldReconnect) {
        setTimeout(() => startBot(), 3000);
      } else {
        console.log(
          '❌ Sessão desconectada pelo celular. Apague a pasta "auth_info_baileys" e inicie novamente para gerar um novo QR Code.'
        );
      }
    } else if (connection === 'open') {
      console.log('\n✅ BOT CONECTADO AO WHATSAPP COM SUCESSO!');
      console.log(
        '👀 Envie diretamente uma foto/PDF (a IA deduz Tipo, Categoria e múltiplos Investimentos) ou digite /start...\n'
      );
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      try {
        if (!msg.message) continue;
        if (msg.key.fromMe) continue;

        const remoteJid = msg.key.remoteJid;
        if (!remoteJid || remoteJid === 'status@broadcast') continue;

        const isGroup = remoteJid.endsWith('@g.us');
        if (isGroup && config.bot.ignoreGroups) continue;

        if (
          config.bot.allowedChats.length > 0 &&
          !config.bot.allowedChats.includes(remoteJid)
        ) {
          continue;
        }

        const unwrapped = unwrapMessageContent(msg.message);
        const mediaInfo = extractMediaInfo(unwrapped);
        const textMessage = extractTextMessage(unwrapped);

        // ====================================================================
        // COMANDO /start (para registro manual passo a passo ou sem foto)
        // ====================================================================
        const lowerText = textMessage.toLowerCase();
        if (['/start', 'start', '/menu', 'menu', '/novo'].includes(lowerText)) {
          activeSessions.set(remoteJid, {
            step: 'AWAITING_TIPO',
            hasMedia: false,
            buffer: null,
            mediaInfo: null,
            tipoLancamento: null,
            categoria: null,
            analysis: {
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
            },
          });

          await sock.sendMessage(remoteJid, { text: MENU_TIPO });
          continue;
        }

        if (['/cancelar', 'cancelar', 'sair'].includes(lowerText)) {
          if (activeSessions.has(remoteJid)) {
            activeSessions.delete(remoteJid);
            await sock.sendMessage(remoteJid, {
              text: '❌ Operação cancelada. Envie uma foto/PDF ou digite */start* quando quiser registrar novamente.',
            });
            continue;
          }
        }

        // ====================================================================
        // RECEBIMENTO DE FOTO OU PDF (A IA DEDUZ TIPO, CATEGORIA E INVESTIMENTOS)
        // ====================================================================
        if (mediaInfo) {
          console.log(`\n📥 Comprovante recebido [${mediaInfo.mimeType}]`);

          await sock.sendMessage(remoteJid, {
            text: 'Processando imagem, aguarda um momento...',
          });

          const buffer = await downloadMediaMessage(
            msg,
            'buffer',
            {},
            {
              logger,
              reuploadRequest: sock.updateMediaMessage,
            }
          );

          console.log(
            '🤖 Analisando comprovante e deduzindo Tipo/Categoria/Investimentos com IA...'
          );
          const analysis = await analyzeReceipt(buffer, mediaInfo.mimeType);

          // IA indisponível (cota esgotada ou falha): mantém a foto e segue pelo preenchimento manual
          if (analysis.erro_ia) {
            const previous = activeSessions.get(remoteJid);
            const manualSession = {
              step: 'AWAITING_TIPO',
              hasMedia: true,
              manualFallback: true,
              buffer,
              mediaInfo,
              tipoLancamento: previous?.tipoLancamento || null,
              categoria: null,
              analysis,
            };

            const aviso =
              `⚠️ ${analysis.erro_ia_mensagem}\n` +
              `Sem problema: a foto ficou guardada e vamos preencher os dados manualmente.`;

            // Se o tipo já foi escolhido no /start, pula direto para os detalhes
            if (manualSession.tipoLancamento) {
              manualSession.analysis.tipo_lancamento =
                manualSession.tipoLancamento;
              const nextText = advanceToManualDetails(manualSession);
              activeSessions.set(remoteJid, manualSession);
              await sock.sendMessage(
                remoteJid,
                { text: `${aviso}\n\n${nextText}` },
                { quoted: msg }
              );
            } else {
              activeSessions.set(remoteJid, manualSession);
              await sock.sendMessage(
                remoteJid,
                { text: `${aviso}\n\n${MENU_TIPO}` },
                { quoted: msg }
              );
            }
            continue;
          }

          if (config.bot.onlyReceipts && !analysis.eh_comprovante) {
            console.log(
              '⏭️  Imagem ignorada: A IA identificou que não é um comprovante.'
            );
            await sock.sendMessage(remoteJid, {
              text: '⚠️ Não identifiquei esta imagem como um comprovante, nota fiscal ou investimento.',
            });
            continue;
          }

          const existingSession = activeSessions.get(remoteJid);
          const deducedTipo =
            existingSession?.tipoLancamento ||
            analysis.tipo_lancamento ||
            'Gastos';
          const deducedCategoria =
            existingSession?.categoria || analysis.categoria || 'Outros';

          analysis.tipo_lancamento = deducedTipo;
          analysis.categoria = deducedCategoria;
          if (deducedTipo !== 'Recebidos') {
            analysis.pagador = '';
          }

          // Se for Investimentos, pergunta sempre qual banco/corretora está sendo depositado!
          if (deducedTipo === 'Investimentos') {
            const newSession = {
              step: 'AWAITING_BANCO_INVESTIMENTO',
              hasMedia: true,
              buffer,
              mediaInfo,
              tipoLancamento: deducedTipo,
              categoria: deducedCategoria,
              analysis,
            };

            activeSessions.set(remoteJid, newSession);

            await sock.sendMessage(
              remoteJid,
              { text: buildAskInvestmentBankPrompt(newSession) },
              { quoted: msg }
            );
            continue;
          }

          const newSession = {
            step: 'AWAITING_CONFIRMACAO',
            hasMedia: true,
            buffer,
            mediaInfo,
            tipoLancamento: deducedTipo,
            categoria: deducedCategoria,
            analysis,
          };

          activeSessions.set(remoteJid, newSession);

          await sock.sendMessage(
            remoteJid,
            { text: buildValueConfirmationPrompt(newSession) },
            { quoted: msg }
          );
          continue;
        }

        // ====================================================================
        // PROCESSAMENTO DAS ETAPAS POR TEXTO
        // ====================================================================
        if (!textMessage || !activeSessions.has(remoteJid)) {
          continue;
        }

        const session = activeSessions.get(remoteJid);

        // ETAPA ESPECIAL (Investimentos com Foto): Usuário respondeu o nome do Banco/Corretora
        if (session.step === 'AWAITING_BANCO_INVESTIMENTO') {
          session.analysis.instituicao = textMessage.trim();
          session.step = 'AWAITING_CONFIRMACAO';
          activeSessions.set(remoteJid, session);

          await sock.sendMessage(remoteJid, {
            text: buildValueConfirmationPrompt(session),
          });
          continue;
        }

        // ETAPA 1 (Fluxo /start): Escolhendo Tipo (1 - Recebidos, 2 - Gastos, 3 - Investimentos)
        if (session.step === 'AWAITING_TIPO') {
          const chosenTipo = matchMenuOption(textMessage, TIPOS_REGISTRO);
          if (!chosenTipo) {
            await sock.sendMessage(remoteJid, {
              text: `Opção inválida. Escolha de 1 a 3:\n\n${MENU_TIPO}`,
            });
            continue;
          }

          session.tipoLancamento = chosenTipo;
          session.analysis.tipo_lancamento = chosenTipo;

          // A foto já foi recebida, mas a IA não leu: vai direto para o preenchimento manual
          if (session.manualFallback) {
            const nextText = advanceToManualDetails(session);
            activeSessions.set(remoteJid, session);
            await sock.sendMessage(remoteJid, { text: nextText });
            continue;
          }

          session.step = 'AWAITING_MEDIA';
          activeSessions.set(remoteJid, session);

          await sock.sendMessage(remoteJid, {
            text: 'Envie a foto da nota/comprovante (ou envie *0* para continuar sem foto).',
          });
          continue;
        }

        // ETAPA 2 (Fluxo /start): Aguardando Foto ou "0" para continuar sem foto
        if (session.step === 'AWAITING_MEDIA') {
          if (textMessage.trim() === '0') {
            session.hasMedia = false;
            if (session.tipoLancamento === 'Investimentos') {
              session.step = 'AWAITING_BANCO_SEM_FOTO';
              activeSessions.set(remoteJid, session);
              await sock.sendMessage(remoteJid, {
                text: 'Continuando sem comprovante.\n\n🏦 *Em qual banco ou corretora está sendo depositado este investimento?*',
              });
            } else {
              session.step = 'AWAITING_CATEGORIA';
              activeSessions.set(remoteJid, session);
              await sock.sendMessage(remoteJid, {
                text: `Continuando sem comprovante.\n\n${MENU_CATEGORIA}`,
              });
            }
          } else {
            await sock.sendMessage(remoteJid, {
              text: 'Por favor, envie uma *foto/PDF* do comprovante ou envie *0* para continuar sem foto.',
            });
          }
          continue;
        }

        // ETAPA 2.1 (Fluxo /start sem foto - Investimentos): Banco -> Nome do Ativo
        if (session.step === 'AWAITING_BANCO_SEM_FOTO') {
          session.analysis.instituicao = textMessage.trim();
          session.step = 'AWAITING_ATIVO_SEM_FOTO';
          activeSessions.set(remoteJid, session);
          await sock.sendMessage(remoteJid, {
            text: 'Qual o ativo/tipo de investimento? (ex: *CDB*, *Tesouro Direto*, *Fundo*, *Ações*):',
          });
          continue;
        }

        if (session.step === 'AWAITING_ATIVO_SEM_FOTO') {
          session.categoria = textMessage.trim();
          session.analysis.categoria = textMessage.trim();
          session.analysis.tipo_transacao = 'Aplicação';
          session.step = 'AWAITING_VALOR_SEM_FOTO';
          activeSessions.set(remoteJid, session);
          await sock.sendMessage(remoteJid, { text: 'Valor investido?' });
          continue;
        }

        // ETAPA 3 (Fluxo /start sem foto): Escolhendo Categoria
        if (session.step === 'AWAITING_CATEGORIA') {
          const chosenCat =
            matchMenuOption(textMessage, CATEGORIAS) || textMessage.trim();
          session.categoria = chosenCat;
          session.analysis.categoria = chosenCat;
          session.step = 'AWAITING_MEIO_PAGAMENTO';
          activeSessions.set(remoteJid, session);

          await sock.sendMessage(remoteJid, { text: MENU_MEIO_PAGAMENTO });
          continue;
        }

        // ETAPA 4 (Sem Foto): Escolhendo Meio de Pagamento
        if (session.step === 'AWAITING_MEIO_PAGAMENTO') {
          const chosenMeio = matchMenuOption(textMessage, MEIOS_PAGAMENTO);
          if (!chosenMeio) {
            await sock.sendMessage(remoteJid, {
              text: `Opção inválida. Escolha de 1 a 5:\n\n${MENU_MEIO_PAGAMENTO}`,
            });
            continue;
          }

          session.analysis.tipo_transacao = chosenMeio;
          session.step = 'AWAITING_VALOR_SEM_FOTO';
          activeSessions.set(remoteJid, session);
          await sock.sendMessage(remoteJid, { text: 'Valor?' });
          continue;
        }

        // ETAPA 5 (Sem Foto): Informando Valor
        if (session.step === 'AWAITING_VALOR_SEM_FOTO') {
          const cleanVal = textMessage.replace(/[r$\s]/gi, '').replace(',', '.');
          const parsedVal = parseFloat(cleanVal);
          if (isNaN(parsedVal) || parsedVal <= 0) {
            await sock.sendMessage(remoteJid, {
              text: 'Por favor, digite um valor numérico válido (ex: *50* ou *26.90*).',
            });
            continue;
          }

          session.analysis.valor = parsedVal;
          session.analysis.valor_formatado = parsedVal.toLocaleString('pt-BR', {
            style: 'currency',
            currency: 'BRL',
          });

          if (session.tipoLancamento === 'Recebidos') {
            session.step = 'AWAITING_PAGADOR_SEM_FOTO';
            activeSessions.set(remoteJid, session);
            await sock.sendMessage(remoteJid, {
              text: 'Quem enviou o valor (Pagador)? (Ou envie *0* para pular):',
            });
          } else {
            session.step = 'AWAITING_DATA_SEM_FOTO';
            activeSessions.set(remoteJid, session);
            const todayStr = new Date().toLocaleDateString('pt-BR');
            await sock.sendMessage(remoteJid, {
              text: `Data do pagamento? (Envie *0* para hoje *${todayStr}* ou digite a data no formato *DD/MM/AAAA*):`,
            });
          }
          continue;
        }

        // ETAPA 5.1 (Sem Foto - Apenas quando for Recebidos): Informando quem enviou o valor
        if (session.step === 'AWAITING_PAGADOR_SEM_FOTO') {
          session.analysis.pagador =
            textMessage.trim() === '0' ? '' : textMessage.trim();
          session.step = 'AWAITING_DATA_SEM_FOTO';
          activeSessions.set(remoteJid, session);

          const todayStr = new Date().toLocaleDateString('pt-BR');
          await sock.sendMessage(remoteJid, {
            text: `Data do recebimento? (Envie *0* para hoje *${todayStr}* ou digite a data no formato *DD/MM/AAAA*):`,
          });
          continue;
        }

        // ETAPA 6 (Sem Foto): Informando Data do Pagamento e salvando
        if (session.step === 'AWAITING_DATA_SEM_FOTO') {
          if (textMessage.trim() === '0' || lowerText === 'hoje') {
            session.analysis.data_pagamento =
              new Date().toLocaleDateString('pt-BR');
          } else {
            const monthInfo = extractMonthInfo(textMessage);
            session.analysis.data_pagamento = monthInfo.normalizedDate;
          }

          activeSessions.delete(remoteJid);
          await finalizeAndSaveSession(sock, remoteJid, session, msg);
          continue;
        }

        // ETAPA FINAL (Com Foto): Confirmação ou edição dos dados deduzidos pela IA
        if (session.step === 'AWAITING_CONFIRMACAO') {
          const decision = await interpretConfirmationReply(
            textMessage,
            session.analysis
          );

          if (decision.dados_atualizados) {
            session.analysis = decision.dados_atualizados;
            if (decision.dados_atualizados.tipo_lancamento) {
              session.tipoLancamento =
                decision.dados_atualizados.tipo_lancamento;
            }
            if (decision.dados_atualizados.categoria) {
              session.categoria = decision.dados_atualizados.categoria;
            }
          }

          if (decision.acao === 'CONFIRMAR') {
            activeSessions.delete(remoteJid);
            await finalizeAndSaveSession(sock, remoteJid, session, msg);
          } else if (decision.acao === 'CANCELAR') {
            activeSessions.delete(remoteJid);
            await sock.sendMessage(remoteJid, {
              text: '❌ Registro cancelado e comprovante descartado.',
            });
          } else if (decision.acao === 'EDITAR') {
            activeSessions.set(remoteJid, session);
            await sock.sendMessage(remoteJid, {
              text:
                `✏️ *Dados atualizados!*\n\n` +
                buildValueConfirmationPrompt(session),
            });
          } else {
            await sock.sendMessage(remoteJid, {
              text: decision.resposta_bot,
            });
          }
        }
      } catch (err) {
        console.error('❌ Erro ao processar mensagem:', err.message);
        if (msg?.key?.remoteJid) {
          await sock.sendMessage(msg.key.remoteJid, {
            text: `⚠️ Ocorreu um erro ao salvar: ${err.message}`,
          });
        }
      }
    }
  });
}

startBot();
