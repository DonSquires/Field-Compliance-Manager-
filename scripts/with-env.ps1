param(
  [Parameter(Mandatory = $true)][string[]]$Command
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

foreach ($relative in @('deploy\laptop-worker\laptop-worker.env', '.env')) {
  $path = Join-Path $root $relative
  if (-not (Test-Path $path)) { continue }
  foreach ($line in Get-Content $path) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith('#') -or -not $trimmed.Contains('=')) { continue }
    $parts = $trimmed.Split('=', 2)
    $name = $parts[0].Trim()
    $value = $parts[1].Trim().Trim('"').Trim("'")
    if (-not $value) { continue }
    if ([Environment]::GetEnvironmentVariable($name, 'Process')) { continue }
    [Environment]::SetEnvironmentVariable($name, $value, 'Process')
  }
}

& $Command[0] $Command[1..($Command.Length - 1)]
exit $LASTEXITCODE
