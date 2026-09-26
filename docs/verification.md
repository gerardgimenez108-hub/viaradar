# Verification — 27 September 2026

**Prospective measurement is implemented and active in the local/public PC-backed API. The predictor is unchanged.** This work unit is committed and pushed to GitHub as `800ed85`. It has **not** been deployed to Firebase. The preceding frontend release remains `41d27ef`, deployed to https://viaradar.web.app on 26 September. Backend activation is separate from a frontend release.

## Checks actually executed

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
- GitHub candidate installation, training or performance. [Research](prediction-research.md) is documentary only.
- Physical iOS/Android installation, production load, 24/7 uptime, automated timetable refresh, backup restoration, or cloud backend migration.
- Source/platform coverage for every train. Missing data still produces abstention rather than invented evidence.

## Earlier release evidence

The 26 September mobile UI work passed 26 unit tests and 8 browser tests, was pushed as `41d27ef`, and was verified in Firebase with matching JS/CSS assets. Earlier documents incorrectly still described Firebase as un-deployed and Cloudflare as the active tunnel; this work unit corrects those stale runbooks.

## Next acceptance gate

Observe real attempts and later labels across multiple operating dates, inspect coverage and label availability, then use [the measurement plan](predictions.md) to design a time-separated challenger experiment. Keep deployment status and this dated evidence record current when publishing the work unit.
