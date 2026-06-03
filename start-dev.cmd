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

powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:4000/api/health' -TimeoutSec 2 | Out-Null; exit 0 } catch { exit 1 }" >nul 2>nul
if not errorlevel 1 (
  echo [Star Companion] Server already appears to be running.
  echo [Star Companion] Close the original dev console window to stop that service.
  start "" "http://localhost:5173"
  echo.
  echo This launcher did not start a new service because one is already running.
  echo Press any key to close this window.
  pause >nul
  exit /b 0
)

set NEED_INSTALL=0
if not exist "node_modules" set NEED_INSTALL=1
if not exist "packages\shared\node_modules" set NEED_INSTALL=1
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

if not exist "apps\server\prisma\dev.db" (
  echo [Star Companion] Initializing local database...
  call npm run db:migrate:deploy
  if errorlevel 1 (
    echo [Star Companion] Prisma migrate failed; replaying migration SQL instead...
    if exist "apps\server\prisma\dev.db" del /q "apps\server\prisma\dev.db"
    if exist "apps\server\prisma\dev.db-journal" del /q "apps\server\prisma\dev.db-journal"
    if exist "apps\server\prisma\dev.db-wal" del /q "apps\server\prisma\dev.db-wal"
    if exist "apps\server\prisma\dev.db-shm" del /q "apps\server\prisma\dev.db-shm"
    node --disable-warning=ExperimentalWarning scripts\init-dev-db.mjs
    if errorlevel 1 (
      echo [ERROR] Local database initialization failed.
      pause
      exit /b 1
    )
  )
  echo.
) else (
  echo [Star Companion] Applying pending database migrations...
  call npm run db:migrate:deploy
  if errorlevel 1 (
    echo [WARN] Prisma migrate failed. Continuing because the local database already exists.
    echo If startup later fails with missing columns, reset apps\server\prisma\dev.db and run this file again.
    echo.
  )
)

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
