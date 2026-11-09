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
  'Pagador (Recebidos)',
  'Banco / Instituição',
  'ID / Autenticação',
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

  const brMatch = raw.match(/^(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?$/);
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
 * Expande um registro em 1 ou múltiplas linhas de dados (quando houver mais de 1 investimento na mesma foto).
 */
function expandReceiptRows(data) {
  const isInvestimento = data.tipo_lancamento === 'Investimentos';
  const itens = Array.isArray(data.itens_investimento)
    ? data.itens_investimento
    : [];

  if (isInvestimento && itens.length > 0) {
    return itens.map((item) => {
      const catLabel =
        item.nome_ativo && item.categoria && item.nome_ativo !== item.categoria
          ? `${item.nome_ativo} (${item.categoria})`
          : item.nome_ativo || item.categoria || data.categoria || 'Investimento';

      const itemValor = item.valor ?? data.valor;
      const itemValorFormatado =
        item.valor_formatado ||
        (typeof itemValor === 'number'
          ? itemValor.toLocaleString('pt-BR', {
              style: 'currency',
              currency: 'BRL',
            })
          : data.valor_formatado || 'Não identificado');

      return {
        ...data,
        categoria: catLabel,
        valor: itemValor,
        valor_formatado: itemValorFormatado,
        pagador: '',
      };
    });
  }

  return [
    {
      ...data,
      pagador: data.tipo_lancamento === 'Recebidos' ? data.pagador || '' : '',
    },
  ];
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
 * Envia a foto (opcional) + dados da planilha (1 ou múltiplas linhas de investimentos) para o Google Apps Script.
 */
async function sendViaAppsScript(
  fileBuffer,
  fileName,
  mimeType,
  receiptData,
  monthFolderName
) {
  const expandedRows = expandReceiptRows(receiptData);

  const payload = {
    folderId: config.google.driveFolderId,
    sheetId: config.google.sheetsId,
    tabName: config.google.sheetsTab,
    monthFolderName,
    hasFile: Boolean(fileBuffer),
    fileName: fileName || '',
    mimeType: mimeType || '',
    fileBase64: fileBuffer ? fileBuffer.toString('base64') : '',
    data: expandedRows[0] || receiptData || {},
    rows: expandedRows,
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
  receiptData.pagador =
    receiptData.tipo_lancamento === 'Recebidos'
      ? receiptData.pagador || ''
      : '';

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
 * Salva o backup local em CSV (compatível com Excel) para cada linha (suportando múltiplos investimentos).
 */
async function appendReceiptToSheet(data) {
  const monthInfo = extractMonthInfo(data.data_pagamento);
  const expandedRows = expandReceiptRows(data);

  for (const row of expandedRows) {
    const pagadorRecebidos =
      row.tipo_lancamento === 'Recebidos' ? row.pagador || '' : '';

    const rowValues = [
      row.mes_competencia || monthInfo.monthCompetencia,
      row.data_pagamento || monthInfo.normalizedDate,
      row.hora_pagamento || '',
      row.tipo_lancamento || 'Gastos',
      row.categoria || 'Outros',
      row.tipo_transacao || 'Outro',
      row.valor !== null && row.valor !== undefined
        ? row.valor
        : row.valor_formatado || 'Não identificado',
      pagadorRecebidos,
      row.instituicao || 'Não identificada',
      row.id_transacao || 'Não identificado',
      row.receivedAt || new Date().toLocaleString('pt-BR'),
      data.driveLink || 'Sem comprovante',
    ];

    saveLocalExcelBackup(rowValues);
  }

  if (!lastUploadedViaAppsScript) {
    console.log(
      `💾 ${expandedRows.length} linha(s) salva(s) na planilha Excel local: data/comprovantes_backup.csv`
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
  expandReceiptRows,
  uploadToDrive,
  appendReceiptToSheet,
};
