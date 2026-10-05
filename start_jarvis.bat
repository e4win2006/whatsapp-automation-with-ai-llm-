@echo off
title JARVIS WhatsApp Automation System
color 0B

echo ========================================================
echo         STARTING J.A.R.V.I.S. WHATSAPP SYSTEM
echo ========================================================
echo.

cd /d "%~dp0"

:: Check if node_modules exists
if not exist "node_modules\" (
    echo [INFO] Installing required dependencies first...
    call npm install
    echo.
)

:: Start the JARVIS Server & Dashboard
echo [INFO] Launching JARVIS Server...
echo [INFO] Dashboard URL: http://localhost:3000
echo.

:: Open browser after 2 seconds
start "" http://localhost:3000

:: Run the server via npm run dev
npm run dev

pause
