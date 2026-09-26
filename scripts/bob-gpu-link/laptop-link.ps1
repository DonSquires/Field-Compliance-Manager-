<#
.SYNOPSIS
  Laptop side of Bob's GPU link (Windows, RTX laptop).

.DESCRIPTION
  Runs Ollama locally on the GPU, makes sure Bob's models are present, and keeps a
  reverse SSH tunnel to the VPS so fcm-api can reach this Ollama as
  http://host.docker.internal:11435/v1. Reconnects automatically. Nothing on the
  VPS can open connections back to this laptop: the tunnel is forwarding-only.

  First run prints the public key to hand to scripts/bob-gpu-link/vps-setup.sh.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\bob-gpu-link\laptop-link.ps1
  # register at logon:
  powershell -ExecutionPolicy Bypass -File scripts\bob-gpu-link\laptop-link.ps1 -Install
#>
param(
  [string]$VpsHost = $(if ($env:BOB_GPU_LINK_HOST) { $env:BOB_GPU_LINK_HOST } else { '72.61.123.97' }),
  [string]$VpsUser = $(if ($env:BOB_GPU_LINK_USER) { $env:BOB_GPU_LINK_USER } else { 'bobgpu' }),
  [string]$GatewayIp = $(if ($env:BOB_GPU_LINK_GATEWAY) { $env:BOB_GPU_LINK_GATEWAY } else { '172.17.0.1' }),
  [int]$RemotePort = 11435,
  [int]$LocalPort = 11434,
  [string[]]$Models = @('qwen2.5:7b'),
  [switch]$Install
)

$ErrorActionPreference = 'Stop'
$keyPath = Join-Path $HOME '.ssh\bob-gpu-link'

function Write-Log([string]$Message) { Write-Host ("{0:u} {1}" -f (Get-Date), $Message) }

if ($Install) {
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}"' -f $PSCommandPath)
  $trigger = New-ScheduledTaskTrigger -AtLogOn
  $settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
  Register-ScheduledTask -TaskName 'Bob GPU link' -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
  Write-Log 'Registered scheduled task "Bob GPU link" (runs at logon).'
  exit 0
}

if (-not (Get-Command ollama -ErrorAction SilentlyContinue)) {
  throw 'Ollama is not installed. Install it from https://ollama.com/download then re-run.'
}
if (-not (Get-Command ssh -ErrorAction SilentlyContinue)) {
  throw 'OpenSSH client is missing. Settings > Apps > Optional features > OpenSSH Client.'
}

if (-not (Test-Path $keyPath)) {
  New-Item -ItemType Directory -Force -Path (Split-Path $keyPath) | Out-Null
  ssh-keygen -t ed25519 -f $keyPath -N '""' -C 'bob-gpu-link' | Out-Null
  Write-Log 'Generated a new key. Give this PUBLIC key to the VPS setup script:'
  Get-Content "$keyPath.pub"
  Write-Log 'On the VPS: bash scripts/bob-gpu-link/vps-setup.sh "<paste the line above>"'
}

# Ollama must be up and hold Bob's models before the tunnel advertises it.
$ollamaUp = $false
try { Invoke-RestMethod -Uri "http://127.0.0.1:$LocalPort/api/tags" -TimeoutSec 3 | Out-Null; $ollamaUp = $true } catch {}
if (-not $ollamaUp) {
  Write-Log 'Starting Ollama...'
  Start-Process -FilePath 'ollama' -ArgumentList 'serve' -WindowStyle Hidden
  Start-Sleep -Seconds 4
}
foreach ($model in $Models) {
  $have = (& ollama list 2>$null) -match [regex]::Escape($model)
  if (-not $have) { Write-Log "Pulling $model..."; & ollama pull $model }
}

Write-Log "Linking local Ollama :$LocalPort -> ${VpsUser}@${VpsHost} ${GatewayIp}:$RemotePort (Ctrl+C to stop)"
while ($true) {
  & ssh -N `
    -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 `
    -o StrictHostKeyChecking=accept-new -o BatchMode=yes `
    -i $keyPath `
    -R "${GatewayIp}:${RemotePort}:127.0.0.1:${LocalPort}" `
    "${VpsUser}@${VpsHost}"
  Write-Log 'Tunnel closed; reconnecting in 5 seconds.'
  Start-Sleep -Seconds 5
}
