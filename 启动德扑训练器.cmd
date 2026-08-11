@echo off
chcp 65001 >nul
cd /d "%~dp0"
start "RiverLab 本地服务" /min cmd /c "npm run dev:local"
timeout /t 4 /nobreak >nul
start "" "http://localhost:4311"
