# Verification — 27 September 2026

## Latest publication — 23:26 Europe/Madrid

**Commit `029b7d5` is pushed to GitHub `main`, and Firebase Hosting site `viaradar` has been deployed successfully.** Public https://viaradar.web.app returned HTTP 200 and its JS/CSS asset names matched the local build. Browser verification showed connected 20-second polling, R1/R4 trains and the existing historical R4 predictions. There is no UI redesign in this release.

The independent Windows ML task completed successfully with 175 checkpoints/89 later labels over one date; it will evaluate hourly and at sign-in. CatBoost/River are not serving passenger predictions. No Node API restart was required. The deployed frontend and backend worker are separate publication steps.

### Previous measurement release

**Prospective measurement is implemented and active in the local/public PC-backed API. The predictor is unchanged.** This work unit is committed and pushed to GitHub as `800ed85`. It has **not** been deployed to Firebase. The preceding frontend release remains `41d27ef`, deployed to https://viaradar.web.app on 26 September. Backend activation is separate from a frontend release.

## Checks actually executed

### Automatic ML evaluation — 27 September, 23:22 Europe/Madrid

Installed the independent limited-user task **ViaRadar ML Experiments**, running at logon and hourly. Its first scheduled execution completed successfully (Windows result 0) and wrote an atomic report/status: **175 checkpoints, 1 service date, 89 later labels**, `insufficient_data`. The next trigger was 00:22 on 28 September. No live predictor or collector restart was needed.

- Python: **41 tests passed**, including 12 runner tests for overlap, timeout/error preservation, atomic publication, alias protection and bounded history cleanup. Four informational single-label matrix warnings remain.
- Node: **35 tests passed**; strict TypeScript/Vite build passed.
- Browser: **8 tests passed** against the local built app.
- Hosting preflight passed against the public API and configured Firebase origins.
- Firebase CLI identity verified for the configured project; publication results are recorded separately below when complete.
- R1 coverage investigation is documented in [R1 evidence audit](r1-evidence-audit.md). No thresholds or training label definitions were weakened.

Automatic execution does not mean a candidate is now serving users: this is an hourly offline replay/evaluation pipeline, without promotion.

### Isolated ML workspace — later on 27 September

At this earlier checkpoint, the new `ml/` workspace was implemented locally but not yet pushed or deployed. The latest publication above supersedes that release status. It does not replace the live predictor or require a server restart.

| Check | Result |
| --- | --- |
| Isolated Python 3.11 installation / `pip check` | Passed; scikit-learn 1.9.1, CatBoost 1.2.10, River 0.26.1; full pins in `ml/requirements.txt` |
| `python -m pytest ml/tests -q` | **29 passed**; four informational scikit-learn warnings for one-class confusion-matrix test subsets |
| Actual CatBoost fitting / River learning | Passed on isolated synthetic fixtures, including deterministic replay |
| Read-only live experiment | **67 independent checkpoints, 1 service date, 15 later labels**, zero invalid rows and duplicates; correctly returns `insufficient_data` |
| Existing `npm test` / `npm run typecheck` | **35/35 passed** / passed |
| Local health | Timetable loaded, both realtime sources healthy; no backend restart |
| `git diff --check` | Passed; line-ending warnings only |

The live smoke exposed compact GTFS `YYYYMMDD` dates, now normalized and covered by loader tests. Other tests cover delayed label availability, time splits, duplicate services, same-day/nonmonotonic-date abstention, constant features, unseen contexts, missing labels and read-only database/output protection. This is not proof of improved real-world accuracy. Browser tests and Firebase deployment were not rerun for this Python/docs-only change.

### Earlier prospective measurement activation

| Check | Result |
| --- | --- |
| `npm run build` | Passed: strict TypeScript and Vite build |
| `npm test` | **35/35 passed**, including 8 dedicated measurement cases and collector/board integration |
| `npm run test:browser` | **8/8 passed** in headless Edge against the local built app |
| `git diff --check` | Passed before activation; line-ending warnings only |
| Local `/api/health` after restart | `ok: true`, timetable loaded, both realtime sources healthy |
| Public `/api/predictions?stationId=72305` | HTTP200, `Cache-Control: no-store`, CORS allows `https://viaradar.web.app` |
| `/api/predictions?stationId=unknown` | HTTP404 |
| Existing observation count | **204 before and after activation** |
| Initial measurement state | `engines: []`, zero attempts/official markers at 00:57 Europe/Madrid; no eligible overnight trains |

The empty report is expected, not a test failure or an accuracy result. Prospective recording begins with future eligible collection ticks. Existing historical samples are preserved but not re-labelled as predictions made in the past.

## Automated coverage

- Independent service attempts; repeated ticks and metrics reads cannot multiply samples or rewrite the first prediction/abstention.
- Later matching/mismatching stopped-at labels, frozen first resolution, strict same-time/future/stale rejection.
- Previously known/withdrawn publications, overdue services, cancellations, missing labels, eligibility and report time windows.
- Coverage versus agreement denominators, null before evaluated predictions, lead times, sample statistics, station cohorts and day count.
- Additive repeated schema initialization and 90-day retention, without deleting existing observation history.
- Existing schedule calendars/exceptions, midnight/DST, exact-station platform evidence, cancelled/skipped/no-data services, downstream vehicles, feed parsing and Hosting/CORS guards.
- Browser: 320–1440px widths, light/dark mode, 44px main targets, enlarged text, platform states, notices and source text escaping, language/theme persistence, offline shell versus live evidence, and meaningful-change highlighting.

Synthetic test data uses isolated databases or intercepted browser responses, never the live collector database. These checks are ordinary implementation tests; receipt-driven review is disabled/unmanaged.

## Runtime activation and backup

A consistent SQLite online backup was created using Node's SQLite backup API before restarting the verified ViaRadar child process. Its matching static timetable was copied alongside it:

`%LOCALAPPDATA%\ViaRadar\backups\before-measurement-2026-09-26T22-53-48-593Z\`

The existing `ViaRadar Local Server` watchdog observed its child exit and restarted the updated API at **00:56:42 Europe/Madrid**. Its logs record this; no other Node services were stopped. The restarted process initialized the new tables and served the measurement endpoint locally and through Tailscale. A complete backup restoration drill was not performed.

## Not demonstrated by these checks

- Improved prediction accuracy: no replacement model was introduced and no prospective labels existed at activation.
- Physical departure-platform truth, lead time versus station announcements, calibrated probabilities, or a 100% success guarantee.
- Improved real-world candidate performance. Installation and synthetic training now pass in the isolated [ML workspace](ml-experiments.md), but the real prospective dataset still spans only one service date.
- Physical iOS/Android installation, production load, 24/7 uptime, automated timetable refresh, backup restoration, or cloud backend migration.
- Source/platform coverage for every train. Missing data still produces abstention rather than invented evidence.

## Earlier release evidence

The 26 September mobile UI work passed 26 unit tests and 8 browser tests, was pushed as `41d27ef`, and was verified in Firebase with matching JS/CSS assets. Earlier documents incorrectly still described Firebase as un-deployed and Cloudflare as the active tunnel; this work unit corrects those stale runbooks.

## Next acceptance gate

Observe real attempts and later labels across multiple operating dates, inspect coverage and label availability, then use [the measurement plan](predictions.md) to design a time-separated challenger experiment. Keep deployment status and this dated evidence record current when publishing the work unit.

## Assignment capture recovery — 28 September 2026

Independent `assignment_events` collection was activated in the Windows API. A pinned SQLite read-transaction backup and rehearsal copy are retained at `%LOCALAPPDATA%\ViaRadar\backups\assignment-capture-consistent-20260928-190411\`. The earlier zero-byte attempt `before-assignment-capture-20260928-190209` is not a usable backup.

- Rehearsal: 17,172 retained snapshots, zero invalid snapshots after correcting valid header-only feed handling, 21,587 deduplicated events.
- Initial identified fresh outbound assigned services: **153 R1**, **375 R4**. These are assignment-bearing services, not confirmed departures or prediction successes.
- Legacy tables were compared exactly between pristine/rehearsal copies: 341 observations and 398 prediction attempts unchanged. Production merge verified unchanged legacy tables within its transaction; repeating the insert added zero rows.
- Delta recovery added another 1,747 events from 656 snapshots without invalid snapshots.
- Capture work unit checks: **43 Node tests, 41 Python tests, 8 browser tests passed**, TypeScript/Vite build passed. Python emitted four existing single-label metric warnings.
- Verified owned API child restart through the existing watchdog; local health reported both feeds fresh and `/api/assignments` returned recovered aggregates.

The public predictor and ML target policy are unchanged. The retained assignment history is a separate evidence source, not automatic proof of improved prediction accuracy. See [the actual 15:48 case](hospitalet-2026-09-28.md).

## Continuity and timing regression checks — 28 September 2026

Final checks after the passenger-facing fix: **56 Node tests, 41 Python tests, 9 browser tests passed**; TypeScript/Vite production build passed. Browser fixtures covered neutral retained platform13 overriding an unrelated historical estimate, original publication time, no green confirmation flash, expiry and offline removal. Inspected 320px dark and 390px light screenshots, with no horizontal overflow. Actual retained-snapshot replay reproduced Maçanet13/Mataró11; see the [case report](hospitalet-2026-09-28.md).

The additive last-publication field does not alter confirmed training labels, and excludes previously published services from new prediction attempts. The contradictory-delay guard has no arbitrary large-delay cap and preserves explicit station absolute times. Public API `/api/assignments` returned HTTP200, correct Firebase origin CORS and `no-store` before this activation.

Rollback boundary: remove last-publication display/module/optional field and its measurement-known marker together; keep independent captured history. The timing helper and its board fallback can be reverted independently. No prior observations or scores were rewritten by either correction. Receipt-driven review remains disabled/unmanaged.
