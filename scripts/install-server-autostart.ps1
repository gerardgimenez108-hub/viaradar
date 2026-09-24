$ErrorActionPreference = 'Stop'

$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$WatchdogPath = Join-Path $PSScriptRoot 'run-server-watchdog.ps1'
$NodeExe = (Get-Command node.exe -ErrorAction Stop).Source
$TaskName = 'ViaRadar Local Server'
$PowerShellExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$Identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name

$arguments = @(
  '-NoProfile'
  '-NonInteractive'
  '-ExecutionPolicy Bypass'
  '-WindowStyle Hidden'
  "-File `"$WatchdogPath`""
  "-ProjectRoot `"$ProjectRoot`""
  "-NodeExe `"$NodeExe`""
) -join ' '

$action = New-ScheduledTaskAction `
  -Execute $PowerShellExe `
  -Argument $arguments `
  -WorkingDirectory $ProjectRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $Identity
$principal = New-ScheduledTaskPrincipal `
  -UserId $Identity `
  -LogonType Interactive `
  -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -RestartCount 99 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -MultipleInstances IgnoreNew `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries

Register-ScheduledTask `
  -TaskName $TaskName `
  -Description 'Starts ViaRadar at Windows sign-in and restarts its local API if the health check fails.' `
  -Action $action `
  -Trigger $trigger `
  -Principal $principal `
  -Settings $settings `
  -Force | Out-Null

Start-ScheduledTask -TaskName $TaskName
Write-Output "Installed and started scheduled task '$TaskName' for $Identity."
Write-Output "Project: $ProjectRoot"
Write-Output 'The API health is checked every 30 seconds; a failed API is restarted after three consecutive checks.'
Write-Output "Logs: $env:LOCALAPPDATA\ViaRadar\logs"
