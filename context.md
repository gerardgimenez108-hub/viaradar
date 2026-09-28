# ViaRadar — continuation context

Updated: **28 September 2026**. This is the handoff entry point, not a substitute for checking running services and current code.

## Product and non-negotiables

ViaRadar is a smartphone-first PWA for departures at L'Hospitalet de Llobregat (`72305`). It combines public Renfe schedules, realtime train data and service notices. It separates **published platforms**, **historical estimates**, and **unknowns**. It must never fabricate trains, platforms, incident severity, or certainty.

- Frontend destination: **https://viaradar.web.app/**, Firebase project `buscando-la-via-h`, Hosting target/site `viaradar`. Do not deploy to Vercel by mistake.
- Repository: https://github.com/gerardgimenez108-hub/viaradar, branch `main`.
- Existing host project directory: `C:\Users\PC\Documents\Codex\2026-09-22\referenced-chatgpt-conversation-this-is-an\outputs\viaradar`.
- API: local `http://127.0.0.1:8787`, public `https://hp-gerard.tail46e6a0.ts.net` through Tailscale Funnel. Reverify reachability; this is not a managed cloud backend.
- Public frontend deployment does **not** deploy or restart backend code.
- No Jev integration or account is required. Do not claim Jev, XGBoost or LightGBM is running.
- Spanish/English UI, automatic device language/theme with manual overrides; preserve compact settings and install actions, PWA icon, and meaningful 12-second change highlighting with reduced-motion support.
- No secrets, user tokens, raw data, SQLite files or operational logs in Git. Conventional commits; no AI attribution.

## Current work and boundaries

The mobile redesign is published in commit `41d27ef` (26 September). It includes a compact header, clearer platform wording, and neutral Renfe notices. That release passed 26 unit and 8 browser tests.

The previously activated work unit is **prospective prediction measurement**, not a replacement prediction model. It records first eligible attempts including abstentions, compares with later official stopped-at-platform evidence, and exposes aggregate metrics. It was activated in the PC backend at 00:56 on 27 September after backup; 35 unit and 8 browser checks passed. Initial metrics were empty because no overnight services qualified. These changes are committed/pushed as `800ed85`; no new Firebase release was made. See [predictions.md](docs/predictions.md) for the exact cohort and [verification.md](docs/verification.md) for the dated evidence. Never infer deployment from a file existing locally.

Current predictor: `historical-frequency-v1`, grouping by station/line/destination, at least 20 distinct services across 3 prior service dates, winning share at least 80%. The percentage is a historical frequency, **not measured accuracy or a calibrated chance of success**.

## Where to work

| Area | Entry point |
| --- | --- |
| Runtime orchestration and HTTP endpoints | `server/index.ts` |
| Schedule/feed join, published platform and training observations | `server/board.ts` |
| Baseline engine contract and abstention | `server/prediction.ts` |
| Prospective attempts, outcomes and metrics | `server/measurement.ts`, [measurement policy](docs/predictions.md) |
| Realtime download, validation and freshness | `server/realtime.ts` |
| Alert filtering and original Renfe messages | `server/incidents.ts` |
| SQLite persistence / schedule loading | `server/store.ts`, `server/static.ts` |
| Calendar exceptions and GTFS times over 24h/DST | `server/time.ts` |
| UI rendering, polling and meaningful changes | `src/main.ts` |
| Layout, language, API validation | `src/shell.ts`, `src/style.css`, `src/i18n.ts`, `src/board-contract.ts` |
| Installed-app shell, not live data | `public/sw.js`, `public/manifest*.webmanifest` |
| Windows recovery / Hosting validation | `scripts/`, [self-hosting](docs/self-hosting.md), [Firebase](docs/firebase.md) |

## Before making changes

1. Run `git status -sb`; preserve unrelated work. Read the relevant module and [architecture](docs/architecture.md).
2. Check `/api/health`, `/api/history`, and the real departure response. `/api/health` returning `ok: true` alone does not mean all upstream feeds are fresh.
3. Check whether `ViaRadar Local Server` already runs. Do not bind a second API to 8787 or stop unrelated Node processes.
4. Test in an isolated database. Browser fixtures are synthetic and must never enter live collection/evaluation.
5. Validate with `npm test`, `npm run build`, and `npm run test:browser` against a built running local server. Update [verification](docs/verification.md) with actual results, not planned claims.

## Known operational traps

- The board shows only the next three hours. An empty board overnight is normal: at 00:36 on 27 September the next active scheduled departure was 05:21. Do not invent service or restart a healthy API just to populate the screen.
- The PC must be awake, connected and signed in for its per-user watchdog; there is no uptime guarantee. Tailscale and Node are separate dependencies.
- Vite reads `.env.local`; Node does not. Hosting predeploy needs `VITE_API_BASE_URL` explicitly in the shell. A frontend built with the public URL still uses the public tunnel when opened on localhost.
- The GTFS timetable is loaded at server start. Reimporting does not refresh the running in-memory dataset; restart deliberately after import.
- Snapshot count is not independent train count. Training observations are one per service date/trip/station and can be updated with later evidence.
- An official stopped-at platform is an observed publication, not proof of physical departure. Measurement must preserve that distinction.
- Renfe messages may remain in Catalan if that is the only supplied translation. Do not silently invent a translation or severity.

## Next decision gate

Latest release: `029b7d5` pushed to GitHub and Firebase site `viaradar` redeployed on 27 September at about 23:26 Europe/Madrid. The independent `ViaRadar ML Experiments` Windows task is installed at logon/hourly; first run succeeded with 175 checkpoints/89 labels/1 date (`insufficient_data`). The public page was verified connected with R1/R4 departures. 41 Python, 35 Node and 8 browser tests pass. No live predictor replacement or API restart. See [R1 audit](docs/r1-evidence-audit.md): only 5 R1 stopped-platform observations, so the missing R1 predictions are a documented evidence limitation, not fixed by the new models.

Collect real prospective attempts/outcomes before claiming improved accuracy. Inspect missing labels, coverage, days represented and lead time. Only then compare a time/day-aware model against this frozen baseline using future service days; do not tune and evaluate on the same cases. Jev remains an optional later adapter with no promised advantage.

[GitHub research](docs/prediction-research.md) led to an isolated Python experiment workspace in `ml/`: scikit-learn metrics, a CatBoost challenger, and River delayed-label replay. See [ML experiments](docs/ml-experiments.md) for setup, hourly Windows evaluation and report history. These are automatically evaluated offline experiments, not passenger-facing engines. No automatic promotion or API subprocess is added. Keep the live historical baseline unchanged until comparative evidence supports a separately approved rollout.

Keep this file brief and update it whenever deployment topology, evaluation policy or the next work unit changes. Put detailed contracts and runbooks in `docs/`.

## Active correction — 28 September 2026

Independent assignment collection is now active, including platforms published before `STOPPED_AT`. Recovered snapshots preserve assignments for R1 without changing old observations or retrospective prediction scores. `/api/assignments?stationId=72305` exposes evidence coverage; at 22:52 local it reported 159 R1 outbound assigned services. This number is not the count of qualified training labels and does not automatically enable the live predictor.

See [assignment evidence](docs/assignment-evidence.md), [the verified Maçanet 15:48 case](docs/hospitalet-2026-09-28.md), and [verification](docs/verification.md). Passenger-facing continuity and inconsistent-delay protection are implemented and passed tests; see verification for actual publication status. The historical predictor and experimental ML promotion policy remain unchanged.

The 29 September follow-up audit is implemented locally and will be published only after the complete test/build/restart/deploy verification. It covers overdue fresh arrivals, sequence-only Renfe updates, independent platform/timing freshness, invalidated incident dialogs, and automatic GTFS refresh. Do not describe the audit as complete until `origin/main`, the watchdog API, and Firebase assets have been rechecked.
The 29 September follow-up audit is published as commit `ab7cc41` and deployed to Firebase. It covers overdue fresh arrivals, sequence-only Renfe updates, independent platform/timing freshness, invalidated incident dialogs, and automatic GTFS refresh. Public verification succeeded; future work should still treat source data as evidence rather than a guarantee of physical announcements.
