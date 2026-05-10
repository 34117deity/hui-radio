$ErrorActionPreference = "Stop"
$projectDir = "D:\codex\hui-music"
$stateDir = Join-Path $projectDir "data"
$pidFile = Join-Path $stateDir "guardian.pid"

if (!(Test-Path $stateDir)) {
  New-Item -ItemType Directory -Path $stateDir | Out-Null
}

if (Test-Path $pidFile) {
  $existingPid = (Get-Content $pidFile -Raw).Trim()
  if ($existingPid) {
    $p = Get-Process -Id ([int]$existingPid) -ErrorAction SilentlyContinue
    if ($p) {
      Write-Output "Guardian already running with PID=$existingPid"
      exit 0
    }
  }
}

$guardian = Start-Process -FilePath "powershell.exe" -ArgumentList @(
  "-NoProfile",
  "-ExecutionPolicy", "Bypass",
  "-File", (Join-Path $projectDir "scripts/dev-guardian.ps1")
) -WorkingDirectory $projectDir -WindowStyle Hidden -PassThru

Set-Content -Path $pidFile -Value $guardian.Id -Encoding UTF8
Write-Output "Guardian started with PID=$($guardian.Id)"
