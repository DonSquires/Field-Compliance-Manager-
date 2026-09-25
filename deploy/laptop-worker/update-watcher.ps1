param(
  [string]$RepositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
)

$ErrorActionPreference = 'Stop'

function Get-DockerContainerInspect {
  param(
    [string]$ContainerName,
    [switch]$AllowMissing
  )

  $inspectJson = docker inspect $ContainerName 2>$null
  if ($LASTEXITCODE -ne 0) {
    if ($AllowMissing) { return $null }
    throw "Could not inspect Docker container $ContainerName."
  }
  return @($inspectJson | ConvertFrom-Json)[0]
}

$envFile = Join-Path $RepositoryRoot 'deploy\laptop-worker\laptop-worker.env'
$composeFile = Join-Path $RepositoryRoot 'docker-compose.laptop-worker.yml'

if (-not (Test-Path $envFile)) { throw "Missing $envFile" }
if (-not (Test-Path $composeFile)) { throw "Missing $composeFile" }
$keyLine = Get-Content $envFile | Where-Object { $_ -match '^LAPTOP_INFERENCE_API_KEY=' } | Select-Object -First 1
$laptopKey = if ($keyLine) { ($keyLine -split '=', 2)[1].Trim() } else { '' }
if ($laptopKey.Length -lt 32 -or $laptopKey -eq 'laptop-local-shared-key') { throw 'Set LAPTOP_INFERENCE_API_KEY to a unique value of at least 32 characters before updating.' }

$composeProject = 'fcm-laptop'
$containerInspect = Get-DockerContainerInspect -ContainerName 'fcm-inference-laptop' -AllowMissing
if ($containerInspect) {
  $detectedComposeProject = $containerInspect.Config.Labels.'com.docker.compose.project'
  if (-not [string]::IsNullOrWhiteSpace($detectedComposeProject)) {
    $composeProject = $detectedComposeProject.Trim()
  }
}

$releaseRoot = $RepositoryRoot
$temporaryWorktree = $null
$hadWorkerEnvFile = Test-Path Env:LAPTOP_WORKER_ENV_FILE
$previousWorkerEnvFile = $env:LAPTOP_WORKER_ENV_FILE

Push-Location $RepositoryRoot
try {
  git fetch --prune origin main
  if ($LASTEXITCODE -ne 0) { throw 'Could not fetch origin/main.' }

  $trackedChanges = git status --porcelain --untracked-files=no
  if ($LASTEXITCODE -ne 0) { throw 'Could not inspect the laptop worker checkout.' }
  if ($trackedChanges) {
    $temporaryWorktree = Join-Path ([System.IO.Path]::GetTempPath()) ("fcm-laptop-release-$([guid]::NewGuid().ToString('N'))")
    git worktree add --detach $temporaryWorktree origin/main
    if ($LASTEXITCODE -ne 0) { throw 'Could not create a clean temporary release from origin/main.' }
    $releaseRoot = $temporaryWorktree
    Write-Host 'Tracked local changes preserved; deploying from a clean temporary release.'
  } else {
    git merge --ff-only origin/main
    if ($LASTEXITCODE -ne 0) { throw 'The checkout cannot fast-forward cleanly.' }
  }

  $composeFile = Join-Path $releaseRoot 'docker-compose.laptop-worker.yml'
  $revision = (git -C $releaseRoot rev-parse --short HEAD).Trim()
  $env:LAPTOP_WORKER_ENV_FILE = $envFile
  $composeArgs = @('compose', '--project-name', $composeProject, '--env-file', $envFile, '-f', $composeFile)
  & docker @composeArgs build --pull fcm-inference fcm-vision-watcher
  if ($LASTEXITCODE -ne 0) { throw 'The laptop GPU inference or watcher image did not build.' }
  & docker @composeArgs up -d --force-recreate --wait fcm-inference fcm-vision-watcher
  if ($LASTEXITCODE -ne 0) { throw 'The laptop GPU inference/watcher pair did not restart cleanly.' }

  $inferenceState = (Get-DockerContainerInspect -ContainerName 'fcm-inference-laptop').State.Status
  $state = (Get-DockerContainerInspect -ContainerName 'fcm-vision-watcher-laptop').State.Status
  if ($inferenceState -ne 'running') { throw "The laptop GPU inference service is $inferenceState after deployment." }
  if ($state -ne 'running') { throw "The laptop watcher is $state after deployment." }
  $healthJson = docker exec fcm-inference-laptop python -c "import json,urllib.request; print(json.dumps(json.load(urllib.request.urlopen('http://127.0.0.1:3000/health'))))"
  if ($LASTEXITCODE -ne 0) { throw 'The laptop inference health endpoint did not answer.' }
  $health = $healthJson | ConvertFrom-Json
  if ($health.cuda -ne $true) { throw "Laptop inference is not using CUDA ($($health.detector_provider))." }
  if ($health.super_resolution.state -ne 'ready') { throw "Laptop super-resolution model is $($health.super_resolution.state), not ready." }
  Write-Host "Laptop CCTV GPU inference and watcher are running at revision $revision"
  & docker @composeArgs logs --tail 20 fcm-vision-watcher
} finally {
  if ($hadWorkerEnvFile) {
    $env:LAPTOP_WORKER_ENV_FILE = $previousWorkerEnvFile
  } else {
    Remove-Item Env:LAPTOP_WORKER_ENV_FILE -ErrorAction SilentlyContinue
  }
  if ($temporaryWorktree -and (Test-Path $temporaryWorktree)) {
    git worktree remove --force $temporaryWorktree
    if ($LASTEXITCODE -ne 0) { Write-Warning "Temporary release cleanup failed: $temporaryWorktree" }
  }
  Pop-Location
}
