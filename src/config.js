const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const config = {
  gemini: {
    apiKey: process.env.GEMINI_API_KEY || '',
    model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
  },
  google: {
    driveFolderId: process.env.GOOGLE_DRIVE_FOLDER_ID || '',
    sheetsId: process.env.GOOGLE_SHEETS_ID || '',
    sheetsTab: process.env.GOOGLE_SHEETS_TAB || 'Comprovantes',
    appsScriptUrl: process.env.GOOGLE_APPS_SCRIPT_URL || '',
    oauthClientPath: path.resolve(
      __dirname,
      '..',
      process.env.GOOGLE_OAUTH_CLIENT_PATH || './oauth-client.json'
    ),
    tokenPath: path.resolve(
      __dirname,
      '..',
      process.env.GOOGLE_TOKEN_PATH || './token.json'
    ),
    serviceAccountPath: path.resolve(
      __dirname,
      '..',
      process.env.GOOGLE_APPLICATION_CREDENTIALS || './credentials.json'
    ),
  },
  bot: {
    onlyReceipts: (process.env.ONLY_RECEIPTS || 'true').toLowerCase() === 'true',
    sendConfirmationReply:
      (process.env.SEND_CONFIRMATION_REPLY || 'true').toLowerCase() === 'true',
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

  if (missing.length > 0) {
    console.warn(
      `\n⚠️  ATENÇÃO: As seguintes variáveis não estão configuradas no arquivo .env:\n   -> ${missing.join(', ')}\n`
    );
  }
}

module.exports = { config, validateConfig };
