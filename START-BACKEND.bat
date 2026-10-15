@echo off
REM ===========================================================================
REM  KsuNiMeet - start the backend. Just double-click this file.
REM
REM  It waits for the internet, then runs tools\backend-up.ps1, which starts
REM  PocketBase, starts the tunnel, finds the new public address, writes it to
REM  GitHub and rebuilds the site. That script is where the real work lives;
REM  this file exists so you never have to type a command.
REM
REM  ASCII ONLY. A .bat is read in the console's own code page, so accented or
REM  typographic characters turn into garbage and can break the commands.
REM
REM  Run it:  after a restart, or if the site says it cannot reach the backend.
REM ===========================================================================

setlocal
title KsuNiMeet backend

REM Work from the folder this file sits in, whatever it was launched from,
REM so a shortcut or a double-click from anywhere still finds the script.
cd /d "%~dp0"

echo.
echo   KsuNiMeet - starting the backend
echo   ------------------------------------------------
echo.

REM ---------------------------------------------------------------- internet
REM A PC that just booted often has no network for the first few seconds, and
REM the tunnel cannot come up without it. Wait for DNS to answer, but give up
REM after about two minutes rather than waiting forever on an offline machine.
set /a tries=0
:waitnet
nslookup api.github.com >nul 2>&1
if not errorlevel 1 goto online
set /a tries+=1
if %tries% GEQ 40 (
  echo   No internet after two minutes. Check the connection and run this again.
  goto theend
)
echo   waiting for the internet...
timeout /t 3 /nobreak >nul
goto waitnet

:online
echo   internet: ok
echo.

REM ------------------------------------------------------------------ the work
REM -ExecutionPolicy Bypass is required: the default policy blocks .ps1 files
REM that did not come from the internet, which would silently do nothing.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\backend-up.ps1"

set RC=%ERRORLEVEL%
echo.
if "%RC%"=="0" (
  echo   ------------------------------------------------
  echo   DONE. The backend is running and the site is rebuilt.
  echo   Open: https://ksunimeet.b4rn1.com/
) else (
  echo   ------------------------------------------------
  echo   Something failed. Error code %RC%.
  echo   Read the messages above - the last one says what went wrong.
)

:theend
echo.
echo   You can close this window.
echo.
pause >nul
endlocal
