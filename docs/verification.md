# MVP verification — 24 September 2026

**Local MVP verified. Not publicly deployed. Jev is not required or connected.**

## Automated checks

| Check | Result |
| --- | --- |
| `npm test` | 19 passing tests; no failures |
| `npm run typecheck` | Passed with strict TypeScript |
| `npm run build` | Passed; production Vite assets generated |
| `npm run test:browser` | 3 passing browser scenarios in headless Microsoft Edge |
| `npm audit` | Zero reported vulnerabilities at verification time |
| `npm run check:hosting` without a backend | Correctly blocked, exit 1; intentional safety guard |

Tests cover service calendars and exceptions, after-midnight/DST times, exact-station platform evidence, mismatching service dates, stale/future timestamps, cancelled/skipped/no-data stops, downstream vehicles, historical deduplication and abstention, malformed feed structures, snapshot retention, and Firebase deployment prerequisites.

Browser tests cover published/estimated/unknown/cancelled states using isolated synthetic responses, 390px and 1440px layout overflow, line filtering, installation instructions, offline suppression of live claims, preservation of last-known cancellations, malformed API recovery, and first-install offline shell loading. JavaScript/CSS were precached, but live API responses were not.

## Live integration evidence

- Official Renfe static GTFS import succeeded on 24 September at 17:03 UTC: 3,317 relevant trips and 79,720 itinerary stop-time rows after station filtering. These counts describe this particular feed revision, not permanent service totals.
- Both official JSON realtime feeds returned fresh source timestamps through the Node collector. The live Hospitalet board returned roughly 30 upcoming departures during the check, including R1/R4 services. There is no demonstration data in the live API.
- `/api/history` confirmed snapshots persisted in SQLite and a small number of station-bound platform observations. This is not enough to claim prediction accuracy or continuous multi-day collection.
- API responses include `Cache-Control: no-store`. Both configured Firebase origins receive explicit CORS permission. An unrelated origin received 403; an unknown station 404; POST to the read-only API 405; malformed URL encoding 400. The server remained responsive afterward.

## Not verified or not implemented

- Installation on physical iOS/Android devices; test after trusted HTTPS deployment.
- A public backend, Firebase project permissions, deployment, billing, authentication or analytics. The supplied client configuration does not establish those capabilities.
- Jev credentials or inference, trained XGBoost/LightGBM models, calibrated platform probabilities, or measured prediction lead time versus station announcements.
- Production load, disaster recovery, full GTFS-RT extensions, arbitrary added trips absent from the static timetable, or differential feed merging.

## Work units and reversibility

The local MVP is self-contained in this directory, with generated operational data isolated under ignored `data/`. Back up that directory before removing or replacing runtime storage. Firebase preparation is a separate unit: `.firebaserc`, `firebase.json`, `config/firebase.web.json`, `scripts/check-hosting.mjs`, and `docs/firebase.md`. Removing those files and leaving `VITE_API_BASE_URL` unset restores local-only operation without deleting train history. No Git commit or remote artifact was created.

Receipt-driven review mode remains disabled/unmanaged; these are ordinary implementation tests, not an approval receipt.

## Next acceptance gate

Collect enough independent, trustworthy platform outcomes to measure the baseline. Select a persistent HTTPS backend before authorizing Firebase Hosting deployment; the current guard intentionally prevents publishing a disconnected frontend.
