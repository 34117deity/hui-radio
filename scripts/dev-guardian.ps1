param(
  [string]$ProjectDir = "D:\codex\hui-music",
  [int]$BackoffSeconds = 3
)

$ErrorActionPreference = "Stop"
$stateDir = Join-Path $ProjectDir "data"
$logFile = Join-Path $stateDir "guardian.log"

if (!(Test-Path $stateDir)) {
  New-Item -ItemType Directory -Path $stateDir | Out-Null
}

function Write-Log([string]$msg) {
  $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $msg
  Add-Content -Path $logFile -Value $line
}

Write-Log "Guardian started. ProjectDir=$ProjectDir"

while ($true) {
  try {
    $proc = Start-Process -FilePath "npm.cmd" -ArgumentList "run dev" -WorkingDirectory $ProjectDir -WindowStyle Hidden -PassThru
    Write-Log "Started child PID=$($proc.Id)"

    Wait-Process -Id $proc.Id
    Write-Log "Child exited PID=$($proc.Id), restarting in $BackoffSeconds seconds"
  } catch {
    Write-Log "Guardian error: $($_.Exception.Message)"
  }

  Start-Sleep -Seconds $BackoffSeconds
}
