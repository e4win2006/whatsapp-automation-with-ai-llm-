@echo off
title Run JARVIS Test Suite
color 0E

echo ========================================================
echo        RUNNING J.A.R.V.I.S. AUTOMATED TEST SUITE
echo ========================================================
echo.

cd /d "%~dp0"
call npm test

echo.
pause
