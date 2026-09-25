param(
  [string]$RepositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
)

$ErrorActionPreference = 'Stop'
$envFile = Join-Path $RepositoryRoot 'deploy\laptop-worker\laptop-worker.env'
$composeFile = Join-Path $RepositoryRoot 'docker-compose.laptop-worker.yml'

if (-not (Test-Path $envFile)) { throw "Missing $envFile" }
if (-not (Test-Path $composeFile)) { throw "Missing $composeFile" }

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
  docker compose --env-file $envFile -f $composeFile build --pull fcm-vision-watcher
  if ($LASTEXITCODE -ne 0) { throw 'The laptop watcher image did not build.' }
  docker compose --env-file $envFile -f $composeFile up -d --no-deps --force-recreate fcm-vision-watcher
  if ($LASTEXITCODE -ne 0) { throw 'The laptop watcher container did not restart.' }

  $state = (docker inspect --format '{{.State.Status}}' fcm-vision-watcher-laptop).Trim()
  if ($state -ne 'running') { throw "The laptop watcher is $state after deployment." }
  Write-Host "Laptop CCTV watcher is running at revision $revision"
  docker compose --env-file $envFile -f $composeFile logs --tail 20 fcm-vision-watcher
} finally {
  Pop-Location
}
