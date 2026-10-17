@echo off
rem ============================================================
rem  Local test launcher. Double-click this file to start.
rem
rem  IMPORTANT: keep this file ASCII-only. cmd.exe reads .cmd
rem  files using the OEM code page, so non-ASCII comments get
rem  mangled into garbage commands. All Chinese text lives in
rem  dev.js instead (it prints fine after the chcp below).
rem ============================================================

rem Force UTF-8 console so node's Chinese output renders correctly
chcp 65001 >nul

cd /d "%~dp0"

rem Use whatever "node" is on PATH.
rem (An earlier version hardcoded an absolute path into a private
rem  runtime directory, which is useless on anyone else's machine.)
set "NODE_EXE=node"

where %NODE_EXE% >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js was not found on PATH.
  echo   Install Node 20 or newer: https://nodejs.org/
  echo.
  pause
  exit /b 1
)

"%NODE_EXE%" dev.js %*

rem Keep the window open on error when double-clicked
if errorlevel 1 pause
