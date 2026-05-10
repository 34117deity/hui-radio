$ErrorActionPreference = "Stop"
$projectDir = "D:\codex\hui-music"

& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $projectDir "scripts/stop-guardian.ps1")
Start-Sleep -Seconds 1
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $projectDir "scripts/start-guardian.ps1")
