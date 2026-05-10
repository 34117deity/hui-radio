$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$rootDir = Split-Path -Parent $scriptDir
$bootDir = Join-Path $rootDir "boot"
$cloudflaredPath = Join-Path $bootDir "cloudflared.exe"
$serverPort = if ($env:PORT) { $env:PORT } else { "9008" }
$serverHost = if ($env:HOST) { $env:HOST } else { "0.0.0.0" }
$viteHost = if ($env:VITE_HOST) { $env:VITE_HOST } else { "0.0.0.0" }
$vitePort = if ($env:VITE_PORT) { $env:VITE_PORT } else { "5173" }

function Write-Step($message) {
  Write-Host ""
  Write-Host "==> $message" -ForegroundColor Cyan
}

function Ensure-Command($commandName, $hint) {
  if (-not (Get-Command $commandName -ErrorAction SilentlyContinue)) {
    throw "$commandName is not installed. $hint"
  }
}

function Ensure-Cloudflared() {
  if (Test-Path $cloudflaredPath) {
    return $cloudflaredPath
  }

  Write-Step "cloudflared was not found, downloading it now"
  New-Item -ItemType Directory -Path $bootDir -Force | Out-Null
  Invoke-WebRequest `
    -Uri "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe" `
    -OutFile $cloudflaredPath

  return $cloudflaredPath
}

function Wait-ForServer($url, $timeoutSeconds) {
  $deadline = (Get-Date).AddSeconds($timeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    try {
      Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 2 | Out-Null
      return $true
    } catch {
      Start-Sleep -Milliseconds 800
    }
  }

  return $false
}

Ensure-Command "npm" "Please install Node.js and make sure npm is available in PATH."
Ensure-Command "node" "Please install Node.js."

$cloudflared = Ensure-Cloudflared

Write-Step "Switching to the project directory"
Set-Location $rootDir

Write-Step "Building the frontend"
& npm run build
if ($LASTEXITCODE -ne 0) {
  throw "npm run build failed."
}

Write-Step "Starting the app for public sharing"
$serverCommand = "cd /d `"$rootDir`" && set HOST=$serverHost && set PORT=$serverPort && set VITE_HOST=$viteHost && set VITE_PORT=$vitePort && npm run dev"
Start-Process -FilePath "cmd.exe" -ArgumentList "/k", $serverCommand -WindowStyle Normal

$localUrl = "http://127.0.0.1:$serverPort"
Write-Step "Waiting for the local service to start: $localUrl"
if (-not (Wait-ForServer -url $localUrl -timeoutSeconds 40)) {
  throw "The local service did not start within 40 seconds. Please check the newly opened server window."
}

Write-Step "Creating the Cloudflare public tunnel"
Write-Host "Keep this window open. Closing it will stop the public URL." -ForegroundColor Yellow
Write-Host "Local service: $localUrl"
Write-Host ""

& $cloudflared tunnel --url $localUrl
