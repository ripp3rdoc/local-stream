# Start the Local Stream server.
# Double-click this file, or run:  powershell -ExecutionPolicy Bypass -File scripts\start.ps1

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (-not (Test-Path "node_modules")) {
    Write-Host "Installing dependencies..." -ForegroundColor Cyan
    npm install
}

node src/server.js
