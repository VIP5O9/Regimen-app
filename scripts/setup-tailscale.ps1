# REGIMEN - put the app behind Tailscale HTTPS.
# Idempotent: safe to run again. PowerShell 5.1 compatible. ASCII only on purpose.
#
# Defaults to 8443 rather than 443 so it won't collide with anything already
# served on this machine. Override either port:
#   .\setup-tailscale.ps1 -LocalPort 3117 -HttpsPort 443
param(
    [int]$LocalPort = 3117,
    [int]$HttpsPort = 8443
)

$ErrorActionPreference = 'Stop'

# --- (a) tailscale CLI present? ---
$cli = Get-Command tailscale -ErrorAction SilentlyContinue
if (-not $cli) {
    Write-Host "tailscale CLI not found on PATH." -ForegroundColor Red
    Write-Host "Install Tailscale, sign in, then run this script again." -ForegroundColor Red
    exit 1
}

# --- (b) serve https://<machine>:8443 -> http://localhost:3117 ---
$serveStatus = ''
try {
    $serveStatus = tailscale serve status 2>&1 | Out-String
} catch {
    $serveStatus = ''
}

# Idempotent only when 8443 already points at OUR port. If something else holds
# 8443, say so and repoint it - a bare port match would silently skip and leave
# REGIMEN unreachable.
$portMatch = ":" + $HttpsPort
$portTaken = $false
$pointsAtUs = $false
$inBlock = $false
foreach ($line in ($serveStatus -split "`r?`n")) {
    if ($line -match '^https://') {
        $inBlock = $line -match $portMatch
        if ($inBlock) { $portTaken = $true }
        continue
    }
    if ($inBlock -and $line -match $LocalPort) { $pointsAtUs = $true }
}

if ($pointsAtUs) {
    Write-Host "Serve already maps $HttpsPort -> localhost:$LocalPort - leaving it alone." -ForegroundColor DarkGray
}
else {
    if ($portTaken) {
        Write-Host "Port $HttpsPort is serving something else. Repointing it at REGIMEN." -ForegroundColor Yellow
    }
    Write-Host "Configuring tailscale serve $HttpsPort -> localhost:$LocalPort ..." -ForegroundColor DarkGray
    tailscale serve --bg --https=$HttpsPort "http://localhost:$LocalPort"
    if ($LASTEXITCODE -ne 0) {
        Write-Host "tailscale serve failed (exit $LASTEXITCODE)." -ForegroundColor Red
        Write-Host "If it complained about a port already in use, see the 443 note below." -ForegroundColor Red
        exit 1
    }
}

# --- (c) resolve the URL from tailscale status --json ---
$dnsName = $null
try {
    $status = tailscale status --json | ConvertFrom-Json
    $dnsName = $status.Self.DNSName
} catch {
    $dnsName = $null
}

if ($dnsName) {
    $dnsName = $dnsName.TrimEnd('.')
    $url = "https://" + $dnsName + ":" + $HttpsPort
    Write-Host ""
    Write-Host "REGIMEN URL:  $url" -ForegroundColor Green
}
else {
    Write-Host ""
    Write-Host "Could not read DNSName from 'tailscale status --json'." -ForegroundColor Yellow
    Write-Host "Run 'tailscale status' and build the URL as https://<machine>:$HttpsPort" -ForegroundColor Yellow
}

# --- (d) the two things that bite ---
Write-Host ""
Write-Host "HTTPS is REQUIRED. Service workers and Web Push do not run over plain http," -ForegroundColor Yellow
Write-Host "so open the https URL above in Safari - not http://localhost:$LocalPort from the phone." -ForegroundColor Yellow
Write-Host ""
Write-Host "First visit on each device needs the access token the server printed at startup:" -ForegroundColor Yellow
Write-Host "  <url>/?token=<token>   (also in data\token.json)" -ForegroundColor Yellow
Write-Host ""
Write-Host "Gotcha: a zombie tailscaled process sometimes holds port 443 and breaks serve." -ForegroundColor Yellow
Write-Host "Fix from an ELEVATED PowerShell:  Restart-Service Tailscale" -ForegroundColor Yellow
Write-Host "Then re-run this script." -ForegroundColor Yellow
