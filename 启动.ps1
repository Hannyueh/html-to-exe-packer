# HTML to EXE Packer — 启动脚本 (PowerShell)
# 用法: 右键 → "使用 PowerShell 运行"，或在终端中执行 .\启动.ps1

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  HTML to EXE Packer" -ForegroundColor White
Write-Host "  正在启动..." -ForegroundColor Gray
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# 检查 node_modules
if (-not (Test-Path "node_modules")) {
    Write-Host "[!] 首次运行，正在安装依赖..." -ForegroundColor Yellow
    npm install
    Write-Host ""
}

# 检查 Electron 二进制
$electronExe = "node_modules\electron\dist\electron.exe"
if (-not (Test-Path $electronExe)) {
    Write-Host "[!] Electron 二进制未安装，正在下载..." -ForegroundColor Yellow

    $pkg = Get-Content package.json -Raw | ConvertFrom-Json
    $version = ($pkg.devDependencies.electron -replace '[\^~]', '').Trim()

    Write-Host "   版本: v$version" -ForegroundColor Gray

    $env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
    $url = "https://npmmirror.com/mirrors/electron/v$version/electron-v$version-win32-x64.zip"
    $zipPath = "$env:TEMP\electron.zip"

    Write-Host "   下载中..." -ForegroundColor Gray
    Invoke-WebRequest -Uri $url -OutFile $zipPath -UseBasicParsing

    Write-Host "   解压中..." -ForegroundColor Gray
    New-Item -ItemType Directory -Force -Path "node_modules\electron\dist" | Out-Null
    Expand-Archive -Path $zipPath -DestinationPath "node_modules\electron\dist" -Force
    [System.IO.File]::WriteAllText("$PSScriptRoot\node_modules\electron\path.txt", "electron.exe")
    Remove-Item $zipPath -Force

    Write-Host "   ! 完成!" -ForegroundColor Green
    Write-Host ""
}

# 启动
Write-Host "   启动应用..." -ForegroundColor Gray
Start-Process -FilePath "npx" -ArgumentList "electron ." -WindowStyle Normal
Write-Host "   已启动，请查看桌面窗口。" -ForegroundColor Green
Write-Host ""
