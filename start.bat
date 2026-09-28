@echo off
chcp 65001 >nul
echo Starting Exocad File Storage...
cd /d "%~dp0"
if exist node_modules (
    node server.js
) else (
    echo Устанавливаю зависимости...
    npm install
    node server.js
)
pause