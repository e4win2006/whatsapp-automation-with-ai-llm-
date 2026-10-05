@echo off
title Install JARVIS Dependencies
color 0A

echo ========================================================
echo        INSTALLING J.A.R.V.I.S. DEPENDENCIES
echo ========================================================
echo.

cd /d "%~dp0"
call npm install

echo.
echo [DONE] Dependencies installed successfully!
pause
