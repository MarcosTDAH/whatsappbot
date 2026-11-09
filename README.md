# 🤖 Bot de WhatsApp para Gestão Financeira e Comprovantes (Google Drive + Google Sheets + IA)

Bot automatizado em **Node.js** que conecta ao WhatsApp via **QR Code** (usando `@whiskeysockets/baileys`), recebe fotos ou PDFs de comprovantes/notas fiscais (ou lançamentos manuais via `/start`), extrai automaticamente os dados usando **Google Gemini Vision (IA)**, organiza os arquivos em **pastas mensais automáticas no Google Drive** (baseadas na data em que o comprovante foi pago) e registra todas as informações em uma planilha do **Google Sheets** (além de manter um backup local em CSV/Excel).

---

## ✨ Funcionalidades

- 📱 **Conexão direta via QR Code** (sem necessidade de API paga da Meta).
- 💬 **Fluxo Conversacional Guiado (`/start` ou envio direto de foto/PDF)**:
  - **Tipo de Registro**: `1 - Recebidos`, `2 - Gastos`, `3 - Investimentos`.
  - **Categoria**: `1 - Matéria-prima`, `2 - Transporte`, `3 - Alimentação`, `4 - Outros` (ou categoria personalizada digitada).
  - **Meio de Pagamento**: Identificado automaticamente pela IA no comprovante ou escolhido no menu (`Transferência`, `Pix`, `Cartão de crédito`, `Cartão de débito`, `Cédula`) em lançamentos sem foto (`0`).
  - **Revisão e Confirmação**: Mostra o valor e a data detectados na nota antes de salvar, permitindo confirmar com `Confirmar`/`Sim` ou digitar um novo valor/data diretamente no chat.
- 📁 **Pastas Mensais Automáticas por Competência (Data do Pagamento)**:
  - Se você enviar hoje (ex: mês 11) um comprovante pago em `23/03/2026`, o bot identifica o mês `03/2026`, verifica se a pasta **`2026-03 (Março)`** já existe no Google Drive (criando-a caso não exista) e salva o arquivo dentro dela.
- 📊 **Registro Completo no Google Sheets + Backup Excel Local**:
  - Grava `Mês Competência`, `Data do Pagamento`, `Hora`, `Tipo`, `Categoria`, `Meio de Pagamento`, `Valor (R$)`, `Pagador (Recebidos)`, `Instituição`, `ID/Autenticação` e `Link do Comprovante no Drive`.
  - Mantém cópia local das fotos em `data/fotos/<Mês>/` e da planilha em `data/comprovantes_backup.csv`.

---

## 🛠️ Passo 1: Instalar Dependências

1. Instale o **Node.js LTS** ([https://nodejs.org/](https://nodejs.org/)).
2. No terminal, dentro da pasta do projeto, instale os pacotes:

```bash
npm install
```

---

## 🔑 Passo 2: Configurar o Arquivo `.env`

1. Faça uma cópia do arquivo [`.env.example`](file:///c:/Users/marco/OneDrive/Desktop/FACULDADE/analise%20de%20dados/Marcostdah.github.io/whatsappbot/.env.example) e renomeie para `.env`:

```powershell
Copy-Item .env.example .env
```

2. Preencha as variáveis no arquivo `.env`:
   - **`GEMINI_API_KEY`**: Crie sua chave gratuita no [Google AI Studio](https://aistudio.google.com/app/apikey).
   - **`GOOGLE_DRIVE_FOLDER_ID`**: Abra a pasta principal no Google Drive onde as pastas mensais serão criadas e copie o ID final da URL (`drive.google.com/drive/folders/SEU_FOLDER_ID_AQUI`).
   - **`GOOGLE_SHEETS_ID`**: Abra a planilha do Google Sheets onde os dados serão registrados e copie o ID da URL (`docs.google.com/spreadsheets/d/SEU_SHEETS_ID_AQUI/edit`).

---

## 🔐 Passo 3: Conectar sua Planilha e Pasta do Drive (Via Apps Script)

Para usar diretamente o seu próprio e-mail sem precisar configurar OAuth no Google Cloud Console:

1. Abra a sua planilha do Google Sheets e clique em **Extensões > Apps Script**.
2. Apague o código existente, cole todo o conteúdo do arquivo [`google-apps-script.js`](file:///c:/Users/marco/OneDrive/Desktop/FACULDADE/analise%20de%20dados/Marcostdah.github.io/whatsappbot/google-apps-script.js) e salve (`Ctrl + S`).
3. Na barra superior do Apps Script, selecione a função **`autorizarPermissoes`** e clique em **`▷ Executar`** para autorizar o acesso ao seu Google Drive e Google Sheets.
4. Clique em **Implantar > Nova implantação** (ou **Gerenciar implantações > Editar > Nova versão**):
   - **Tipo**: *App da Web*
   - **Executar como**: *Eu (seu próprio e-mail)*
   - **Quem pode acessar**: *Qualquer pessoa*
5. Copie a **URL do app da Web** gerada e cole em `GOOGLE_APPS_SCRIPT_URL=` no seu arquivo `.env`.

---

## ▶️ Passo 4: Iniciar o Bot

Dê dois cliques no atalho [`iniciar-bot.bat`](file:///c:/Users/marco/OneDrive/Desktop/FACULDADE/analise%20de%20dados/Marcostdah.github.io/whatsappbot/iniciar-bot.bat) ou execute no terminal:

```bash
npm start
```

Escaneie o QR Code exibido no terminal e envie `/start` ou uma foto/PDF de comprovante no WhatsApp!

---

## 📂 Estrutura do Projeto

- [`iniciar-bot.bat`](file:///c:/Users/marco/OneDrive/Desktop/FACULDADE/analise%20de%20dados/Marcostdah.github.io/whatsappbot/iniciar-bot.bat) — Atalho para iniciar o bot no Windows.
- [`google-apps-script.js`](file:///c:/Users/marco/OneDrive/Desktop/FACULDADE/analise%20de%20dados/Marcostdah.github.io/whatsappbot/google-apps-script.js) — Script da planilha que verifica/cria as pastas mensais no Google Drive e grava as linhas no Google Sheets.
- [`src/bot.js`](file:///c:/Users/marco/OneDrive/Desktop/FACULDADE/analise%20de%20dados/Marcostdah.github.io/whatsappbot/src/bot.js) — Máquina de estados conversacional do WhatsApp (`/start`, menus de Tipo, Categoria, Meio de pagamento e confirmação).
- [`src/services/geminiService.js`](file:///c:/Users/marco/OneDrive/Desktop/FACULDADE/analise%20de%20dados/Marcostdah.github.io/whatsappbot/src/services/geminiService.js) — Leitura de comprovantes e interpretação de respostas com Gemini IA.
- [`src/services/googleService.js`](file:///c:/Users/marco/OneDrive/Desktop/FACULDADE/analise%20de%20dados/Marcostdah.github.io/whatsappbot/src/services/googleService.js) — Extração do mês de competência pela data do pagamento, envio ao Google Drive/Sheets e backup local CSV/Excel.
- [`src/config.js`](file:///c:/Users/marco/OneDrive/Desktop/FACULDADE/analise%20de%20dados/Marcostdah.github.io/whatsappbot/src/config.js) — Carregamento e validação das configurações do `.env`.
