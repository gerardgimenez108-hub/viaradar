# ViaRadar

A mobile-first installable web app (PWA) for departures at **L'Hospitalet de Llobregat (72305)**. Independent prototype; not affiliated with Renfe or Adif. It never claims to know a platform before the railway operator.

**No Jev account is needed.** The MVP uses public Renfe feeds and an abstaining historical baseline. The supplied Firebase project is prepared locally; it is **not deployed**. See [Firebase readiness](docs/firebase.md) and [verification results](docs/verification.md).

## Run locally

Requires Node.js 24 or newer and npm. From this project directory:

```sh
npm install
npm run import:gtfs
npm run dev
```

Open **http://127.0.0.1:5173**. The API runs on port 8787. The timetable importer downloads the official national ZIP, trims every CSV header/value, and stores only itineraries serving configured stations. It needs several hundred MB of transient memory. Import can take a minute or more.

For the production build / PWA:

```sh
npm run build
npm start
```

Open **http://127.0.0.1:8787**. Service workers are intentionally disabled in development. On iOS use Safari → Share → Add to Home Screen; on Android use the browser install action. Phones require a trusted **HTTPS** deployment; an ordinary LAN HTTP address is not sufficient. Native iOS/Android installation has not been device-tested. Live trains require connectivity; offline retains only the app shell, never a cached live API response.

```sh
npm test
npm run typecheck
npm run collect
```

With the production server running, `npm run test:browser` checks the PWA in a real headless browser. It uses installed Edge on Windows; elsewhere install Chromium with `npx playwright install chromium`. Set `BROWSER_CHANNEL` or `TEST_BASE_URL` to override the browser or local address. Synthetic test departures are browser-only fixtures and never enter the collector database.

`collect` saves one pair of snapshots. The running server collects every 20 seconds and updates station observations independently of API visits. Refreshing the UI reads the latest collected result, not a new upstream request.

## Configuration

Environment variables: `PORT` (8787), `HOST` (127.0.0.1), `DATA_DIR` (data), `STATION_IDS` (comma-separated, default 72305), `STATIC_URL` (official ZIP by default). Set `STATION_IDS` during **both import and server startup**, then restart. The present UI is deliberately Hospitalet-focused; the API supports configured additional stations. The server only binds loopback by default; public deployment needs HTTPS reverse proxy, request limits and monitoring.

`VITE_API_BASE_URL` is an optional **build-time** HTTPS backend origin/path prefix, without `/api`; leave it unset for local same-origin operation. `ALLOWED_ORIGINS` is the backend's comma-separated browser CORS allowlist; its defaults are the two `buscando-la-via-h` Firebase Hosting origins. CORS is not authentication. No analytics or Firebase SDK is activated merely by saving the supplied web configuration. `npm run check:hosting` deliberately fails until a reachable production backend is configured.

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

API: `GET /api/health`, `/api/stations`, `/api/departures?stationId=72305`, `/api/history`. All use `Cache-Control: no-store`. Every departure contains trip/service identifiers, line, destination, scheduled and expected times, cancellation flag, realtime timing flag, and a platform evidence object. Unmatched realtime trips are not guessed into the timetable. Destination falls back from trip headsign to the actual final static stop name, never a fabricated destination.

## Prediction roadmap

The engine contract separates feature context from evidence observations. `historical-frequency-v1` is intentionally simple. Future Jev / XGBoost / LightGBM adapters should consume the same time-valid features and return an abstention when unsupported. No Jev SDK, API contract, access entitlement or model accuracy is invented here. Jev is early access; model confidence must not be assumed to be calibrated platform probability.

Before enabling stronger predictions: collect verified outcomes, split evaluation by service day (never random snapshots), exclude future information, measure coverage, top-1 accuracy, Brier score/calibration and lead time, and compare against the historical baseline. Official data can arrive too late or never include a platform; a model cannot remove this information limit.

## Sources (checked 22 September 2026)

- [Renfe vehicle-position dataset](https://data.renfe.com/dataset/ubicacion-vehiculos): [JSON](https://gtfsrt.renfe.com/vehicle_positions.json).
- [Renfe trip updates](https://data.renfe.com/dataset/horarios-viaje-cercanias): [JSON](https://gtfsrt.renfe.com/trip_updates.json).
- [Renfe static Cercanías dataset](https://data.renfe.com/dataset/horarios-cercanias): [GTFS ZIP](https://ssl.renfe.com/ftransit/Fichero_CER_FOMENTO/fomento_transit.zip).
- [GTFS schedule reference](https://gtfs.org/documentation/schedule/reference/) and [realtime reference](https://gtfs.org/documentation/realtime/reference/).
- [Jev primary announcement](https://typesafe.ai/blog/introducing-system-one-models-and-jev), [confidence documentation](https://docs.typesafe.ai/confidence).

Renfe datasets are offered under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). ViaRadar transforms and combines their data; attribution does not imply endorsement. The raw JSON currently uses camelCase and often string Unix timestamps. `calendar_dates.txt` may be absent. GTFS hours exceeding 24 and Europe/Madrid service-day/DST rules are handled explicitly.

## Scope and limits

This is a local runnable MVP, not a public production railway information service. No push notifications, user accounts, journey planner, crowdsourcing or actual trained ML model. No guarantee of advance platform allocation. It has no synthetic trains in live mode. Static import changes require restart; full production deployments should add atomic dataset refresh, structured metrics and supervised process restart.
