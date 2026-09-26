# ViaRadar architecture

ViaRadar has two separately operated parts: a static PWA on Firebase and a stateful Node API/collector on a Windows PC. SQLite and the timetable stay on that PC. This document describes the implementation, not a future cloud architecture.

## Data flow

```text
Renfe GTFS ZIP --manual import--> data/static.json --startup--> schedule indexes
Renfe GTFS-RT JSON --20s collector--> validated memory feeds + SQLite snapshots
                                                   |
                                 station board / historical-frequency-v1
                                                   |
                       training observations + prospective measurement
                                                   |
                                    Node HTTP API :8787
                                                   |
                                         Tailscale Funnel HTTPS
                                                   |
                               Firebase PWA --20s polling--> users
```

`server/index.ts` starts one collection immediately and every 20 seconds thereafter. A lock prevents overlapping collections. All configured stations are processed even without browser visits. UI refreshes read available feeds; they do not trigger upstream downloads. `npm run collect` downloads one set of snapshots only; continuous board processing/measurement requires the server.

## Components and responsibility

| Module | Responsibility | Boundary |
| --- | --- | --- |
| `import.ts` / `static.ts` | Download/normalize GTFS, retain full itineraries of trips visiting configured stations, load once | No automatic scheduled refresh; restart after import |
| `time.ts` | Active service calendars/exceptions, Europe/Madrid, GTFS hours beyond 24 and DST | Service date differs from wall-clock date around midnight |
| `realtime.ts` | Validate full JSON vehicle/trip feeds, fetch timeouts, source freshness, snapshots | Reject unsupported differential feeds; downloading old data does not make it fresh |
| `incidents.ts` | Fetch/validate alerts; active intervals and station/route scope | Original messages only, no inferred severity |
| `board.ts` | Join schedules with exact-service realtime evidence, platform rules, observations | Unmatched added trips are not guessed into a schedule |
| `prediction.ts` | Replaceable `PredictionEngine`, current modal-frequency baseline | Historical frequency, not calibrated probability |
| `measurement.ts` | Immutable prospective attempts, later evidence and aggregate report | Collector-owned; no retrospective accuracy from training rows |
| `store.ts` | SQLite WAL, additive tables, snapshot/observation retention | Local persistent disk, not Firebase Storage |
| `index.ts` | HTTP API, same-origin built files, CORS and collector lifecycle | No authentication or frontend framework |
| `src/main.ts` | Poll/render, themes/languages, highlights and dialogs | Runtime API validation in `board-contract.ts`; fail closed |
| `public/sw.js` | Network-first app shell caching | Never cache `/api/` or cross-origin live responses |

## Evidence rules

- **Published:** parse `PLATF.(n)` only from a fresh vehicle label at the exact requested stop and service date. A missing date requires an unambiguous active service. Feed/vehicle freshness is 90 seconds with 30 seconds tolerated future clock skew. A publication can change.
- **Training observation:** save a published platform while the vehicle is `STOPPED_AT`; one row per service date/trip/station. Later observed platforms update that training row. Repeated polling does not add independent examples.
- **Prediction:** earlier service dates only, same station/line/destination; minimum 20 distinct services across 3 dates and 80% winning share. Otherwise abstain.
- **Unknown:** intentionally display a dash. Cancellation hides the platform; skipped stops, terminal stops and pickup-prohibited stops are excluded. Unambiguous downstream vehicle evidence removes a passed departure.
- **Timing:** distinguish scheduled from live expected times. Arrival events are not repurposed as departure times. A fresh vehicle still stopped at the station can retain an overdue row; the normal board window is the next three hours, limited to 40 departures.
- **Outage:** stale source evidence and failed browser requests hide live platform claims. Last-known cancellations remain visibly uncertain rather than silently becoming active trains.

## Persistence

| Data | Identity / retention | Purpose |
| --- | --- | --- |
| `static.json` | One current normalized import | Schedule; atomically replaces the file, not the running in-memory dataset |
| `snapshots` | Feed kind + SHA-256 body; 7 days | Raw payload/fetch/source-time audit |
| `observations` | Service date + trip + station; 90 days | Published stopped-at training evidence; last observation wins |
| Prospective measurement tables | Service/date/station/engine identities; 90 days | First attempts, evidence and aggregate agreement; see [policy](predictions.md) |

Raw snapshots can consume substantial disk space. Existing tables/history are not erased by additive measurement initialization. Runtime `data/`, environment overrides and logs are ignored by Git. Backup must include a consistent SQLite state; see the [Windows runbook](self-hosting.md).

## API contracts

All endpoints are GET-only (plus OPTIONS), return JSON with `Cache-Control: no-store`, and apply the configured browser Origin allowlist. Disallowed origins receive 403, unsupported methods 405, unknown routes/stations 404. CORS is not authentication: the public tunnel makes permitted HTTP endpoints publicly reachable.

| Endpoint | Response / interpretation |
| --- | --- |
| `/api/health` | `ok`, `timetableLoaded`, `sources[]`; inspect each source's health/timestamp, not only HTTP200 |
| `/api/stations` | Configured station IDs/names |
| `/api/departures?stationId=72305` | `station`, `generatedAt`, `staticImportedAt`, `sources`, `incidents`, `departures`, `warnings` |
| `/api/history` | Counts/first-last times for snapshots, observation count, retention settings; not prediction accuracy |
| `/api/predictions?stationId=72305` | Prospective aggregate measurement; inspect cohort and denominators in [predictions.md](predictions.md) |

A departure contains `tripId`, `serviceDate`, `line`, `destination`, `scheduledAt`, `expectedAt`, `cancelled`, `realtime`, and a `platform` evidence object. `platform.kind` is `official`, `prediction` or `unknown`. `confidence` in the legacy prediction object is a historical share; it is not an independently validated success probability. `sampleCount` counts historical services, not evaluation outcomes. Official evidence expires.

Alerts have `healthy`, `stale` or `unavailable` status. Only currently active notices for the configured stop, or a mapped R1/R4 route serving it, are returned. Original supplied language is used where a requested translation is unavailable. Stale notices are not presented as current.

## Configuration and extension

Node24+, TypeScript executed with Node type stripping, SQLite via `node:sqlite`, Vite, plain TypeScript UI. Runtime dependencies are `csv-parse`, `fflate` and `luxon`; no model SDK, database server or Firebase client SDK is required.

Environment: `HOST`, `PORT`, `DATA_DIR`, `STATION_IDS`, `STATIC_URL`, `ALLOWED_ORIGINS`. Vite-only `VITE_API_BASE_URL` is public build-time configuration. See `.env.example` for defaults; the Node process does not auto-load it.

Additional stations require consistent `STATION_IDS` during import and startup, schedule validation, station-specific UI, and alert-scoping review. The current interface and importer validation remain Hospitalet-focused; a comma-separated setting alone does not make the whole product station-independent.

New engines should implement `PredictionEngine` but preserve explicit abstention and source separation. Do not train from the app's own guesses. Introduce richer features only after measured time-separated evaluation. API availability, official evidence coverage and prediction quality are separate dimensions.
