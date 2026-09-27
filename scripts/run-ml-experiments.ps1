$ErrorActionPreference = 'Stop'
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$PythonExe = Join-Path $ProjectRoot '.venv-ml\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $PythonExe)) {
  throw 'The isolated .venv-ml Python environment is missing. Install ml/requirements.txt there first.'
}
Push-Location $ProjectRoot
try {
  & $PythonExe -m ml.runner --db (Join-Path $ProjectRoot 'data\viaradar.sqlite') --output-dir (Join-Path $ProjectRoot 'data\ml')
  $result = $LASTEXITCODE
} finally {
  Pop-Location
}
exit $result
