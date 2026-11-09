const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { config } = require('../config');

let lastUploadedViaAppsScript = false;

const NOMES_MESES = [
  'Janeiro',
  'Fevereiro',
  'Março',
  'Abril',
  'Maio',
  'Junho',
  'Julho',
  'Agosto',
  'Setembro',
  'Outubro',
  'Novembro',
  'Dezembro',
];

const CABECALHOS_PLANILHA = [
  'Mês Competência',
  'Data do Pagamento',
  'Hora do Pagamento',
  'Tipo',
  'Categoria',
  'Meio de Pagamento',
  'Valor (R$)',
  'Pagador',
  'Recebedor',
  'Banco / Instituição',
  'ID / Autenticação',
  'Nome Contato (WhatsApp)',
  'Telefone Remetente',
  'Data/Hora Registro',
  'Link do Comprovante',
];

/**
 * Recarrega o .env dinamicamente caso o usuário tenha atualizado alguma URL sem reiniciar o bot.
 */
function refreshEnvConfig() {
  dotenv.config({
    path: path.resolve(__dirname, '..', '..', '.env'),
    override: true,
  });
  config.google.driveFolderId =
    process.env.GOOGLE_DRIVE_FOLDER_ID || config.google.driveFolderId;
  config.google.sheetsId =
    process.env.GOOGLE_SHEETS_ID || config.google.sheetsId;
  config.google.sheetsTab =
    process.env.GOOGLE_SHEETS_TAB || config.google.sheetsTab;
  config.google.appsScriptUrl =
    process.env.GOOGLE_APPS_SCRIPT_URL || config.google.appsScriptUrl;
}

/**
 * Extrai o mês e ano da data de pagamento do comprovante (ex: "23/03/2026" -> mês 03, ano 2026).
 * Se não conseguir identificar uma data válida, usa a data atual como fallback.
 *
 * @param {string} dataPagamentoStr Data em formato DD/MM/AAAA
 * @returns {{ month: string, year: string, monthCompetencia: string, monthFolderName: string, normalizedDate: string }}
 */
function extractMonthInfo(dataPagamentoStr) {
  const now = new Date();
  let day = String(now.getDate()).padStart(2, '0');
  let monthNum = now.getMonth() + 1;
  let yearNum = now.getFullYear();

  const raw = String(dataPagamentoStr || '').trim();

  // Tenta casar DD/MM/AAAA ou DD-MM-AAAA ou DD/MM/AA
  const brMatch = raw.match(/^(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?$/);
  // Tenta casar AAAA-MM-DD
  const isoMatch = raw.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);

  if (brMatch) {
    const d = parseInt(brMatch[1], 10);
    const m = parseInt(brMatch[2], 10);
    let y = brMatch[3] ? parseInt(brMatch[3], 10) : yearNum;
    if (y < 100) y += 2000;

    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      day = String(d).padStart(2, '0');
      monthNum = m;
      yearNum = y;
    }
  } else if (isoMatch) {
    const y = parseInt(isoMatch[1], 10);
    const m = parseInt(isoMatch[2], 10);
    const d = parseInt(isoMatch[3], 10);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      day = String(d).padStart(2, '0');
      monthNum = m;
      yearNum = y;
    }
  }

  const monthStr = String(monthNum).padStart(2, '0');
  const yearStr = String(yearNum);
  const monthName = NOMES_MESES[monthNum - 1] || 'Mês';

  return {
    month: monthStr,
    year: yearStr,
    monthCompetencia: `${monthStr}/${yearStr}`,
    monthFolderName: `${yearStr}-${monthStr} (${monthName})`,
    normalizedDate: `${day}/${monthStr}/${yearStr}`,
  };
}

/**
 * Salva uma cópia local da foto na pasta data/fotos/<monthFolderName>/
 */
function saveLocalPhotoBackup(fileBuffer, fileName, monthFolderName) {
  if (!fileBuffer) return null;
  try {
    const photosDir = path.resolve(
      __dirname,
      '..',
      '..',
      'data',
      'fotos',
      monthFolderName || 'Geral'
    );
    if (!fs.existsSync(photosDir)) {
      fs.mkdirSync(photosDir, { recursive: true });
    }
    const localPath = path.join(photosDir, fileName);
    fs.writeFileSync(localPath, fileBuffer);
    return localPath;
  } catch (err) {
    console.warn('⚠️ Não foi possível salvar cópia local da foto:', err.message);
    return null;
  }
}

/**
 * Envia a foto (opcional) + dados da planilha para o Google Apps Script,
 * que verifica/cria a pasta do mês no Google Drive e adiciona a linha no Google Sheets.
 */
async function sendViaAppsScript(
  fileBuffer,
  fileName,
  mimeType,
  receiptData,
  monthFolderName
) {
  const payload = {
    folderId: config.google.driveFolderId,
    sheetId: config.google.sheetsId,
    tabName: config.google.sheetsTab,
    monthFolderName,
    hasFile: Boolean(fileBuffer),
    fileName: fileName || '',
    mimeType: mimeType || '',
    fileBase64: fileBuffer ? fileBuffer.toString('base64') : '',
    data: receiptData || {},
  };

  const response = await fetch(config.google.appsScriptUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(payload),
    redirect: 'follow',
  });

  const text = await response.text();

  if (response.status === 401 || response.status === 403) {
    throw new Error(
      `O Google Apps Script recusou o acesso (HTTP ${response.status}). No editor do Apps Script: 1) Cole o novo google-apps-script.js e salve (Ctrl+S), 2) Clique em "▷ Executar" na função autorizarPermissoes, e 3) Vá em Implantar > Gerenciar implantações > Lápis > Nova versão > Quem pode acessar: "Qualquer pessoa".`
    );
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(
      `Resposta inesperada do Google Apps Script (HTTP ${response.status}): ${text
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 200)}`
    );
  }

  if (!json.ok) {
    throw new Error(json.error || 'Erro desconhecido no Google Apps Script');
  }

  return {
    id: json.id || 'sem_arquivo',
    name: json.name || fileName || 'Sem comprovante',
    webViewLink: json.webViewLink || 'Sem comprovante',
    monthFolderName: json.monthFolderName || monthFolderName,
  };
}

/**
 * Faz upload de um arquivo (ou registra lançamento sem arquivo) na pasta do mês correspondente do Google Drive
 * e registra na planilha via Apps Script.
 */
async function uploadToDrive(
  fileBuffer,
  fileName,
  mimeType,
  receiptData = {}
) {
  refreshEnvConfig();
  lastUploadedViaAppsScript = false;

  const monthInfo = extractMonthInfo(receiptData.data_pagamento);
  receiptData.mes_competencia = monthInfo.monthCompetencia;
  receiptData.data_pagamento = monthInfo.normalizedDate;
  receiptData.pasta_mes = monthInfo.monthFolderName;

  const localPhotoPath = saveLocalPhotoBackup(
    fileBuffer,
    fileName,
    monthInfo.monthFolderName
  );

  if (config.google.appsScriptUrl) {
    const result = await sendViaAppsScript(
      fileBuffer,
      fileName,
      mimeType,
      receiptData,
      monthInfo.monthFolderName
    );
    lastUploadedViaAppsScript = true;
    return result;
  }

  console.warn(
    '⚠️ GOOGLE_APPS_SCRIPT_URL ainda não preenchida no .env. Salvo localmente.'
  );
  return {
    id: 'local',
    name: fileName || 'Sem comprovante',
    webViewLink: fileBuffer
      ? localPhotoPath || `Salvo localmente (${fileName})`
      : 'Sem comprovante',
    monthFolderName: monthInfo.monthFolderName,
  };
}

/**
 * Salva o backup local em CSV (compatível com Excel) e verifica se já foi gravado no Google Sheets.
 */
async function appendReceiptToSheet(data) {
  const monthInfo = extractMonthInfo(data.data_pagamento);

  const rowValues = [
    data.mes_competencia || monthInfo.monthCompetencia,
    data.data_pagamento || monthInfo.normalizedDate,
    data.hora_pagamento || '',
    data.tipo_lancamento || 'Gastos',
    data.categoria || 'Outros',
    data.tipo_transacao || 'Outro',
    data.valor !== null && data.valor !== undefined
      ? data.valor
      : data.valor_formatado || 'Não identificado',
    data.pagador || 'Não identificado',
    data.recebedor || 'Não identificado',
    data.instituicao || 'Não identificada',
    data.id_transacao || 'Não identificado',
    data.senderName || '',
    data.senderPhone || '',
    data.receivedAt || new Date().toLocaleString('pt-BR'),
    data.driveLink || 'Sem comprovante',
  ];

  // Salva sempre uma cópia local em CSV (compatível com Excel)
  saveLocalExcelBackup(rowValues);

  if (!lastUploadedViaAppsScript) {
    console.log(
      '💾 Registro salvo na planilha Excel local: data/comprovantes_backup.csv'
    );
  }
}

/**
 * Salva um backup local em CSV (com BOM UTF-8 e separador ';' para abrir direto no Excel em PT-BR).
 */
function saveLocalExcelBackup(rowValues) {
  try {
    const dataDir = path.resolve(__dirname, '..', '..', 'data');
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    const csvPath = path.join(dataDir, 'comprovantes_backup.csv');
    const fileExists = fs.existsSync(csvPath);

    const escapeCsv = (val) => {
      const str = String(val ?? '').replace(/"/g, '""');
      return `"${str}"`;
    };

    let content = '';
    if (!fileExists) {
      content += '\uFEFF' + CABECALHOS_PLANILHA.map(escapeCsv).join(';') + '\n';
    }
    content += rowValues.map(escapeCsv).join(';') + '\n';

    fs.appendFileSync(csvPath, content, 'utf8');
  } catch (err) {
    console.warn('⚠️ Não foi possível atualizar o backup CSV local:', err.message);
  }
}

module.exports = {
  extractMonthInfo,
  uploadToDrive,
  appendReceiptToSheet,
};
