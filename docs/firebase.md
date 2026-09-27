# Deploy the frontend to Firebase Hosting

**Production frontend: https://viaradar.web.app/**. Project ID: `buscando-la-via-h`. Hosting target and site: `viaradar`. Renaming the Firebase display name does not rename these IDs. Do not substitute the legacy Vercel deployment.

The frontend was republished successfully on 27 September 2026 at about 23:26 Europe/Madrid from `029b7d5`, after the automatic ML work. Public assets and live browser data were verified. This release does not change the UI or activate a new passenger predictor; the Windows ML task is separately installed. See [verification](verification.md).

## What Firebase hosts

Firebase serves `dist/` as a PWA. The API, 20-second collector, timetable and SQLite history run on the Windows PC, exposed through `https://hp-gerard.tail46e6a0.ts.net`. Deploying the PWA does not update that Node process or give it uptime when the PC is asleep.

| File | Purpose |
| --- | --- |
| `.firebaserc` | Project `buscando-la-via-h`, target `viaradar` maps to site `viaradar` |
| `firebase.json` | Static `dist`, SPA fallback, cache headers, backend check then build |
| `scripts/check-hosting.mjs` | Validate HTTPS backend, health, board contract, no-store and all four Firebase origins |
| `config/firebase.web.json` | Public project configuration; not imported by the app |

No Firebase SDK or Analytics runs in the app. The client API key is not an administrator credential. Never put an OAuth token, server secret or model API key into frontend configuration.

## Publish an authorized release

Run from the repository root in PowerShell, after tests pass. Firebase CLI must be authenticated to an account with access to this project. Check the active account; do not post login codes in documentation.

```powershell
git status -sb
npm test
npm run build
# Requires a running local built app:
npm run test:browser

$env:VITE_API_BASE_URL = 'https://hp-gerard.tail46e6a0.ts.net'
npm run check:hosting
firebase deploy --only hosting:viaradar --project buscando-la-via-h
```

Predeploy repeats the backend check and builds under the same environment. The guard needs the shell variable; `.env.local` alone is not enough. `VITE_API_BASE_URL` is embedded publicly in the bundle and must omit `/api`. If PowerShell's CLI shim has issues, use the installed `firebase.cmd`; do not bypass the check.

The check verifies four origins: `.web.app` and `.firebaseapp.com` for both `viaradar` and `buscando-la-via-h`. An `ALLOWED_ORIGINS` override must retain all four for this guard. It rejects a local/insecure URL, credentials in the URL, HTML fallback responses, stale board timestamps, incorrect CORS or cacheable live responses. Empty overnight departures are valid. The check does not prove 24/7 availability or prediction quality.

## Verify and recover

1. Confirm **Hosting URL: https://viaradar.web.app** in CLI output.
2. Fetch/open that exact URL. Compare its JS/CSS asset names with `dist/index.html` and inspect the new feature.
3. Verify the public API is reachable from the deployed browser, not only from a terminal. Check source freshness and board/notice states.
4. Record commit and release verification. GitHub push and Firebase deploy are independent operations; verify both.

If an installed PWA remains on an older loaded screen, close/reopen or refresh while online. The service worker caches the shell, never live API responses. Do not delete the server database to fix browser caching.

- If the API check fails, inspect the PC, watchdog, Tailscale and CORS using the [runbook](self-hosting.md). Do not deploy a knowingly disconnected build.
- Revert the frontend by building/deploying an intended previous revision or using a known previous Hosting release. This does not revert backend schema/code.
- Backend-only measurement changes need a tested Node restart, not a Firebase deployment.
- No automated release pipeline, Cloud Run backend, Firestore migration, billing change or managed uptime guarantee is configured by this project.
