@echo off
cd /d "%~dp0"
if not exist ".env" copy ".env.example" ".env" >nul
set "DATALENS_NODE=node"
where node >nul 2>nul
if errorlevel 1 (
  if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" (
    set "DATALENS_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
  ) else (
    echo Please install Node.js 20 or newer, then run this file again.
    pause
    exit /b 1
  )
)
echo DataLens: http://127.0.0.1:8766/connect.html
"%DATALENS_NODE%" server.mjs
pause