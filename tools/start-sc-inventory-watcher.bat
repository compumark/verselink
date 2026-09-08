@echo off
setlocal
title SC Inventory Log Watcher

set "SCRIPT_DIR=%~dp0"
set "LOG_PATH=O:\Roberts Space Industries\StarCitizen\LIVE\Game.log"

if not "%~1"=="" set "LOG_PATH=%~1"

rem Optional environment variables for database test:
rem SC_INVENTORY_API_URL=https://ingest.example.com
rem SC_INVENTORY_SINK_TOKEN=your-token
rem SC_INVENTORY_USER_ID=your-scmdb-user-id
rem SC_INVENTORY_USER_HANDLE=Compumark

echo Star Citizen Inventory Log Watcher
echo Log: %LOG_PATH%
echo.

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%sc-inventory-log-watcher.ps1" -LogPath "%LOG_PATH%" %2 %3

echo.
echo Watcher beendet. Taste druecken zum Schliessen.
pause >nul
