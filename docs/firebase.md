# Firebase is prepared, not deployed

ViaRadar remains a locally runnable app without Jev. The supplied Firebase project is **buscando-la-via-h**. These files prepare its frontend for a later, explicitly authorized deployment; they do not create cloud resources or provide a running remote backend.

## What is configured

| File                        | Purpose                                                                                                         |
| --------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `config/firebase.web.json`  | Exact public web-app configuration supplied by the user. It is not imported by the app.                         |
| `.firebaserc`               | Selects the project ID for a future Firebase CLI operation.                                                     |
| `firebase.json`             | Publishes only `dist`, uses an SPA fallback, and checks the backend before rebuilding. No invented API rewrite. |
| `scripts/check-hosting.mjs` | Refuses deployment without a reachable HTTPS backend serving the expected API and CORS headers.                 |

No Firebase SDK or Analytics initialization is added. Keeping a `measurementId` in a configuration file does not activate tracking. No Authentication, Firestore, Storage, security rules, billing settings or deployment has been changed. Firebase web configuration identifies the project; it does **not** grant administrator or CLI access. [Firebase API-key guidance](https://firebase.google.com/docs/projects/api-keys).

## The missing piece: a persistent backend

Firebase Hosting serves the built PWA. It does not execute this Node API, keep the 20-second collector running, or preserve the SQLite history. Dynamic backends require a separate service; Firebase can integrate with Cloud Run, but no such service is configured here. [Hosting configuration](https://firebase.google.com/docs/hosting/full-config), [Hosting with Cloud Run](https://firebase.google.com/docs/hosting/cloud-run).

The smallest backend continuation is a supervised Node process with persistent local storage, HTTPS, backups and a reliable continuous collector. Cloud Run needs a deliberate storage/collector redesign: its container filesystem is temporary, and instances can stop. Do not upload the SQLite app unchanged and assume its history is durable. Firestore or another managed durable store is a possible migration, not something already implemented. [Cloud Run runtime contract](https://docs.cloud.google.com/run/docs/container-contract#file_system).

## Before any frontend deployment

1. Deploy and validate a backend with persistent storage; import the timetable and verify ongoing snapshots. Configure its CORS allowlist for `https://buscando-la-via-h.web.app` and `https://buscando-la-via-h.firebaseapp.com`.
2. Set `VITE_API_BASE_URL` in the same shell used for checking and building. Use the backend origin or path prefix, without a final `/api`. The value is public and embedded in the frontend bundle; never put a credential there.
3. Run the check below. Only after explicit deployment authorization and authenticated project access should an operator run the Firebase CLI deployment.

PowerShell, replacing the placeholder with the **real deployed backend**:

```powershell
$env:VITE_API_BASE_URL = "https://your-real-backend.example"
node scripts/check-hosting.mjs
```

The example hostname is not a provisioned service. The check rejects missing values, localhost/private literal addresses, plain HTTP, credentials, HTML fallback responses, missing browser CORS, cacheable live API responses, invalid board contracts and stale board timestamps. It performs read-only API requests. An empty departure list is valid; it does not require fabricated trains or a platform prediction to pass. It checks both default Hosting origins. Add any future custom origin deliberately to both the server allowlist and the check.

The Hosting predeploy hooks run this check and then `npm run build` under the same environment. The guard intentionally requires a shell environment variable rather than assuming a `.env` file was loaded. Deploying the frontend without the backend would otherwise yield an attractive but nonfunctional board. Do not remove the guard to make an incomplete deployment pass.

## Readiness checklist

- [ ] Backend deployed on persistent infrastructure and reachable over trusted HTTPS.
- [ ] Collection continues without an open browser and after process restart.
- [ ] Timetable import refresh and data retention scheduled and monitored.
- [ ] Both Hosting origins can read the API through browser CORS.
- [ ] Deployment precondition succeeds against the real backend.
- [ ] User authorizes deployment and authenticates an account with project access.
- [ ] Real-device iOS/Android installation and offline behavior verified after deployment.

No production backend URL has been supplied or verified yet. Local development continues to use the same-origin `/api` proxy and needs neither Firebase nor a Jev account.
