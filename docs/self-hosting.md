# Self-hosting de ViaRadar en Windows

Esta es la configuración de coste cero para recibir actualizaciones cada 20 segundos:

```text
Renfe/GTFS-RT -> recolector Node.js -> SQLite local -> API localhost:8787
                                                       |
                                             Cloudflare Tunnel HTTPS
                                                       |
                                             PWA en Firebase Hosting
```

## 1. Preparar el servidor local

En una terminal de PowerShell:

```powershell
cd outputs/viaradar
npm install
npm run import:gtfs
$env:HOST="127.0.0.1"
$env:PORT="8787"
$env:ALLOWED_ORIGINS="https://buscando-la-via-h.web.app,https://buscando-la-via-h.firebaseapp.com"
npm start
```

El recolector se ejecuta automáticamente cada 20 segundos. Comprueba que funciona en `http://127.0.0.1:8787/api/health`.

## 2. Exponer la API con HTTPS

Instala `cloudflared` y crea un túnel con nombre `viaradar` en Cloudflare. El túnel debe apuntar a:

```text
http://127.0.0.1:8787
```

Después ejecútalo con:

```powershell
.\scripts\run-tunnel.ps1
```

El modo de prueba temporal se puede iniciar con `.\scripts\run-tunnel.ps1 -Quick`, pero su URL cambia y no debe configurarse como endpoint permanente.

## 3. Conectar Firebase

Con la URL HTTPS estable del túnel, configura temporalmente la variable de build:

```powershell
$env:VITE_API_BASE_URL="https://api.tu-dominio.example"
npm run check:hosting
npm run build
```

Solo después de que el chequeo pase se debe publicar Firebase Hosting.

## Operación y límites

- El PC debe permanecer encendido, conectado y sin suspensión.
- El túnel y Node deben configurarse como tareas/servicios de inicio automático.
- SQLite está en disco local: hay que hacer copias de seguridad.
- CORS limita los navegadores autorizados, pero no sustituye una política de seguridad completa.
- Este diseño es adecuado para beta y pruebas reales; para disponibilidad 24/7 habrá que migrar el backend a infraestructura persistente.
