@echo off
cd /d %~dp0\client
call npm install

cd /d %~dp0\server
call npm install
pause