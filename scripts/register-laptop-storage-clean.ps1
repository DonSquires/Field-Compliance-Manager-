# Registers the weekly "FCM laptop storage clean" task (Sunday 03:00).
# Re-run after pulling to refresh the installed copy of laptop-storage-clean.js.
# The weekly run prunes stale temp, Docker build cache/unused images and the npm cache; it only
# reports Ollama models outside the worker keep-list. Docker disk compaction stays a manual step.
param(
  [string]$EnvFile = (Join-Path $PSScriptRoot '..\deploy\laptop-worker\laptop-worker.env'),
  [string]$At = '03:00',
  [string]$PurgeAt = '04:15'
)

$ErrorActionPreference = 'Stop'
$installDir = Join-Path $env:LOCALAPPDATA 'FCM\storage-clean'
New-Item -ItemType Directory -Force -Path $installDir | Out-Null
Copy-Item (Join-Path $PSScriptRoot 'laptop-storage-clean.js') (Join-Path $installDir 'laptop-storage-clean.js') -Force

$node = (Get-Command node -ErrorAction Stop).Source
$envPath = (Resolve-Path $EnvFile).Path
$log = Join-Path $installDir 'last-run.log'
$command = '& "{0}" "{1}" --apply --env "{2}" *> "{3}"' -f $node, (Join-Path $installDir 'laptop-storage-clean.js'), $envPath, $log

$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -Command "{0}"' -f $command.Replace('"', '\"'))
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At $At
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 2)
Register-ScheduledTask -TaskName 'FCM laptop storage clean' -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Write-Host "Registered 'FCM laptop storage clean' (weekly, Sunday $At). Log: $log"

# Daily Evidence Custodian run: removes raw CCTV recordings past the cctv_raw_video retention policy
# (records each purge in custodian_actions first; sealed, court-ready and held evidence is never touched).
Copy-Item (Join-Path $PSScriptRoot 'custodian-raw-video-purge.js') (Join-Path $installDir 'custodian-raw-video-purge.js') -Force
$purgeLog = Join-Path $installDir 'raw-video-purge.log'
$purgeCommand = '& "{0}" "{1}" --apply --env "{2}" *> "{3}"' -f $node, (Join-Path $installDir 'custodian-raw-video-purge.js'), $envPath, $purgeLog
$purgeAction = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -Command "{0}"' -f $purgeCommand.Replace('"', '\"'))
$purgeTrigger = New-ScheduledTaskTrigger -Daily -At $PurgeAt
$purgeSettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 1)
Register-ScheduledTask -TaskName 'FCM custodian raw video purge' -Action $purgeAction -Trigger $purgeTrigger -Settings $purgeSettings -Force | Out-Null
Write-Host "Registered 'FCM custodian raw video purge' (daily, $PurgeAt). Log: $purgeLog"
