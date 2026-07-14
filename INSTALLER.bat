@echo off
title Vinted Live Bot - Installation
cd /d "%~dp0"

echo.
echo  ========================================
echo   Vinted Live Bot - Installation
echo  ========================================
echo.

:: Node.js
echo [1/4] Verification de Node.js...
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo  ERREUR : Node.js introuvable dans le PATH.
    echo  Pourtant il est peut-etre installe...
    echo  Ferme ce CMD, redemarre ton PC, puis relance.
    echo.
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('node --version') do echo  Node.js %%v detecte. OK

:: npm install
echo.
echo [2/4] Installation des dependances npm...
echo  (peut prendre 30 secondes la premiere fois)
echo.
call npm install
if %errorlevel% neq 0 (
    echo.
    echo  ERREUR pendant npm install.
    echo  Verifie ta connexion internet.
    echo.
    pause
    exit /b 1
)
echo.
echo  Dependances installees. OK

:: Demarrage automatique via VBS
echo.
echo [3/4] Ajout au demarrage automatique de Windows...
set SCRIPT_PATH=%~dp0start.bat
set STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup
set VBS=%STARTUP%\VintedLiveBot.vbs

(
echo Set oShell = CreateObject^("WScript.Shell"^)
echo oShell.Run Chr^(34^) ^& "%SCRIPT_PATH%" ^& Chr^(34^), 0, False
) > "%VBS%"

if exist "%VBS%" (
    echo  Demarrage automatique configure. OK
) else (
    echo  ATTENTION : impossible d'ecrire dans le dossier Demarrage.
    echo  Le bot ne se lancera pas tout seul au boot, mais fonctionne quand meme.
)

:: Lancement immediat
echo.
echo [4/4] Lancement du serveur...
taskkill /f /im node.exe >nul 2>&1
timeout /t 1 /nobreak >nul
start "" /B node server.js
timeout /t 3 /nobreak >nul

:: Verifier que le serveur repond
curl -s http://localhost:3000 >nul 2>&1
if %errorlevel% equ 0 (
    echo  Serveur demarre. OK
) else (
    echo  Serveur en cours de demarrage...
)

start "" "http://localhost:3000"

echo.
echo  ========================================
echo   Installation terminee !
echo   Le site s'ouvre dans ton navigateur.
echo   Le bot demarre automatiquement au boot.
echo  ========================================
echo.
pause
