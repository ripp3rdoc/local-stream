# Allow phones/devices on your LAN to reach Local Stream.
# Run this in an *elevated* PowerShell (Run as Administrator):
#   powershell -ExecutionPolicy Bypass -File scripts\setup-firewall.ps1
#
# Ports come from config.json ("port", plus "castHttpPort" when HTTPS is on),
# falling back to the defaults in src/config.js. Re-run it after changing the
# port: the rule is updated in place.
#
# Scope: inbound TCP, Private profile only (home/work networks).
# It deliberately does NOT open the ports on Public networks (coffee shops, etc).
#
# Add -WhatIf to only print what would change.

param([switch]$WhatIf)

$ruleName = "Local Stream"
$root = Split-Path -Parent $PSScriptRoot
$configPath = Join-Path $root "config.json"

# Defaults mirror src/config.js.
$port = 3000
$httpsEnabled = $true
$castPort = 3001

if (Test-Path $configPath) {
    try {
        $cfg = Get-Content $configPath -Raw | ConvertFrom-Json
        if ($cfg.port) { $port = [int]$cfg.port }
        if ($null -ne $cfg.https -and $null -ne $cfg.https.enabled) { $httpsEnabled = [bool]$cfg.https.enabled }
        if ($cfg.PSObject.Properties.Name -contains 'castHttpPort') { $castPort = $cfg.castHttpPort }
    } catch {
        Write-Host "Could not parse config.json; using default ports." -ForegroundColor Yellow
    }
}

$ports = @([string]$port)
# The extra plain-HTTP cast port is only opened by the server when HTTPS is on.
if ($httpsEnabled -and $castPort) { $ports += [string]$castPort }

Write-Host "Ports to allow (inbound TCP, Private networks): $($ports -join ', ')"

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)

if ($WhatIf) { Write-Host "-WhatIf: no changes made."; return }

if (-not $isAdmin) {
    Write-Host "This needs Administrator rights. Right-click PowerShell -> Run as Administrator, then run this script again." -ForegroundColor Red
    exit 1
}

# Remove the old fixed-port rule from earlier versions of this script.
Get-NetFirewallRule -DisplayName "Local Stream (TCP 3000)" -ErrorAction SilentlyContinue | Remove-NetFirewallRule

$existing = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
if ($existing) {
    $existing | Set-NetFirewallRule -Enabled True -Action Allow -Profile Private
    $existing | Get-NetFirewallPortFilter | Set-NetFirewallPortFilter -Protocol TCP -LocalPort $ports
    Write-Host "Updated firewall rule '$ruleName' (inbound TCP $($ports -join ', '), Private profile)." -ForegroundColor Green
} else {
    New-NetFirewallRule `
        -DisplayName $ruleName `
        -Direction Inbound `
        -Action Allow `
        -Protocol TCP `
        -LocalPort $ports `
        -Profile Private `
        -Description "Allow LAN devices to reach the Local Stream media server." | Out-Null
    Write-Host "Created firewall rule '$ruleName' (inbound TCP $($ports -join ', '), Private profile)." -ForegroundColor Green
}

Write-Host "Your phone can now reach the server while on the same network." -ForegroundColor Green

# To remove later:
#   Remove-NetFirewallRule -DisplayName "Local Stream"
