@echo off
setlocal
cd /d "%~dp0"
title Star Companion Dev Server

echo [Star Companion] Starting local development server...
echo.

if not exist "apps\server\.env" (
  if exist "apps\server\.env.example" (
    echo [Star Companion] Creating apps\server\.env from template...
    copy /y "apps\server\.env.example" "apps\server\.env" >nul
    echo.
  )
)

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js was not found. Install Node.js first.
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm was not found. Install Node.js with npm first.
  pause
  exit /b 1
)

set BACKEND_RUNNING=0
set WEB_RUNNING=0
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:4000/api/health' -TimeoutSec 2 | Out-Null; exit 0 } catch { exit 1 }" >nul 2>nul
if not errorlevel 1 set BACKEND_RUNNING=1
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:5173' -TimeoutSec 2 | Out-Null; exit 0 } catch { exit 1 }" >nul 2>nul
if not errorlevel 1 set WEB_RUNNING=1
if "%BACKEND_RUNNING%"=="1" if "%WEB_RUNNING%"=="1" (
  echo [Star Companion] Both local services are already running.
  start "" "http://localhost:5173"
  echo.
  echo This launcher did not start a new service because one is already running.
  echo Press any key to close this window.
  pause >nul
  exit /b 0
)
if "%BACKEND_RUNNING%"=="1" (
  echo [ERROR] The backend responds on port 4000, but the web app is not running on port 5173.
  echo Close the existing backend process, then run this file again.
  pause
  exit /b 1
)
if "%WEB_RUNNING%"=="1" (
  echo [ERROR] The web app responds on port 5173, but the backend is not running on port 4000.
  echo Close the existing web process, then run this file again.
  pause
  exit /b 1
)

set NEED_INSTALL=0
if not exist "node_modules" set NEED_INSTALL=1
if not exist "apps\server\node_modules" set NEED_INSTALL=1
if not exist "apps\web\node_modules" set NEED_INSTALL=1

if "%NEED_INSTALL%"=="1" (
  echo [Star Companion] Installing dependencies...
  call npm install
  if errorlevel 1 (
    echo [ERROR] Dependency installation failed.
    pause
    exit /b 1
  )
  echo.
)

echo [Star Companion] Preparing Prisma client...
call npm run db:generate
if errorlevel 1 (
  echo [ERROR] Prisma client generation failed.
  echo If another dev server is running, close it and run this file again.
  pause
  exit /b 1
)
echo.

echo [Star Companion] Launching app...
echo Web:    http://localhost:5173
echo Server: http://localhost:4000
echo Keep this black console window open while using the app.
echo Close this window to stop the current project services.
echo.

start "Star Companion Browser Opener" /min powershell -NoProfile -ExecutionPolicy Bypass -Command "for ($i = 0; $i -lt 90; $i++) { try { Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:5173' -TimeoutSec 1 | Out-Null; Start-Process 'http://localhost:5173'; exit 0 } catch { Start-Sleep -Seconds 1 } }"

call npm run dev
if errorlevel 1 (
  echo.
  echo [ERROR] Development server stopped with an error.
  pause
  exit /b 1
)

echo.
echo [Star Companion] Development server stopped.
pause
