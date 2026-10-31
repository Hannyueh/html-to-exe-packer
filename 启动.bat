@echo off
chcp 65001 >nul 2>&1
title HTML to EXE Packer
cd /d "%~dp0"

:: Ensure Node.js and system tools are on PATH (fixes "'node' is not recognized" on double-click)
set "PATH=%SystemRoot%\System32;%SystemRoot%;%PATH%"
if exist "C:\Program Files\nodejs\node.exe" set "PATH=C:\Program Files\nodejs;%PATH%"

echo ========================================
echo   HTML to EXE Packer
echo ========================================
echo.

:: Check if node_modules exists
if not exist "node_modules\" (
    echo [!] First run - installing dependencies...
    call npm install
    if errorlevel 1 (
        echo [X] Install failed! Check your network.
        pause
        exit /b 1
    )
    echo.
)

:: Check if electron binary exists
if not exist "node_modules\electron\dist\electron.exe" (
    echo [!] Electron binary missing - downloading from mirror...
    powershell -Command "$pkg=Get-Content package.json|ConvertFrom-Json;$ver=($pkg.devDependencies.electron -replace '[^^~]','').Trim();$url='https://npmmirror.com/mirrors/electron/v'+$ver+'/electron-v'+$ver+'-win32-x64.zip';Invoke-WebRequest -Uri $url -OutFile '%TEMP%\electron.zip' -UseBasicParsing;Expand-Archive -Path '%TEMP%\electron.zip' -DestinationPath 'node_modules\electron\dist' -Force;Remove-Item '%TEMP%\electron.zip' -Force"
    echo electron.exe> "node_modules\electron\path.txt"
    echo [!] Download complete!
    echo.
)

:: Launch Electron - use "." from project directory, NOT full path
echo    Launching GUI...
echo.
call ".\node_modules\.bin\electron.cmd" .

if errorlevel 1 (
    echo.
    echo [X] Launch failed! See error above.
    pause
)
