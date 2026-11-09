const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const geminiModels = (
  process.env.GEMINI_MODEL || 'gemini-2.5-flash,gemini-2.5-flash-lite'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const config = {
  gemini: {
    apiKey: process.env.GEMINI_API_KEY || '',
    // Lista de modelos em ordem de preferência; se um estourar a cota, o próximo é usado.
    models: geminiModels,
    model: geminiModels[0],
  },
  google: {
    driveFolderId: process.env.GOOGLE_DRIVE_FOLDER_ID || '',
    sheetsId: process.env.GOOGLE_SHEETS_ID || '',
    sheetsTab: process.env.GOOGLE_SHEETS_TAB || 'Comprovantes',
    appsScriptUrl: process.env.GOOGLE_APPS_SCRIPT_URL || '',
  },
  bot: {
    onlyReceipts: (process.env.ONLY_RECEIPTS || 'true').toLowerCase() === 'true',
    ignoreGroups:
      (process.env.IGNORE_GROUPS || 'false').toLowerCase() === 'true',
    allowedChats: (process.env.ALLOWED_CHATS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  },
};

function validateConfig() {
  const missing = [];
  if (!config.gemini.apiKey) missing.push('GEMINI_API_KEY');
  if (!config.google.driveFolderId) missing.push('GOOGLE_DRIVE_FOLDER_ID');
  if (!config.google.sheetsId) missing.push('GOOGLE_SHEETS_ID');
  if (!config.google.appsScriptUrl) missing.push('GOOGLE_APPS_SCRIPT_URL');

  if (missing.length > 0) {
    console.warn(
      `\n⚠️  ATENÇÃO: As seguintes variáveis não estão configuradas no arquivo .env:\n   -> ${missing.join(', ')}\n`
    );
  }
}

module.exports = { config, validateConfig };
