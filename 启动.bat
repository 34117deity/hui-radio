@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion
title Hui Music - LAN Start

cd /d "%~dp0"

set "ROOT=%~dp0"
set "HOST=0.0.0.0"
set "PORT=9008"
set "VITE_HOST=0.0.0.0"
set "VITE_PORT=5173"
set "LAN_IP="

for /f "tokens=2 delims=:" %%i in ('ipconfig ^| findstr /R /C:"IPv4.*:"') do (
  set "CANDIDATE=%%i"
  set "CANDIDATE=!CANDIDATE: =!"
  if not "!CANDIDATE!"=="192.168.254.1" if not "!CANDIDATE!"=="192.168.255.1" if not defined LAN_IP set "LAN_IP=!CANDIDATE!"
)

if not defined LAN_IP set "LAN_IP=127.0.0.1"

echo.
echo ========================================
echo           Hui Music LAN Start
echo ========================================
echo.
echo [1/2] Starting backend...
start "Hui Music - Backend" /D "%ROOT%" cmd /k "set HOST=%HOST% && set PORT=%PORT% && npm run dev"

timeout /t 2 /nobreak >nul

echo [2/2] Starting frontend...
start "Hui Music - Frontend" /D "%ROOT%" cmd /k "set VITE_HOST=%VITE_HOST% && set VITE_PORT=%VITE_PORT% && set PORT=%PORT% && npm run dev:client"

timeout /t 3 /nobreak >nul

echo.
echo ========================================
echo               Started
echo ========================================
echo.
echo Frontend URL: http://%LAN_IP%:%VITE_PORT%
echo Backend URL:  http://%LAN_IP%:%PORT%
echo.
echo Local URLs:
echo Frontend: http://127.0.0.1:%VITE_PORT%
echo Backend:  http://127.0.0.1:%PORT%
echo.
echo If other devices cannot open it, allow Node.js through Windows Firewall.
echo Keep the two new windows running while you use the app.
echo.

pause
