@echo off
setlocal

cd /d %~dp0

echo Verificando puertos...
node scripts/check-ports.js
if errorlevel 1 (
  pause
  exit /b 1
)

echo Iniciando API (Nest/Fastify)...
start "API" cmd /k "npm --workspace server run dev"

timeout /t 2 >nul

echo Iniciando WEB (Next.js)...
start "WEB" cmd /k "npm --workspace client run dev"

timeout /t 2 >nul

echo Abriendo navegador...
start http://localhost:3000

endlocal
