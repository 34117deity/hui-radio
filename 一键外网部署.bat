@echo off
chcp 65001 >nul
title Hui Music - 一键外网部署

cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-public-share.ps1"

echo.
echo 外网部署脚本已退出。
pause
