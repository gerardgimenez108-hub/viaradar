param([switch]$RunNow)
$ErrorActionPreference = 'Stop'
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$RunnerPath = Join-Path $PSScriptRoot 'run-ml-experiments.ps1'
$PythonExe = Join-Path $ProjectRoot '.venv-ml\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $PythonExe)) { throw 'Install the .venv-ml environment first.' }
$TaskName = 'ViaRadar ML Experiments'
$PowerShellExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$Identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$RunnerPath`""
$action = New-ScheduledTaskAction -Execute $PowerShellExe -Argument $arguments -WorkingDirectory $ProjectRoot
$triggers = @(
  (New-ScheduledTaskTrigger -AtLogOn -User $Identity),
  (New-ScheduledTaskTrigger -Once -At (Get-Date).AddHours(1) -RepetitionInterval (New-TimeSpan -Hours 1))
)
$principal = New-ScheduledTaskPrincipal -UserId $Identity -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 2 `
  -RestartInterval (New-TimeSpan -Minutes 5) -ExecutionTimeLimit (New-TimeSpan -Minutes 20) `
  -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $TaskName `
  -Description 'Hourly read-only ML evaluation using collected train data. Never replaces the live predictor.' `
  -Action $action -Trigger $triggers -Principal $principal -Settings $settings -Force | Out-Null
if ($RunNow) { Start-ScheduledTask -TaskName $TaskName }
Write-Output "Installed '$TaskName' at sign-in and hourly for $Identity."
Write-Output "Reports and status: $(Join-Path $ProjectRoot 'data\ml')"
Write-Output 'Runs while this user is signed in and the PC is awake. No model is automatically promoted.'
