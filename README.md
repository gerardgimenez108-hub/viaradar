# ViaRadar

A mobile-first installable web app (PWA) for departures at **L'Hospitalet de Llobregat (72305)**. Independent prototype; not affiliated with Renfe or Adif. It never claims to know a platform before the railway operator.

**No Jev account is needed.** The MVP uses public Renfe feeds and an abstaining historical baseline. The frontend is published at **https://viaradar.web.app/**; the API and collector run on a Windows PC through Tailscale Funnel. Firebase Hosting does not run the backend. See [deployment](docs/firebase.md) and [verification results](docs/verification.md).

## Start here

| Need | Read |
| --- | --- |
| Continue work without reconstructing earlier chats | [context.md](context.md) |
| Understand modules, data, contracts and boundaries | [Architecture](docs/architecture.md) |
| Understand predictions, measurement and the improvement plan | [Prediction measurement](docs/predictions.md) |
| Assess reusable GitHub tools before adopting a model | [Prediction research](docs/prediction-research.md) |
| Operate or recover the Windows server | [Self-hosting runbook](docs/self-hosting.md) |
| Publish the frontend to the correct Firebase site | [Firebase deployment](docs/firebase.md) |
| See what has actually been tested | [Verification](docs/verification.md) |

## Run locally

Requires Node.js 24 or newer and npm. From this project directory:

```sh
npm install
npm run import:gtfs
npm run dev
```

Open **http://127.0.0.1:5173**. The API runs on port 8787. On the existing host, the Windows watchdog already owns that port: do not start a second API. For frontend-only development use `npx vite --host 127.0.0.1`. For a clean local setup, remove the public `VITE_API_BASE_URL` override from your shell and `.env.local` so the dev proxy is used. The timetable importer downloads the official national ZIP, trims every CSV header/value, and stores only itineraries serving configured stations. It needs several hundred MB of transient memory. Import can take a minute or more.

For the production build / PWA:

```sh
npm run build
npm start
```

Open **http://127.0.0.1:8787**. Service workers are intentionally disabled in development. On iOS use Safari → Share → Add to Home Screen; on Android use the browser install action. Phones require a trusted **HTTPS** deployment; an ordinary LAN HTTP address is not sufficient. Native iOS/Android installation has not been device-tested. Live trains require connectivity; offline retains only the app shell, never a cached live API response.

### Start automatically on Windows

Run `scripts/install-server-autostart.ps1` once from PowerShell in this folder. It registers a Task Scheduler task for the current Windows user, starts the local API at sign-in, and checks `/api/health` every 30 seconds. After three consecutive failures it restarts the API; Task Scheduler also restarts the watchdog if it exits. The process runs hidden and writes logs under `%LOCALAPPDATA%\ViaRadar\logs`. This does not deliberately restart a healthy API on a timer, avoiding unnecessary interruptions. Remove it with `Unregister-ScheduledTask -TaskName 'ViaRadar Local Server' -Confirm:$false`.

```sh
npm test
npm run typecheck
npm run collect
```

With the production server running, `npm run test:browser` checks the PWA in a real headless browser. It uses installed Edge on Windows; elsewhere install Chromium with `npx playwright install chromium`. Set `BROWSER_CHANNEL` or `TEST_BASE_URL` to override the browser or local address. Synthetic test departures are browser-only fixtures and never enter the collector database.

`collect` saves the current vehicle-position, trip-update and service-alert snapshots. The running server collects every 20 seconds and updates station observations independently of API visits. Refreshing the UI reads the latest collected result, not a new upstream request.

The board includes current Renfe GTFS-RT alerts only when their informed stop is L'Hospitalet (`72305`) or their route ID maps through the imported GTFS to an R1/R4 service serving that station. Expired and out-of-scope alerts are omitted. Renfe's translated message and active interval are shown as supplied; ViaRadar does not infer an incident severity. If the alerts feed is stale or unavailable, the API returns no alert items and reports its source status rather than presenting old notices as current.

## Configuration

Environment variables: `PORT` (8787), `HOST` (127.0.0.1), `DATA_DIR` (data), `STATION_IDS` (comma-separated, default 72305), `STATIC_URL` (official ZIP by default). Set `STATION_IDS` during **both import and server startup**, then restart. The present UI is deliberately Hospitalet-focused; the API supports configured additional stations. The server only binds loopback by default; public deployment needs HTTPS reverse proxy, request limits and monitoring.

`VITE_API_BASE_URL` is an optional **build-time** HTTPS backend origin/path prefix, without `/api`; leave it unset for local same-origin operation. Vite reads `.env.local`, but the Node server and Hosting guard do not automatically load it. `ALLOWED_ORIGINS` replaces the backend's complete browser CORS allowlist when set. Defaults include both Firebase site names, localhost/127.0.0.1 on 5173 and 8787, and a legacy Vercel origin; see `server/origins.ts`. Vercel is not the intended deployment destination. CORS is not authentication. No analytics or Firebase SDK is activated merely by saving the supplied web configuration. `npm run check:hosting` fails unless a reachable public HTTPS backend is configured in the launching shell.

Timetables are not downloaded automatically on startup. Re-run the importer regularly (daily recommended) and restart the service. Calendar validity controls results; an expired dataset cannot manufacture future trains. The current data is ignored if absent and an actionable setup message appears instead.

## Evidence and uncertainty

- **Published:** `PLATF.(n)` in a fresh Renfe vehicle label **only for that vehicle's exact `stopId`**. Both feed and vehicle must be within 90 seconds of now (30-second future clock tolerance). Explicit service date must match. When absent, only a unique active static service day within a four-hour window is accepted. This is a conservative association, not a guarantee that the platform will remain unchanged.
- **Estimate:** historical published-at-station observations, only from vehicles `STOPPED_AT`; one record per service date/trip/station, last observation wins. At least 20 earlier services over three distinct dates and 80% modal share are required. The shown percentage is **historical share, not calibrated probability**. Platform observations are not verified actual departures. No prediction at cold start is the expected safe result.
- **Unknown:** no acceptable evidence. A dash is intentional, not a broken prediction model. Station screens and announcements take precedence.

Cancelled services have no platform. Skipped stops are excluded. `NO_DATA` prevents realtime timing inference at that stop. A vehicle observed downstream removes a departure where its stop sequence is unambiguous. Terminal stops and `pickup_type=1` are excluded. Static times and live estimates are labelled separately. Arrival-only events are not repurposed as departure times. A feed outage immediately removes its official-platform evidence; browser connection failures and aging also hide previously shown platforms.

After a browser outage, previously cancelled services remain labelled as **last-known cancellations**, never silently restored as operating trains. Malformed nested feed/API payloads fail closed rather than crashing the board. Unsupported differential feeds are rejected; current Renfe full snapshots are supported.

## Architecture

`server/import.ts` → normalized station-relevant static JSON; `server/realtime.ts` → live fetch + raw SQLite snapshots; `server/board.ts` → static/realtime joins and evidence; `server/prediction.ts` → interchangeable `PredictionEngine`; `server/index.ts` → HTTP API + built frontend; `src/` → responsive TypeScript UI; `public/sw.js` → shell-only caching. No framework or cloud account is needed.

Static station/trip indexes are built once per loaded dataset rather than rescanning the national timetable on every request. Imported datasets are treated as immutable; restarting after import builds new indexes.

SQLite uses WAL and stores deduplicated payloads (SHA-256), fetch time and source timestamp. Raw snapshots retain 7 days; observations retain 90 days, purged after successful collection. National feeds can consume substantial disk space (potentially GB/week); monitor the data directory. Back up or delete `data/` only while the server is stopped. No personal data or user locations are collected.

API: `GET /api/health`, `/api/stations`, `/api/departures?stationId=72305`, `/api/history`, and `/api/predictions?stationId=72305` (prospective measurement, requires the updated backend). All use `Cache-Control: no-store`. See [API contracts](docs/architecture.md#api-contracts). Unmatched realtime trips are not guessed into the timetable. Destination falls back from trip headsign to the actual final static stop name, never a fabricated destination.

## Prediction roadmap

The engine contract separates feature context from evidence observations. `historical-frequency-v1` is intentionally simple. Future Jev / XGBoost / LightGBM adapters should consume the same time-valid features and return an abstention when unsupported. No Jev SDK, API contract, access entitlement or model accuracy is invented here. Jev is early access; model confidence must not be assumed to be calibrated platform probability.

The first improvement phase records prospective first-opportunity attempts and later published-platform evidence, without changing the predictor. Read [the exact metric definitions and continuation plan](docs/predictions.md) before interpreting the results. This does not create a historical accuracy result from existing training observations. Subsequent model comparisons must split by service day (never random snapshots), exclude future information, and report coverage and lead time alongside agreement. Calibration/Brier metrics are a future phase, not current capabilities. Official data can arrive too late or never include a platform; a model cannot remove this information limit.

## Sources (checked 22 September 2026)

- [Renfe vehicle-position dataset](https://data.renfe.com/dataset/ubicacion-vehiculos): [JSON](https://gtfsrt.renfe.com/vehicle_positions.json).
- [Renfe trip updates](https://data.renfe.com/dataset/horarios-viaje-cercanias): [JSON](https://gtfsrt.renfe.com/trip_updates.json).
- [Renfe incidents and notices](https://data.renfe.com/es/dataset/incidencias-avisos): [GTFS-RT JSON](https://gtfsrt.renfe.com/alerts.json).
- [Renfe static Cercanías dataset](https://data.renfe.com/dataset/horarios-cercanias): [GTFS ZIP](https://ssl.renfe.com/ftransit/Fichero_CER_FOMENTO/fomento_transit.zip).
- [GTFS schedule reference](https://gtfs.org/documentation/schedule/reference/) and [realtime reference](https://gtfs.org/documentation/realtime/reference/).
- [Jev primary announcement](https://typesafe.ai/blog/introducing-system-one-models-and-jev), [confidence documentation](https://docs.typesafe.ai/confidence).

Renfe datasets are offered under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). ViaRadar transforms and combines their data; attribution does not imply endorsement. The raw JSON currently uses camelCase and often string Unix timestamps. `calendar_dates.txt` may be absent. GTFS hours exceeding 24 and Europe/Madrid service-day/DST rules are handled explicitly.

## Scope and limits

This is a publicly accessible beta backed by one PC, not an official or highly available railway information service. No push notifications, user accounts, journey planner, crowdsourcing or trained ML model. No guarantee of advance platform allocation or perfect predictions. It has no synthetic trains in live mode. The Windows watchdog supervises API availability, not feed quality; static import changes still require a restart. Real-device installation, load testing, automatic timetable refresh and disaster-recovery drills remain work to do.
