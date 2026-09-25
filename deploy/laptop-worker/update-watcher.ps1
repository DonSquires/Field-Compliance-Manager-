param(
  [string]$RepositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
)

$ErrorActionPreference = 'Stop'
$envFile = Join-Path $RepositoryRoot 'deploy\laptop-worker\laptop-worker.env'
$composeFile = Join-Path $RepositoryRoot 'docker-compose.laptop-worker.yml'

if (-not (Test-Path $envFile)) { throw "Missing $envFile" }
if (-not (Test-Path $composeFile)) { throw "Missing $composeFile" }
$keyLine = Get-Content $envFile | Where-Object { $_ -match '^LAPTOP_INFERENCE_API_KEY=' } | Select-Object -First 1
$laptopKey = if ($keyLine) { ($keyLine -split '=', 2)[1].Trim() } else { '' }
if ($laptopKey.Length -lt 32 -or $laptopKey -eq 'laptop-local-shared-key') { throw 'Set LAPTOP_INFERENCE_API_KEY to a unique value of at least 32 characters before updating.' }

Push-Location $RepositoryRoot
try {
  $trackedChanges = git status --porcelain --untracked-files=no
  if ($LASTEXITCODE -ne 0) { throw 'Could not inspect the laptop worker checkout.' }
  if ($trackedChanges) { throw 'The checkout has tracked local changes. Commit or preserve them before updating the worker.' }

  git fetch --prune origin main
  if ($LASTEXITCODE -ne 0) { throw 'Could not fetch origin/main.' }
  git merge --ff-only FETCH_HEAD
  if ($LASTEXITCODE -ne 0) { throw 'The checkout cannot fast-forward cleanly.' }

  $revision = (git rev-parse --short HEAD).Trim()
  docker compose --env-file $envFile -f $composeFile build --pull fcm-inference fcm-vision-watcher
  if ($LASTEXITCODE -ne 0) { throw 'The laptop GPU inference or watcher image did not build.' }
  docker compose --env-file $envFile -f $composeFile up -d --force-recreate --wait fcm-inference fcm-vision-watcher
  if ($LASTEXITCODE -ne 0) { throw 'The laptop GPU inference/watcher pair did not restart cleanly.' }

  $inferenceState = (docker inspect --format '{{.State.Status}}' fcm-inference-laptop).Trim()
  $state = (docker inspect --format '{{.State.Status}}' fcm-vision-watcher-laptop).Trim()
  if ($inferenceState -ne 'running') { throw "The laptop GPU inference service is $inferenceState after deployment." }
  if ($state -ne 'running') { throw "The laptop watcher is $state after deployment." }
  Write-Host "Laptop CCTV GPU inference and watcher are running at revision $revision"
  docker compose --env-file $envFile -f $composeFile logs --tail 20 fcm-vision-watcher
} finally {
  Pop-Location
}
