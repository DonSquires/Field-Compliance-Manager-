# Scheduled R&M source promotion: new/changed workbook rows and structured-name photos.
# The owner approved unattended commits (seeded R&M spreadsheets are verified source truth).
# The service-role key is fetched at runtime from the linked Supabase CLI and never written to disk.
param(
  [Parameter(Mandatory = $true)][string]$SourceRoot,
  [Parameter(Mandatory = $true)][string]$StateDir,
  [int]$PhotoLimit = 200
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo
New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$log = Join-Path $StateDir "promotion-$stamp.log"

$keys = node node_modules\supabase\dist\supabase.js projects api-keys --project-ref dotczcyyzgabmtmnglqj -o json 2>$null | ConvertFrom-Json
$env:SUPABASE_SERVICE_ROLE_KEY = ($keys | Where-Object { $_.name -eq 'service_role' }).api_key
if (-not $env:SUPABASE_SERVICE_ROLE_KEY) { "service role key unavailable; run aborted" | Out-File $log; exit 1 }

node --env-file=.env services\document-source-worker\source-promote.mjs `
  --root $SourceRoot `
  --state (Join-Path $StateDir 'state.json') `
  --report (Join-Path $StateDir "report-$stamp.json") `
  --commit --photos --photo-limit $PhotoLimit *>&1 | Out-File $log -Encoding utf8
exit $LASTEXITCODE
