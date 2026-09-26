# Prediction measurement and improvement plan

**Phase 1 measures the existing model; it does not make it more accurate by itself.** Collect prospective evidence, then decide whether a replacement improves useful predictions.

## Read the report

With the updated API running:

```powershell
Invoke-RestMethod 'http://127.0.0.1:8787/api/predictions?stationId=72305' |
  ConvertTo-Json -Depth 8
```

The read-only endpoint is also available through the public API. An unconfigured station returns 404. No passenger-facing prediction dashboard is added in this phase.

Empty `engines: []` is expected before the first eligible attempt. `publishedPlatformAgreement: null` means there are no evaluated predictions: neither 0% nor 100%. Old training observations are **not** retroactively counted as successes.

## Existing model

`server/prediction.ts` implements `historical-frequency-v1`: earlier service dates and observations before evaluation, same station/line/destination, deduplicated by service date/trip/station. It needs 20 services over 3 dates and at least 80% modal share; otherwise it abstains.

It does not yet distinguish hour, weekday/holiday, disruption context or recency weights. `confidence` is historical share, not calibrated probability. The displayed sample count belongs to the **training history**, not the **evaluation cohort**.

## Measurement contract

Implementation: `server/measurement.ts`, initialized through `server/store.ts`, called by the collector tick in `server/index.ts`.

| Question | Phase 1 policy |
| --- | --- |
| When is an attempt recorded? | First eligible collector checkpoint per service/date/station/engine, not on API reads |
| Which services qualify? | In the current three-hour/40-row board; scheduled and expected times both future; not cancelled; vehicle and trip-update sources healthy and timestamped between now minus 90 seconds and now |
| What if a platform was already known? | No new attempt: current official rows, stored training observations and retained official-seen markers block eligibility |
| What is frozen? | Evaluation time, engine, platform or abstention, historical share/sample/reason, station/line/destination, scheduled/expected times and lead seconds |
| Can later polls revise it? | No. Even a later better prediction cannot replace the first abstention |
| What supplies an outcome? | First qualifying later fresh **STOPPED_AT publication** available to measurement through training observations |
| How is time order protected? | Observation timestamp strictly after evaluation, no later than current collection time, and fresh; vehicle source also fresh |
| When does scoring stop? | First label freezes the result; otherwise six hours beyond the original expected time makes it unevaluable |
| What about cancellation? | An unresolved attempt becomes unevaluable when cancellation is seen, not an incorrect prediction |
| Retention? | 90 days for attempts and official-seen markers |

This cohort is not all station trains or every forecast a passenger sees. Downtime, stale feeds, already-known platforms, overdue scheduled times and the board limit exclude services. Official-seen tracking starts with instrumentation, supplemented by existing observations; it cannot reconstruct every older publication. A permanently frozen first abstention may differ from a prediction shown later in the UI.

### Publication is not physical ground truth

The outcome means Renfe published that platform while a vehicle was reported stopped at the station. It does not prove physical departure. That publication may later change. Therefore the metric is **published-platform agreement**, not guaranteed departure accuracy.

`outcomePolicy: first-later-fresh-stopped-at-publication` refers to the first qualifying label seen by this collector, not necessarily the first time Renfe published it. The six-hour label window uses the attempt's original expected time; later delays do not silently extend it.

## Counts and denominators

Response metadata: `stationId`, ISO `generatedAt`, `retentionDays`, `checkpointPolicy`, `outcomePolicy`, `labelWindowHours`, and `engines[]`.

| Engine field | Meaning |
| --- | --- |
| `attempts` | Independent eligible first-checkpoint services, including abstentions |
| `serviceDays` | Distinct service dates represented |
| `predicted` / `abstained` | Attempts with / without a predicted platform |
| `coverage` | `predicted / attempts`; fraction 0–1 |
| `labelled` | Attempts with later labels, including abstentions |
| `evaluatedPredictions` | Predicted attempts with qualifying later labels |
| `correct` / `incorrect` | Predicted platform equals / differs from frozen published platform |
| `publishedPlatformAgreement` | `correct / evaluatedPredictions`; fraction 0–1 or null when no evaluated predictions |
| `pending` | No label yet, still inside the label window |
| `unevaluable` | Unresolved cancellation or expired label window |
| `firstAttemptAt` / `lastAttemptAt` | Unix milliseconds, not ISO strings |

`attempts = predicted + abstained`; `evaluatedPredictions = correct + incorrect`. Pending and unevaluable cases are not successes or mistakes. Missing labels may be biased toward particular lines or conditions, so agreement on a small labelled subset is not a system-wide guarantee.

`predictionStatistics` contains minimum/mean/maximum scheduled/expected lead seconds, minimum/mean/maximum historical sample count, mean historical share, and mean lead seconds to qualifying publication. Statistics use predicted attempts; publication lead uses labelled predictions only. Null means no qualifying data. These are not lead times versus station announcements, which we do not observe.

### Illustrative example — not real results

100 eligible services, 60 predictions and 40 abstentions give 60% coverage. If 30 predictions get later labels and 27 match, agreement is 90% **on those 30**, not 90% of all services. Disclose the pending/unevaluable predictions too.

## Storage and integrity

- `prediction_attempts`: key `(service_date, trip_id, station_id, engine_id)`; immutable attempt fields followed by one resolution/reason.
- `prediction_official_seen`: `(service_date, trip_id, station_id)` prevents a seen publication followed by withdrawal becoming a misleading new advance attempt.
- Existing `observations` remain last-observation-wins training data. Evaluation copies its first qualifying label rather than continuously rescoring against a moving outcome.
- Initialization is additive and idempotent. Existing snapshots and observations remain intact. Collector owns expiry; read-only reports also apply their time window.
- Tests use isolated temporary/in-memory SQLite. Never seed live storage with fake attempts or labels.

## Continue in this order

1. **Collect and inspect.** Check dated reports across operating days: attempts, coverage, labelled fraction, unresolved cases, date diversity and lead time. No predetermined sample count guarantees reliability.
2. **Audit evidence.** Inspect mismatches and changed/late/missing labels. Decide whether first-opportunity evaluation matches passenger needs or add explicit 30/10/5-minute checkpoints under a new policy version. Do not rewrite the old cohort.
3. **Try a richer baseline in shadow mode.** Time band, weekday/holiday, recent history, and verified delay/disruption context are candidates, not implemented features. Small groups need fallback and abstention; extra features are not automatically better.
4. **Compare on later days.** Fix settings on development days, then test on untouched future service dates with identical eligibility/outcomes and lead horizons. Keep v1 as baseline. Report coverage, label availability and uncertainty alongside agreement; promote only after demonstrated improvement.
5. **Optional adapters.** Assess XGBoost/LightGBM or Jev only with explicit access/cost/latency/fallback and local performance checks. Calibration/Brier metrics are later work. No model promises perfect predictions.

## Activation, verification and rollback

Tests cover deduplication, abstention, strict timestamp order, stale/future evidence, official withdrawal, unresolved/cancelled cases, retention, additive initialization and read-only reports. See [verification](verification.md) for actual execution results.

Restart the tested Node backend to activate collection. A Firebase deployment cannot activate backend changes. API smoke checks should verify the new route, station filtering and no-store/CORS without breaking health or departures.

To disable measurement, remove its collector call and restart. To roll back the work unit, revert measurement integration/tests/docs. Do not delete railway history; additive unused tables can remain safely. Back up before deliberate schema cleanup.
