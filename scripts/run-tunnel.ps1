param(
  [int]$Port = 8787,
  [switch]$Quick
)

$ErrorActionPreference = "Stop"

if (-not (Get-Command cloudflared -ErrorAction SilentlyContinue)) {
  throw "cloudflared no está instalado. Instálalo desde https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
}

Write-Host "Iniciando túnel HTTPS hacia http://127.0.0.1:$Port"
if ($Quick) {
  Write-Warning "Quick Tunnel: la URL es temporal y no sirve como endpoint permanente de producción."
  cloudflared tunnel --url "http://127.0.0.1:$Port"
} else {
  cloudflared tunnel run viaradar
}
