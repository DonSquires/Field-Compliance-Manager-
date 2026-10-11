<#
.SYNOPSIS
  Run a checked command on the FCM VPS over its private Tailscale address.

.DESCRIPTION
  Uses the existing deployment key and BatchMode SSH. No credential is printed
  or copied. The default Health action verifies SSH, Docker, the Bob control
  plane, and the inference container. Command is intentionally explicit: the
  caller supplies the remote command and remains responsible for protected-path
  approval.

.EXAMPLE
  .\scripts\bob-vps-docker.ps1
  .\scripts\bob-vps-docker.ps1 -Action Docker
  .\scripts\bob-vps-docker.ps1 -Action Command -Command 'docker logs --tail 50 fcm-inference'
#>
[CmdletBinding()]
param(
  [ValidateSet('Health', 'Docker', 'Command')]
  [string]$Action = 'Health',
  [string]$Command = '',
  [string]$VpsHost = '100.85.95.104',
  [string]$SshUser = 'root',
  [string]$KeyPath = (Join-Path $HOME '.ssh\fcm-vps-deploy')
)

$ErrorActionPreference = 'Stop'

if ($VpsHost -notmatch '^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.\d{1,3}\.\d{1,3}$') {
  throw 'VpsHost must be a private Tailscale IPv4 address.'
}
if (-not (Test-Path -LiteralPath $KeyPath -PathType Leaf)) {
  throw "VPS SSH key was not found at $KeyPath."
}
if (-not (Get-Command ssh -ErrorAction SilentlyContinue)) {
  throw 'OpenSSH client is not installed.'
}

$remoteCommand = switch ($Action) {
  'Health' {
    "set -e; printf 'ssh=ok\n'; printf 'docker='; docker version --format '{{.Server.Version}}'; printf 'control_plane_http='; curl -fsS -o /dev/null -w '%{http_code}' http://172.16.0.1:8091/health; printf '\ninference='; docker inspect --format '{{.State.Status}}' fcm-inference; printf '\n'"
  }
  'Docker' {
    "set -e; docker version --format 'server={{.Server.Version}}'; docker ps --format 'table {{.Names}}\t{{.Status}}'"
  }
  'Command' {
    if ([string]::IsNullOrWhiteSpace($Command)) {
      throw '-Command is required when Action is Command.'
    }
    if ($Command.Contains([char]0)) {
      throw 'Command contains a NUL byte.'
    }
    $Command
  }
}

& ssh `
  -i $KeyPath `
  -o BatchMode=yes `
  -o ConnectTimeout=15 `
  -o StrictHostKeyChecking=accept-new `
  "$SshUser@$VpsHost" `
  $remoteCommand

if ($LASTEXITCODE -ne 0) {
  throw "VPS command failed with exit code $LASTEXITCODE."
}
