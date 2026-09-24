param([int]$Port = 8787)

$ErrorActionPreference = "Stop"
$tailscale = "C:\Program Files\Tailscale\tailscale.exe"
if (-not (Test-Path $tailscale)) { throw "Tailscale no está instalado." }

& $tailscale funnel --bg $Port
& $tailscale funnel status
