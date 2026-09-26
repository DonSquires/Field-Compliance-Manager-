<#
.SYNOPSIS
  Bob's link to this laptop over Tailscale: the GPU (Ollama) for his in-house models, and a
  PowerShell terminal he may use only while you allow it.

.DESCRIPTION
  Run once as Administrator from the repo checkout. It is safe to run again (idempotent).

  What it does
    1. Confirms Tailscale is up and finds this laptop's Tailscale address (100.x.y.z).
    2. Ollama: makes the existing native Ollama listen on all interfaces so the VPS can reach it
       over Tailscale (OLLAMA_HOST=0.0.0.0:11434, 2 h keep-alive, 32k context), restarts it, and
       pulls Bob's models (qwen2.5:7b + qwen2.5-coder:7b; -BiggerModels adds the 14B and 30B coders).
    3. Windows Firewall: allows TCP 11434 (Ollama) from the Tailscale range only, and TCP 22 (SSH)
       from the VPS's Tailscale address only. Nothing is opened to your LAN or the internet.
    4. Bob's terminal: installs Windows OpenSSH Server (built into Windows), sets it to start only
       when you say so, makes PowerShell its shell, and authorises Bob's public key
       (deploy/bob-laptop/bob_laptop_id_ed25519.pub - a public key, nothing secret).

  You stay in control
    -Allow   start the SSH service (Bob can run commands you approve in chat)
    -Deny    stop it (Bob cannot reach the laptop at all)
    -Status  show what is on
  Every command Bob wants to run is shown to you in chat first and runs only after you say yes;
  the VPS also refuses destructive or privilege-changing commands outright.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\bob-gpu-link\laptop-tailscale.ps1
  powershell -ExecutionPolicy Bypass -File scripts\bob-gpu-link\laptop-tailscale.ps1 -BiggerModels
  powershell -ExecutionPolicy Bypass -File scripts\bob-gpu-link\laptop-tailscale.ps1 -Deny
#>
[CmdletBinding()]
param(
  [switch]$Allow,
  [switch]$Deny,
  [switch]$Status,
  [switch]$BiggerModels,
  [switch]$SkipOllama,
  [string]$VpsTailscaleIp = $(if ($env:BOB_VPS_TAILSCALE_IP) { $env:BOB_VPS_TAILSCALE_IP } else { '100.85.95.104' }),
  [string]$BobPublicKeyPath = (Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'deploy\bob-laptop\bob_laptop_id_ed25519.pub'),
  [string[]]$Models = @('qwen2.5:7b', 'qwen2.5-coder:7b')
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$ScriptVersion = '2026-09-26'
function Write-Log([string]$Message) { Write-Host ("{0:HH:mm:ss} {1}" -f (Get-Date), $Message) }
function Test-Admin { ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) }
# Under ErrorActionPreference=Stop, Windows PowerShell 5.1 turns a native command's stderr into a
# terminating error when it is redirected; run such commands with Continue and return their output.
function Invoke-Native([scriptblock]$Block) {
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { & $Block } finally { $ErrorActionPreference = $previous }
}
function Get-OllamaTags {
  try { return Invoke-RestMethod -Uri 'http://127.0.0.1:11434/api/tags' -TimeoutSec 5 } catch { return $null }
}

# deploy/laptop-worker/laptop-worker.env already holds the project's Supabase URL + service key for the
# CCTV worker on this laptop; the same file lets this script register the laptop with Bob.
function Read-EnvFile([string]$Path) {
  $values = @{}
  if (-not (Test-Path $Path)) { return $values }
  foreach ($line in Get-Content $Path) {
    if ($line.TrimStart().StartsWith('#')) { continue }
    if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') { $values[$Matches[1]] = $Matches[2].Trim().Trim('"').Trim("'") }
  }
  return $values
}
$LaptopEnv = Read-EnvFile (Join-Path $RepoRoot 'deploy\laptop-worker\laptop-worker.env')
if ($LaptopEnv['BOB_VPS_TAILSCALE_IP'] -and -not $PSBoundParameters.ContainsKey('VpsTailscaleIp')) { $VpsTailscaleIp = $LaptopEnv['BOB_VPS_TAILSCALE_IP'] }
if ($LaptopEnv['BOB_GPU_MODELS'] -and -not $PSBoundParameters.ContainsKey('Models')) { $Models = $LaptopEnv['BOB_GPU_MODELS'] -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ } }

$tailscale = @("$env:ProgramFiles\Tailscale\tailscale.exe", 'tailscale') | Where-Object { Get-Command $_ -ErrorAction SilentlyContinue } | Select-Object -First 1
if (-not $tailscale) { throw 'Tailscale is not installed on this laptop (https://tailscale.com/download/windows).' }
$tsStatus = Invoke-Native { & $tailscale status --json 2>$null } | ConvertFrom-Json
if (-not $tsStatus -or $tsStatus.BackendState -ne 'Running') { throw 'Tailscale is installed but not connected. Open Tailscale and sign in, then run this again.' }
$myIp = ($tsStatus.Self.TailscaleIPs | Where-Object { $_ -like '100.*' } | Select-Object -First 1)
$myName = ($tsStatus.Self.DNSName -replace '\.$', '')
Write-Log "Tailscale: this laptop is $myName ($myIp); the VPS is $VpsTailscaleIp"

function Get-SshdState {
  $svc = Get-Service sshd -ErrorAction SilentlyContinue
  if (-not $svc) { return 'not installed' }
  return "$($svc.Status) (startup: $($svc.StartType))"
}

# Tell Bob's control plane how to reach this laptop (Windows user, Tailscale address, whether the SSH
# switch is on, models present). Service-role only table; nothing secret leaves the laptop.
function Register-BobLaptop([bool]$SshAllowed) {
  $url = $LaptopEnv['SUPABASE_URL']; $key = $LaptopEnv['SUPABASE_SERVICE_ROLE_KEY']
  if (-not $url -or -not $key) { Write-Log "No deploy\laptop-worker\laptop-worker.env with SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY - not registered. Tell Bob: laptop user is '$env:USERNAME'."; return }
  [string[]]$models = @()
  $tags = Get-OllamaTags
  if ($tags) { $models = @($tags.models | ForEach-Object { [string]$_.name }) }
  $gpu = $null
  try { $gpu = [string](Invoke-Native { & nvidia-smi --query-gpu=name --format=csv,noheader 2>$null } | Select-Object -First 1) } catch { $gpu = $null }
  $row = [ordered]@{
    id = 'primary'; host_name = $env:COMPUTERNAME; tailscale_ip = $myIp; windows_user = $env:USERNAME
    ssh_allowed = $SshAllowed; ssh_port = 22
    ollama_host = [Environment]::GetEnvironmentVariable('OLLAMA_HOST', 'User'); ollama_models = $models; gpu = $gpu
    script_version = $ScriptVersion; reported_at = (Get-Date).ToUniversalTime().ToString('o')
  }
  $body = ConvertTo-Json -InputObject $row -Compress -Depth 4
  $headers = @{ apikey = $key; Authorization = "Bearer $key"; Prefer = 'resolution=merge-duplicates,return=minimal' }
  try {
    Invoke-RestMethod -Method Post -Uri "$($url.TrimEnd('/'))/rest/v1/bob_laptop_link?on_conflict=id" -Headers $headers -ContentType 'application/json' -Body $body -TimeoutSec 20 | Out-Null
    Write-Log ("Registered with Bob: user '{0}', {1}, SSH {2}" -f $env:USERNAME, $myIp, $(if ($SshAllowed) { 'ON' } else { 'OFF' }))
  } catch {
    Write-Log "Registration with Bob failed (non-fatal): $($_.Exception.Message). Tell Bob: laptop user is '$env:USERNAME'."
  }
}

function Show-Status {
  Write-Host ''
  Write-Host '== Bob laptop link status =='
  Write-Host ("  Tailscale        : {0} ({1})" -f $myName, $myIp)
  $tags = Get-OllamaTags
  Write-Host ("  Ollama           : {0}" -f $(if ($tags) { 'running - ' + (($tags.models | ForEach-Object { $_.name }) -join ', ') } else { 'not running' }))
  Write-Host ("  Ollama bind      : {0}" -f $(if ([Environment]::GetEnvironmentVariable('OLLAMA_HOST', 'User')) { [Environment]::GetEnvironmentVariable('OLLAMA_HOST', 'User') } else { '127.0.0.1 (localhost only - VPS cannot reach it)' }))
  Write-Host ("  SSH (Bob shell)  : {0}" -f (Get-SshdState))
  Write-Host ("  Firewall rules   : {0}" -f ((Get-NetFirewallRule -DisplayName 'Bob *' -ErrorAction SilentlyContinue | ForEach-Object { "$($_.DisplayName)=$($_.Enabled)" }) -join ', '))
  Write-Host ("  Windows user     : {0}" -f $env:USERNAME)
  Write-Host ''
}

if ($Status) { Show-Status; Register-BobLaptop ((Get-Service sshd -ErrorAction SilentlyContinue).Status -eq 'Running'); exit 0 }
if (-not (Test-Admin)) { throw 'Run this from an Administrator PowerShell (right-click PowerShell -> Run as administrator).' }

if ($Deny) {
  if (Get-Service sshd -ErrorAction SilentlyContinue) { Stop-Service sshd -ErrorAction SilentlyContinue; Set-Service sshd -StartupType Manual }
  Write-Log "Bob's terminal is OFF (sshd stopped). Ollama over Tailscale is unaffected."
  Show-Status; Register-BobLaptop $false; exit 0
}
if ($Allow) {
  if (-not (Get-Service sshd -ErrorAction SilentlyContinue)) { throw 'OpenSSH Server is not set up yet - run this script once without switches first.' }
  Start-Service sshd
  Write-Log "Bob's terminal is ON (sshd running). Use -Deny to switch it off."
  Show-Status; Register-BobLaptop $true; exit 0
}

# -- 1. Ollama over Tailscale ------------------------------------------------------------------
if (-not $SkipOllama) {
  if (-not (Get-Command ollama -ErrorAction SilentlyContinue)) {
    Write-Log 'Ollama is not installed. Installing with winget (https://ollama.com/download otherwise)...'
    winget install --id Ollama.Ollama -e --accept-source-agreements --accept-package-agreements | Out-Null
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
  }
  $wanted = @{ OLLAMA_HOST = '0.0.0.0:11434'; OLLAMA_KEEP_ALIVE = '2h'; OLLAMA_CONTEXT_LENGTH = '32768'; OLLAMA_MAX_LOADED_MODELS = '2' }
  $changed = $false
  foreach ($name in $wanted.Keys) {
    if ([Environment]::GetEnvironmentVariable($name, 'User') -ne $wanted[$name]) { [Environment]::SetEnvironmentVariable($name, $wanted[$name], 'User'); $changed = $true }
    Set-Item -Path "Env:$name" -Value $wanted[$name]
  }
  if ($changed -or -not (Get-Process -Name 'ollama' -ErrorAction SilentlyContinue)) {
    Write-Log 'Restarting Ollama so it listens for the VPS over Tailscale...'
    Get-Process -Name 'ollama app', 'ollama' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
    $app = Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama app.exe'
    if (Test-Path $app) { Start-Process -FilePath $app -WindowStyle Hidden } else { Start-Process -FilePath 'ollama' -ArgumentList 'serve' -WindowStyle Hidden }
  }
  $deadline = (Get-Date).AddSeconds(45)
  $ok = $false
  do { Start-Sleep -Seconds 2; $ok = ($null -ne (Get-OllamaTags)) } while (-not $ok -and (Get-Date) -lt $deadline)
  if (-not $ok) { throw 'Ollama did not come up on 11434. Start the Ollama app from the Start menu and run this again.' }
  if ($BiggerModels) { $Models += @('qwen2.5-coder:14b', 'qwen3-coder:30b') }
  $have = @((Get-OllamaTags).models | ForEach-Object { $_.name })
  foreach ($model in $Models) {
    if ($have -contains $model) { Write-Log "Model present: $model" } else { Write-Log "Pulling $model (one-off download)..."; & ollama pull $model }
  }
  $rule = 'Bob Ollama (Tailscale)'
  Get-NetFirewallRule -DisplayName $rule -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  New-NetFirewallRule -DisplayName $rule -Direction Inbound -Action Allow -Protocol TCP -LocalPort 11434 -RemoteAddress '100.64.0.0/10' -Profile Any | Out-Null
  Write-Log "Firewall: Ollama 11434 reachable from the Tailscale network only"
}

# -- 2. Bob's terminal: Windows OpenSSH Server, Tailscale-only, owner-toggled ------------------
if (-not (Test-Path $BobPublicKeyPath)) { throw "Bob's public key was not found at $BobPublicKeyPath - run 'git pull' in the repo first." }
$bobKey = (Get-Content $BobPublicKeyPath -Raw).Trim()
if ($bobKey -notmatch '^ssh-ed25519 AAAA[0-9A-Za-z+/=]+') { throw "The file at $BobPublicKeyPath does not look like an ssh-ed25519 public key." }

$cap = Get-WindowsCapability -Online -Name 'OpenSSH.Server*' | Select-Object -First 1
if ($cap.State -ne 'Installed') { Write-Log 'Installing Windows OpenSSH Server (built-in Windows feature)...'; Add-WindowsCapability -Online -Name $cap.Name | Out-Null }
Set-Service sshd -StartupType Manual
$shell = (Get-Command pwsh -ErrorAction SilentlyContinue).Source
if (-not $shell) { $shell = (Get-Command powershell).Source }
New-Item -Path 'HKLM:\SOFTWARE\OpenSSH' -Force | Out-Null
New-ItemProperty -Path 'HKLM:\SOFTWARE\OpenSSH' -Name DefaultShell -Value $shell -PropertyType String -Force | Out-Null

# Windows reads administrators' keys from ProgramData\ssh\administrators_authorized_keys (strict ACL) and
# other users' from ~\.ssh\authorized_keys. This script runs elevated, so write both: sshd uses whichever
# applies to the account Bob logs in as, and account-name detection (Microsoft accounts) stays out of it.
$keyBody = ($bobKey -split '\s+')[1]
$sshDir = Join-Path $env:USERPROFILE '.ssh'; New-Item -ItemType Directory -Path $sshDir -Force | Out-Null
$adminKeys = Join-Path $env:ProgramData 'ssh\administrators_authorized_keys'
foreach ($authorized in @($adminKeys, (Join-Path $sshDir 'authorized_keys'))) {
  $existing = if (Test-Path $authorized) { Get-Content $authorized } else { @() }
  if (-not ($existing | Where-Object { $_ -like "*$keyBody*" })) { Add-Content -Path $authorized -Value $bobKey -Encoding ascii; Write-Log "Authorised Bob's key in $authorized" } else { Write-Log "Bob's key already authorised in $authorized" }
}
& icacls $adminKeys /inheritance:r /grant 'Administrators:F' /grant 'SYSTEM:F' | Out-Null

$rule = 'Bob SSH (Tailscale, VPS only)'
Get-NetFirewallRule -DisplayName $rule -ErrorAction SilentlyContinue | Remove-NetFirewallRule
Get-NetFirewallRule -DisplayName 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue | Disable-NetFirewallRule
New-NetFirewallRule -DisplayName $rule -Direction Inbound -Action Allow -Protocol TCP -LocalPort 22 -RemoteAddress "$VpsTailscaleIp/32" -Profile Any | Out-Null
Write-Log "Firewall: SSH 22 reachable from the VPS ($VpsTailscaleIp) only"

Start-Service sshd
Write-Log "Bob's terminal is ON. Switch it off any time with:  powershell -ExecutionPolicy Bypass -File scripts\bob-gpu-link\laptop-tailscale.ps1 -Deny"
Show-Status
Register-BobLaptop $true
