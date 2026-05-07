$ErrorActionPreference = "Stop"
$projectDir = "D:\codex\hui-music"
$stateDir = Join-Path $projectDir "data"
$pidFile = Join-Path $stateDir "guardian.pid"

if (!(Test-Path $pidFile)) {
  Write-Output "Guardian PID file not found"
  exit 0
}

$guardianPid = (Get-Content $pidFile -Raw).Trim()
if (!$guardianPid) {
  Remove-Item $pidFile -ErrorAction SilentlyContinue
  Write-Output "Guardian PID file was empty"
  exit 0
}

$p = Get-Process -Id ([int]$guardianPid) -ErrorAction SilentlyContinue
if ($p) {
  Stop-Process -Id $p.Id -Force
  Write-Output "Guardian stopped PID=$guardianPid"
} else {
  Write-Output "Guardian process not found PID=$guardianPid"
}

Remove-Item $pidFile -ErrorAction SilentlyContinue

$project = "D:\codex\hui-music"
$children = Get-CimInstance Win32_Process | Where-Object {
  $_.Name -match 'node|tsx|npm|cmd' -and $_.CommandLine -and $_.CommandLine -like "*$project*"
}
foreach ($child in $children) {
  Stop-Process -Id $child.ProcessId -Force
}
if ($children) {
  Write-Output ("Stopped project child PIDs: " + ($children.ProcessId -join ', '))
}
