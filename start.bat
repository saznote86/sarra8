@echo off
setlocal
cd /d "%~dp0"

rem --- Lanceurs Sarra --------------------------------------------------------
rem Sans argument : application Electron
rem desktop      : application Electron
rem web          : atelier web Vite de la copie clone
rem help         : afficher cette aide
if /i "%~1"=="" goto desktop
if /i "%~1"=="desktop" goto desktop
if /i "%~1"=="web" goto web
if /i "%~1"=="browser" goto web
if /i "%~1"=="help" goto help
if /i "%~1"=="/?" goto help

echo Option inconnue : %~1
goto help

:desktop
where node >nul 2>nul
if errorlevel 1 goto missing_node
echo Starting Sarra desktop overlay (avatar + settings)...
start "" wscript.exe //NoLogo "%~dp0desktop\launch.vbs"
exit /b 0

:web
set "WEB_ROOT=%~dp0Sarra8_clone"
if not exist "%WEB_ROOT%\demo\package.json" (
  echo Le repertoire de l'atelier web est introuvable :
  echo %WEB_ROOT%\demo
  pause
  exit /b 1
)

where node >nul 2>nul
if errorlevel 1 goto missing_node
where npm >nul 2>nul
if errorlevel 1 goto missing_npm

echo Checking Sarra web dependencies...
call npm --prefix "%WEB_ROOT%\demo" install
if errorlevel 1 goto startup_failed

echo Starting Sarra Avatar Studio in the browser...
call npm --prefix "%WEB_ROOT%\demo" run dev -- --open
if errorlevel 1 goto startup_failed
exit /b 0

:help
echo Utilisation : start.bat [desktop ^| web ^| help]
echo.
echo   Sans argument  lance l'application Electron de bureau.
echo   desktop        lance l'application Electron de bureau.
echo   web            lance l'atelier web Vite.
exit /b 0

:missing_node
echo Node.js is required. Install Node.js 20 or newer, then run start.bat again.
pause
exit /b 1

:missing_npm
echo npm was not found. Reinstall Node.js with npm, then run start.bat again.
pause
exit /b 1

:startup_failed
echo Sarra Avatar Studio failed to start.
pause
exit /b 1
