# Operar ViaRadar en Windows

La configuración actual utiliza **Tailscale Funnel**, no Cloudflare Tunnel. Firebase sirve la web; el PC mantiene la API, el recolector y SQLite. El PC debe permanecer encendido, conectado y sin suspensión. Es una beta, no un servicio con disponibilidad garantizada.

```text
Renfe → Node y SQLite local → http://127.0.0.1:8787
                                      ↓ Tailscale Funnel
                           https://hp-gerard.tail46e6a0.ts.net
                                      ↑ consultas cada 20 s
                           https://viaradar.web.app
```

## Comprobar antes de reiniciar

Desde la carpeta del proyecto:

```powershell
Invoke-RestMethod 'http://127.0.0.1:8787/api/health' | ConvertTo-Json -Depth 6
Invoke-RestMethod 'https://hp-gerard.tail46e6a0.ts.net/api/health' | ConvertTo-Json -Depth 6
Invoke-RestMethod 'http://127.0.0.1:8787/api/history' | ConvertTo-Json -Depth 6
Get-ScheduledTask -TaskName 'ViaRadar Local Server'
& 'C:\Program Files\Tailscale\tailscale.exe' funnel status
```

`ok: true` indica que responde la API; comprobar además `timetableLoaded`, `sources[].healthy` y sus fechas. Una lista vacía a medianoche puede ser correcta: el panel muestra las próximas tres horas. No es motivo suficiente para reiniciar.

## Inicio automático y logs

`scripts/install-server-autostart.ps1` instala la tarea **ViaRadar Local Server** para el usuario actual. Se ejecuta al iniciar sesión, con privilegios limitados, y lanza un supervisor oculto. Comprueba la API cada 30 segundos y reinicia su proceso después de tres fallos consecutivos. Si encuentra otra instancia sana, la reutiliza: no puede garantizar recuperar un proceso ajeno que no controla.

La tarea también reinicia el supervisor si termina. No reinicia periódicamente una API sana, ni vigila la frescura de Renfe, ni impide la suspensión de Windows.

```powershell
Get-Content "$env:LOCALAPPDATA\ViaRadar\logs\server-watchdog.log" -Tail 30
Get-Content "$env:LOCALAPPDATA\ViaRadar\logs\server.err.log" -Tail 30
```

En otro equipo, preparar Node24+, dependencias, horario y compilación antes del instalador. No registrar tareas duplicadas ni iniciar `npm start` si 8787 está ocupado. Node no carga `.env.local` automáticamente; las variables del backend deben existir en el entorno del proceso que lo inicia. La tarea usa los valores por defecto salvo variables heredadas.

## Tailscale

La cuenta debe estar conectada y Funnel habilitado. Conservar el destino en loopback:

```powershell
npm run funnel
```

Ejecuta `tailscale funnel --bg 8787` y muestra su estado. Habilitar un túnel nuevo expone la API públicamente: requiere autorización del operador. No abrir puertos entrantes del router ni modificar el puerto 7844 de Cloudflare para esta configuración. Los scripts de Cloudflare permanecen como utilidades antiguas, no como ruta activa.

## Actualizar el backend sin perder datos

1. Ejecutar pruebas contra bases aisladas y comprobar la compilación.
2. Crear una copia consistente de SQLite y `data/static.json`. No copiar solo `.sqlite` mientras se escribe en WAL: usar backup de SQLite o detener todos los escritores y conservar el conjunto SQLite/WAL/SHM antes de copiar.
3. En una ventana de mantenimiento, detener el supervisor y la instancia **exacta** de ViaRadar. Verificar el PID propietario del puerto, su comando y los logs. No detener todos los procesos Node del PC.
4. Actualizar archivos y arrancar la tarea. Las tablas de medición se crean de forma aditiva; no borrar ni reemplazar la base.
5. Comprobar salud, frescura, observaciones y `/api/predictions?stationId=72305`. Conservar la copia fuera de Git.

```powershell
# Después de identificar la instancia correcta y guardar los datos:
Stop-ScheduledTask -TaskName 'ViaRadar Local Server'
# Detener el PID de ViaRadar verificado; no copiar un PID de una sesión anterior.
Start-ScheduledTask -TaskName 'ViaRadar Local Server'
```

Detener la tarea no prueba que su hijo terminó: comprobar el puerto. Cambiar TypeScript del backend no recarga el proceso de producción; requiere reinicio. Cambiar el frontend requiere compilar; publicar en Firebase es otra operación.

## Horarios y copias

`npm run import:gtfs` descarga el horario y reemplaza `data/static.json`. Configurar las mismas estaciones al importar y al iniciar; no usar espacios en la lista del importador. Reiniciar para cargar el nuevo horario. No hay tarea diaria de importación ya instalada: programarla y verificarla sigue pendiente.

SQLite conserva snapshots 7 días y observaciones/mediciones 90 días. Vigilar tamaño de disco. Guardar copias fechadas fuera de Git y ensayar restauración en una carpeta aislada, nunca sobre la base activa. Una copia no es una recuperación verificada hasta probarla.

## Evaluación automática de modelos

La tarea independiente **ViaRadar ML Experiments** se ejecuta al iniciar sesión y cada hora. Lee los datos que ya guarda el recolector, sin modificar SQLite ni sustituir el predictor público. Requiere el PC encendido y la sesión iniciada. Consultar `data/ml/status.json` para ver la última ejecución y `data/ml/report.json` para el resultado. `insufficient_data` significa que faltan datos para la comparación, no que el proceso haya fallado. Instalación, retención y desactivación en [experimentos ML](ml-experiments.md).

## Diagnóstico rápido

| Síntoma | Comprobar |
| --- | --- |
| Local falla | Tarea, proceso, puerto, logs y Node |
| Local responde; público falla | Tailscale, conexión y Funnel |
| Terminal funciona; navegador no | CORS y `VITE_API_BASE_URL`; una compilación pública usa el túnel incluso en localhost |
| Panel vacío con fuentes sanas | Franja de tres horas, calendario, validez/importación del horario |
| Hay trenes pero no predicciones | Historial insuficiente/variable o vía oficial disponible; el guion puede ser correcto |
| Medición sin resultados | Backend actualizado, servicios elegibles desde entonces y tiempo para recibir etiquetas posteriores |
| API responde, datos viejos | Fecha de Renfe y errores del recolector; el supervisor no resuelve una caída del proveedor |

Ver [Firebase](firebase.md) para publicar y [predicciones](predictions.md) para interpretar métricas.
