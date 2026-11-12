@echo off
setlocal
cd /d "%~dp0"

echo Starting DSH Task Monitor...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-monitor.ps1" %*
if errorlevel 1 (
  echo.
  echo Start failed. Read the message above, then press any key to close.
  pause >nul
)
endlocal
