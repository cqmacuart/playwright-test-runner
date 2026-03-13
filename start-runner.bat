@echo off
setlocal

echo 🛠️ Compilando frontend...
cd client
call npm run build
cd ..

echo 🚀 Iniciando backend...
start "Backend" cmd /k "cd server && node index.js"

timeout /t 2 >nul

echo 🌐 Abriendo navegador...
start http://localhost:3001

endlocal
