@echo off
chcp 65001 >nul
set "PATH=C:\Program Files\nodejs;%PATH%"
echo ==========================================================
echo   INICIANDO BOT DE COMPROVANTES DO WHATSAPP
echo ==========================================================
node src/bot.js
pause
