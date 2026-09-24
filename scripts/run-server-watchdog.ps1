param(
  [Parameter(Mandatory = $true)] [string] $ProjectRoot,
  [Parameter(Mandatory = $true)] [string] $NodeExe
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path
$LogDirectory = Join-Path $env:LOCALAPPDATA 'ViaRadar\logs'
$LogPath = Join-Path $LogDirectory 'server-watchdog.log'
$StdoutPath = Join-Path $LogDirectory 'server.out.log'
$StderrPath = Join-Path $LogDirectory 'server.err.log'
$HealthUrl = 'http://127.0.0.1:8787/api/health'
$Process = $null
$FailedHealthChecks = 0

New-Item -ItemType Directory -Path $LogDirectory -Force | Out-Null

function Write-Log([string] $Message) {
  Add-Content -LiteralPath $LogPath -Value "$(Get-Date -Format o) $Message"
}

function Test-ApiHealthy {
  try {
    $response = Invoke-RestMethod -Uri $HealthUrl -TimeoutSec 5
    return [bool] $response.ok
  } catch {
    return $false
  }
}

function Start-ViaRadarServer {
  if (-not (Test-Path -LiteralPath $NodeExe)) {
    Write-Log "Node executable not found: $NodeExe"
    return $null
  }

  try {
    $started = Start-Process -FilePath $NodeExe `
      -ArgumentList @('--experimental-strip-types', 'server/index.ts') `
      -WorkingDirectory $ProjectRoot `
      -WindowStyle Hidden `
      -RedirectStandardOutput $StdoutPath `
      -RedirectStandardError $StderrPath `
      -PassThru
    Write-Log "Started ViaRadar API process $($started.Id)."
    return $started
  } catch {
    Write-Log "Could not start ViaRadar API: $($_.Exception.Message)"
    return $null
  }
}

Write-Log 'Watchdog started.'
while ($true) {
  if ($Process -and $Process.HasExited) {
    Write-Log "API process $($Process.Id) exited with code $($Process.ExitCode)."
    $Process = $null
    $FailedHealthChecks = 0
  }

  if (Test-ApiHealthy) {
    $FailedHealthChecks = 0
  } else {
    $FailedHealthChecks++

    if ($FailedHealthChecks -ge 3 -and $Process) {
      Write-Log "API failed three health checks; stopping owned process $($Process.Id) for recovery."
      try {
        Stop-Process -Id $Process.Id -Force -ErrorAction Stop
        $Process.WaitForExit()
      } catch {
        Write-Log "Could not stop process: $($_.Exception.Message)"
      }
      $Process = $null
      $FailedHealthChecks = 0
    }

    if (-not $Process -and -not (Test-ApiHealthy)) {
      # If another local ViaRadar instance is already healthy, reuse it rather
      # than binding a second process to the same port.
      $Process = Start-ViaRadarServer
    }
  }

  Start-Sleep -Seconds 30
}
