# Scheduled read-only Base44 RAMS (OFO) -> FCM sync: hunter kill/nil returns and permit holders.
# The Base44 token is read by the sync script from BASE44_RAMS_READ_TOKEN or the protected token file;
# the FCM service-role key is fetched at runtime from the linked Supabase CLI. Neither is written to disk.
param(
  [Parameter(Mandatory = $true)][string]$StateDir
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo
New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$log = Join-Path $StateDir "base44-rams-$stamp.log"
# Native tools write notices (e.g. CLI update hints) to stderr; judge them by exit code, not stderr.
$ErrorActionPreference = 'Continue'

$keys = node node_modules\supabase\dist\supabase.js projects api-keys --project-ref dotczcyyzgabmtmnglqj -o json 2>$null | Out-String | ConvertFrom-Json
$env:SUPABASE_SERVICE_ROLE_KEY = ($keys | Where-Object { $_.name -eq 'service_role' }).api_key
if (-not $env:SUPABASE_SERVICE_ROLE_KEY) { "service role key unavailable; run aborted" | Out-File $log; exit 1 }
if (-not $env:SUPABASE_URL) { $env:SUPABASE_URL = 'https://dotczcyyzgabmtmnglqj.supabase.co' }

node scripts\sync-base44-rams.mjs --apply --report (Join-Path $StateDir "report-$stamp.json") 2>&1 | ForEach-Object { "$_" } | Out-File $log -Encoding utf8
exit $LASTEXITCODE
