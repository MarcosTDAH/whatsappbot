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
 * Formata o número do remetente (ex: 5511999999999@s.whatsapp.net -> +5511999999999).
 */
function formatPhoneNumber(jid) {
  if (!jid) return 'Desconhecido';
  const raw = jid.split('@')[0].split(':')[0];
  return `+${raw}`;
}

/**
 * Monta a pergunta de confirmação de valor e data após a categoria ser escolhida.
 */
function buildValueConfirmationPrompt(session) {
  const { analysis, tipoLancamento, categoria } = session;
  const monthInfo = extractMonthInfo(analysis.data_pagamento);
  const valorDetectado = analysis.valor_formatado || 'Não identificado';

  return (
    `Valor? (Detectamos *${valorDetectado}* na nota em *${monthInfo.normalizedDate}*)\n\n` +
    `📂 *Tipo:* ${tipoLancamento} | *Categoria:* ${categoria}\n` +
    `💳 *Meio:* ${analysis.tipo_transacao || 'Outro'}\n` +
    `📁 *Pasta no Drive:* ${monthInfo.monthFolderName}\n\n` +
    `👉 Digite *Confirmar* (ou *Sim*) para salvar, digite outro valor (ex: *26.90*), ou altere a data (ex: *data 23/03/2026*).`
  );
}

/**
 * Finaliza a sessão salvando o comprovante na pasta do mês correspondente ao pagamento
 * no Google Drive e registrando a linha no Google Sheets.
 */
async function finalizeAndSaveSession(sock, remoteJid, session, triggerMsg) {
  const {
    hasMedia,
    buffer,
    mediaInfo,
    senderName,
    senderPhone,
    tipoLancamento,
    categoria,
    analysis,
  } = session;

  const monthInfo = extractMonthInfo(analysis.data_pagamento);
  analysis.data_pagamento = monthInfo.normalizedDate;

  const now = new Date();
  const timePrefix = now.toTimeString().slice(0, 8).replace(/:/g, '-');
  const dateForFile = monthInfo.normalizedDate.split('/').reverse().join('-');

  let fileName = '';
  if (hasMedia && buffer && mediaInfo) {
    const cleanTipo = sanitizeFileName(tipoLancamento || 'Comprovante');
    const cleanTarget = sanitizeFileName(
      analysis.recebedor && analysis.recebedor !== 'Não identificado'
        ? analysis.recebedor
        : analysis.pagador && analysis.pagador !== 'Não identificado'
          ? analysis.pagador
          : senderName
    );
    const cleanValor = sanitizeFileName(
      analysis.valor_formatado && analysis.valor_formatado !== 'Não identificado'
        ? analysis.valor_formatado
        : 'sem_valor'
    );

    fileName = `${cleanTipo}_${dateForFile}_${timePrefix}_${cleanTarget}_${cleanValor}.${mediaInfo.extension}`;

    await sock.sendMessage(remoteJid, {
      text: `Enviando comprovante para o Google Drive (Pasta: *${monthInfo.monthFolderName}*)...`,
    });
  }

  const receivedAt = now.toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
  });

  const receiptMetadata = {
    receivedAt,
    senderName,
    senderPhone,
    tipo_lancamento: tipoLancamento,
    categoria,
    mes_competencia: monthInfo.monthCompetencia,
    pasta_mes: monthInfo.monthFolderName,
    ...analysis,
    caption: mediaInfo?.caption || '',
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

  let finalMessage =
    `Registrado com sucesso ✅\n\n` +
    `📂 *Tipo:* ${tipoLancamento}\n` +
    `🏷️ *Categoria:* ${categoria}\n` +
    `💳 *Meio:* ${analysis.tipo_transacao || 'Outro'}\n` +
    `💰 *Valor:* ${analysis.valor_formatado || 'Não identificado'}\n` +
    `📅 *Data do Pagamento:* ${monthInfo.normalizedDate}\n` +
    `📁 *Pasta do Mês:* ${monthInfo.monthFolderName}`;

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
  for (const [key, val] of Object.entries(optionsMap)) {
    if (val.toLowerCase() === lower) return val;
  }
  return null;
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
        '👀 Envie /start ou mande diretamente a foto/PDF de um comprovante...\n'
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

        const senderJid = isGroup ? msg.key.participant : remoteJid;
        const senderPhone = formatPhoneNumber(senderJid);
        const senderName = msg.pushName || senderPhone;

        // ====================================================================
        // COMANDO /start (ou /cancelar)
        // ====================================================================
        const lowerText = textMessage.toLowerCase();
        if (['/start', 'start', '/menu', 'menu', '/novo'].includes(lowerText)) {
          activeSessions.set(remoteJid, {
            step: 'AWAITING_TIPO',
            hasMedia: false,
            buffer: null,
            mediaInfo: null,
            senderName,
            senderPhone,
            tipoLancamento: null,
            categoria: null,
            analysis: {
              eh_comprovante: true,
              tipo_transacao: 'Outro',
              valor: null,
              valor_formatado: 'Não identificado',
              data_pagamento: new Date().toLocaleDateString('pt-BR'),
              hora_pagamento: new Date().toLocaleTimeString('pt-BR', {
                hour: '2-digit',
                minute: '2-digit',
              }),
              pagador: senderName,
              recebedor: 'Não identificado',
              instituicao: 'Não identificada',
              id_transacao: 'Não identificado',
            },
          });

          await sock.sendMessage(remoteJid, { text: MENU_TIPO });
          continue;
        }

        if (['/cancelar', 'cancelar', 'sair'].includes(lowerText)) {
          if (activeSessions.has(remoteJid)) {
            activeSessions.delete(remoteJid);
            await sock.sendMessage(remoteJid, {
              text: '❌ Operação cancelada. Envie */start* ou uma foto quando quiser registrar novamente.',
            });
            continue;
          }
        }

        // ====================================================================
        // RECEBIMENTO DE FOTO OU PDF
        // ====================================================================
        if (mediaInfo) {
          console.log(
            `\n📥 Mídia recebida de ${senderName} (${senderPhone}) [${mediaInfo.mimeType}]`
          );

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

          console.log('🤖 Analisando imagem/PDF com IA (Gemini Vision)...');
          const analysis = await analyzeReceipt(buffer, mediaInfo.mimeType);

          if (config.bot.onlyReceipts && !analysis.eh_comprovante) {
            console.log(
              '⏭️  Imagem ignorada: A IA identificou que não é um comprovante.'
            );
            await sock.sendMessage(remoteJid, {
              text: '⚠️ Não identifiquei esta imagem como um comprovante ou nota fiscal.',
            });
            continue;
          }

          const existingSession = activeSessions.get(remoteJid);

          // Se o usuário já tinha iniciado via /start e escolhido o Tipo (Recebidos/Gastos/Investimentos)
          if (existingSession && existingSession.tipoLancamento) {
            existingSession.hasMedia = true;
            existingSession.buffer = buffer;
            existingSession.mediaInfo = mediaInfo;
            existingSession.analysis = analysis;
            existingSession.step = 'AWAITING_CATEGORIA';
            activeSessions.set(remoteJid, existingSession);

            await sock.sendMessage(remoteJid, { text: MENU_CATEGORIA });
          } else {
            // O usuário mandou a foto direto sem /start: guarda a foto e pergunta o Tipo primeiro
            activeSessions.set(remoteJid, {
              step: 'AWAITING_TIPO',
              hasMedia: true,
              buffer,
              mediaInfo,
              senderName,
              senderPhone,
              tipoLancamento: null,
              categoria: null,
              analysis,
            });

            await sock.sendMessage(remoteJid, { text: MENU_TIPO });
          }
          continue;
        }

        // ====================================================================
        // PROCESSAMENTO DAS ETAPAS POR TEXTO
        // ====================================================================
        if (!textMessage || !activeSessions.has(remoteJid)) {
          continue;
        }

        const session = activeSessions.get(remoteJid);

        // ETAPA 1: Escolhendo Tipo (1 - Recebidos, 2 - Gastos, 3 - Investimentos)
        if (session.step === 'AWAITING_TIPO') {
          const chosenTipo = matchMenuOption(textMessage, TIPOS_REGISTRO);
          if (!chosenTipo) {
            await sock.sendMessage(remoteJid, {
              text: `Opção inválida. Por favor, escolha um número de 1 a 3:\n\n${MENU_TIPO}`,
            });
            continue;
          }

          session.tipoLancamento = chosenTipo;

          // Se já enviou a foto antes, pula direto para Categoria
          if (session.hasMedia) {
            session.step = 'AWAITING_CATEGORIA';
            activeSessions.set(remoteJid, session);
            await sock.sendMessage(remoteJid, { text: MENU_CATEGORIA });
          } else {
            session.step = 'AWAITING_MEDIA';
            activeSessions.set(remoteJid, session);
            await sock.sendMessage(remoteJid, {
              text: 'Envie a foto da nota/cupom fiscal (ou envie *0* para continuar sem foto).',
            });
          }
          continue;
        }

        // ETAPA 2: Aguardando Foto ou "0" para continuar sem foto
        if (session.step === 'AWAITING_MEDIA') {
          if (textMessage.trim() === '0') {
            session.hasMedia = false;
            session.step = 'AWAITING_CATEGORIA';
            activeSessions.set(remoteJid, session);
            await sock.sendMessage(remoteJid, {
              text: `Continuando sem comprovante.\n\n${MENU_CATEGORIA}`,
            });
          } else {
            await sock.sendMessage(remoteJid, {
              text: 'Por favor, envie uma *foto/PDF* da nota/cupom fiscal ou envie *0* para continuar sem foto.',
            });
          }
          continue;
        }

        // ETAPA 3: Escolhendo Categoria (1 - Matéria-prima, 2 - Transporte, 3 - Alimentação, 4 - Outros)
        if (session.step === 'AWAITING_CATEGORIA') {
          const chosenCat =
            matchMenuOption(textMessage, CATEGORIAS) || textMessage.trim();
          session.categoria = chosenCat;

          if (session.hasMedia) {
            session.step = 'AWAITING_CONFIRMACAO';
            activeSessions.set(remoteJid, session);
            await sock.sendMessage(remoteJid, {
              text: buildValueConfirmationPrompt(session),
            });
          } else {
            session.step = 'AWAITING_MEIO_PAGAMENTO';
            activeSessions.set(remoteJid, session);
            await sock.sendMessage(remoteJid, { text: MENU_MEIO_PAGAMENTO });
          }
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
          session.step = 'AWAITING_DATA_SEM_FOTO';
          activeSessions.set(remoteJid, session);

          const todayStr = new Date().toLocaleDateString('pt-BR');
          await sock.sendMessage(remoteJid, {
            text: `Data do pagamento? (Envie *0* para hoje *${todayStr}* ou digite a data no formato *DD/MM/AAAA*):`,
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

        // ETAPA FINAL (Com Foto): Confirmação ou edição do Valor / Data lidos na nota
        if (session.step === 'AWAITING_CONFIRMACAO') {
          const decision = await interpretConfirmationReply(
            textMessage,
            session.analysis
          );

          if (decision.dados_atualizados) {
            session.analysis = decision.dados_atualizados;
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
