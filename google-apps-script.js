/**
 * ============================================================================
 * PONTE PESSOAL GOOGLE DRIVE + GOOGLE SHEETS (COM PASTAS MENSAIS AUTOMÁTICAS)
 * ============================================================================
 *
 * PASSO A PASSO PARA ATUALIZAR NO SEU GOOGLE SHEETS:
 * 1. Na sua planilha, abra Extensões > Apps Script, apague tudo, cole este código e salve (Ctrl+S).
 * 2. Selecione a função "autorizarPermissoes" no topo e clique em "▷ Executar" (para garantir que Drive e Sheets estão liberados).
 * 3. Clique em "Implantar" > "Gerenciar implantações" > Ícone de Lápis (Editar) > Versão: "Nova versão" >
 *    Quem pode acessar: "Qualquer pessoa" > "Implantar".
 */

const DEFAULT_FOLDER_ID = '';
const DEFAULT_SHEET_ID = '';
const DEFAULT_TAB_NAME = 'Comprovantes';

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

const CABECALHOS = [
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
 * Execute esta função uma vez clicando em "▷ Executar" no topo do Apps Script
 * para o Google pedir e liberar a permissão do seu Drive e Planilha!
 */
function autorizarPermissoes() {
  DriveApp.getRootFolder();
  SpreadsheetApp.getActiveSpreadsheet();
  Logger.log('✅ Permissões do Google Drive e Google Sheets autorizadas com sucesso!');
}

/**
 * Permite testar no navegador se a URL está pública e ativa.
 */
function doGet() {
  return ContentService.createTextOutput(
    JSON.stringify({
      ok: true,
      message: 'Ponte Google Drive + Google Sheets (Pastas Mensais) ativa e funcionando!',
    })
  ).setMimeType(ContentService.MimeType.JSON);
}

/**
 * Extrai o nome da pasta do mês (ex: "2026-03 (Março)") a partir da data DD/MM/AAAA
 * caso o payload não tenha enviado monthFolderName.
 */
function resolveMonthFolderFromDate(dataPagamentoStr) {
  const now = new Date();
  let monthNum = now.getMonth() + 1;
  let yearNum = now.getFullYear();

  const raw = String(dataPagamentoStr || '').trim();
  const match = raw.match(/^(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?$/);
  if (match) {
    const m = parseInt(match[2], 10);
    let y = match[3] ? parseInt(match[3], 10) : yearNum;
    if (y < 100) y += 2000;
    if (m >= 1 && m <= 12) {
      monthNum = m;
      yearNum = y;
    }
  }

  const monthStr = ('0' + monthNum).slice(-2);
  const monthName = NOMES_MESES[monthNum - 1] || 'Mês';
  return yearNum + '-' + monthStr + ' (' + monthName + ')';
}

/**
 * Verifica se a pasta do mês já existe dentro da pasta principal no Google Drive.
 * Se existir, retorna a pasta; se não existir, cria automaticamente!
 */
function getOrCreateMonthFolder(parentFolder, monthFolderName) {
  if (!monthFolderName) return parentFolder;
  const existingFolders = parentFolder.getFoldersByName(monthFolderName);
  if (existingFolders.hasNext()) {
    return existingFolders.next();
  }
  return parentFolder.createFolder(monthFolderName);
}

function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents);
    const folderId = payload.folderId || DEFAULT_FOLDER_ID;
    const sheetId = payload.sheetId || DEFAULT_SHEET_ID;
    const tabName = payload.tabName || DEFAULT_TAB_NAME;
    const d = payload.data || {};

    // Determina a pasta do mês pela data em que o comprovante foi pago (ex: 23/03/2026 -> 2026-03 (Março))
    const monthFolderName =
      payload.monthFolderName ||
      d.pasta_mes ||
      resolveMonthFolderFromDate(d.data_pagamento);

    let fileId = 'sem_arquivo';
    let fileName = 'Sem comprovante';
    let driveUrl = 'Sem comprovante';

    // 1. Se houver arquivo (foto ou PDF), verifica/cria a pasta do mês no Google Drive e salva lá dentro
    if (payload.hasFile !== false && payload.fileBase64) {
      const parentFolder = DriveApp.getFolderById(folderId);
      const targetMonthFolder = getOrCreateMonthFolder(
        parentFolder,
        monthFolderName
      );

      const decodedBytes = Utilities.base64Decode(payload.fileBase64);
      const blob = Utilities.newBlob(
        decodedBytes,
        payload.mimeType || 'image/jpeg',
        payload.fileName || 'Comprovante.jpg'
      );
      const file = targetMonthFolder.createFile(blob);
      fileId = file.getId();
      fileName = file.getName();
      driveUrl = file.getUrl();
    }

    // 2. Abre a planilha e garante que a aba e os cabeçalhos atualizados existem
    const ss = sheetId
      ? SpreadsheetApp.openById(sheetId)
      : SpreadsheetApp.getActiveSpreadsheet();
    let sheet = ss.getSheetByName(tabName);
    if (!sheet) {
      sheet = ss.insertSheet(tabName);
    }

    if (sheet.getLastRow() === 0) {
      sheet.appendRow(CABECALHOS);
      sheet.getRange(1, 1, 1, CABECALHOS.length).setFontWeight('bold');
    } else {
      // Atualiza cabeçalhos na linha 1 caso tenham mudado
      sheet
        .getRange(1, 1, 1, CABECALHOS.length)
        .setValues([CABECALHOS])
        .setFontWeight('bold');
    }

    // 3. Adiciona a linha com os dados completos do lançamento
    sheet.appendRow([
      d.mes_competencia || monthFolderName.slice(0, 7),
      d.data_pagamento || 'Não identificada',
      d.hora_pagamento || '',
      d.tipo_lancamento || 'Gastos',
      d.categoria || 'Outros',
      d.tipo_transacao || 'Outro',
      d.valor !== null && d.valor !== undefined
        ? d.valor
        : d.valor_formatado || 'Não identificado',
      d.pagador || 'Não identificado',
      d.recebedor || 'Não identificado',
      d.instituicao || 'Não identificada',
      d.id_transacao || 'Não identificado',
      d.senderName || '',
      d.senderPhone || '',
      d.receivedAt || new Date().toLocaleString('pt-BR'),
      driveUrl,
    ]);

    return ContentService.createTextOutput(
      JSON.stringify({
        ok: true,
        id: fileId,
        name: fileName,
        webViewLink: driveUrl,
        monthFolderName: monthFolderName,
      })
    ).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(
      JSON.stringify({
        ok: false,
        error: err.toString(),
      })
    ).setMimeType(ContentService.MimeType.JSON);
  }
}
