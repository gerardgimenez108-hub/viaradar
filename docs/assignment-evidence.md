# Preserve platform assignments without inventing confirmations

The collector now has a separate assignment-event stream. It records vehicles at configured stations even when they are moving, when a platform changes, and when a later message omits the platform. It is independent of the passenger board's time window, row limit and exclusion of terminating arrivals.

## Evidence boundaries

| Evidence | Meaning | Not evidence of |
| --- | --- | --- |
| Fresh platform in a moving-status message | Renfe published an assignment | The physical departure platform |
| Fresh platform in a stopped-status message | Renfe published a platform while reporting the train stopped | Independently verified physical departure |
| Message without a platform | This message omits the assignment | Cancellation or proof the preceding assignment was wrong |
| Recovered snapshot | The retained feed contained that message | A prediction our app made at the time |

The new table does **not** replace `observations` or rewrite `prediction_attempts`. Public historical predictions and the hourly ML experiment's stopped-publication targets remain unchanged. This fixes evidence loss; it does not claim to have validated a replacement R1 predictor.

## Dates and provenance

Keep source vehicle status, source timestamp, feed timestamp, collection timestamp and live/recovered provenance. Missing dates must not silently become today's service date. Date inference from the timetable is explicitly labelled and only accepted when unambiguous; unresolved cases stay available as raw evidence rather than disappearing. Recovery from before the available timetable was imported must not pretend the newer timetable was known then.

Repeated polling is not an independent train. Reports must separate event sightings, identified services, moving assignments, stopped assignments and unknown/invalid evidence. Terminating arrivals are identifiable but not silently included as outbound training labels.

## Operations

The normal 20-second collector owns live capture. `/api/assignments?stationId=72305` exposes read-only aggregate diagnostics. Recover retained snapshots using `scripts/backfill-assignments.ts`: its default is a read-only dry run; applying requires `--apply`. Test against a consistent backup before live recovery. Re-running recovery must not duplicate events, and it must never seed prospective successes.

```powershell
# Read-only preview; defaults to snapshots since the available timetable import.
node --experimental-strip-types scripts/backfill-assignments.ts
# Preview all retained snapshots; older timetable associations remain unresolved.
node --experimental-strip-types scripts/backfill-assignments.ts --since 1970-01-01T00:00:00Z
# Explicit recovery after backup and rehearsal:
node --experimental-strip-types scripts/backfill-assignments.ts --since 1970-01-01T00:00:00Z --apply
```

`--db` and `--static` accept absolute rehearsal paths. The scan fixes its upper snapshot ID at launch and processes bounded batches, so it cannot chase incoming data forever. Empty full feeds are valid; malformed snapshots are counted and skipped without stopping valid recovery. Apply uses WAL; existing history/evaluation tables are not rewritten.

Metrics separate `outboundAssignedServices` from `terminalAssignedServices`. `missingAfterAssignmentEvents` means only that a fresh message lacked a platform after an assigned one; it does not assert that Renfe cancelled the assignment. Events with missing identity or stale/future timestamps remain diagnostics, not valid independent services. Retention is 90 days for this extracted evidence.

The retained raw feed is finite. Recovery cannot reconstruct snapshots already removed by retention or messages Renfe never published. Keep backups outside Git; do not store the live database or feed bodies in the repository.

## Next model decision

Assess assignment stability, withdrawals/missing follow-up, timestamp quality and later stopped evidence by line/destination. If an assignment-based model is evaluated later, give it a new outcome policy and compare it separately. Do not mix its results with stopped-publication accuracy or relax the existing thresholds just to make the board display a guess.

## Passenger-facing continuity

A fresh same-service vehicle still targeting the station can expose an additive `lastPublishedPlatform` with value, original observation time and expiry. This is separate from `platform.kind`; the UI displays it neutrally as last published, currently unconfirmed, ahead of a historical estimate. It is limited to 15 minutes from the publication and 90 seconds from current vehicle evidence, whichever expires first. It requires the same vehicle identity and resolved service date, and disappears on cancellation, downstream movement, missing/stale source, or expiry. New official evidence takes precedence.

Retained evidence never creates an official training label. Measurement marks it as a previously known publication, preventing a later artificial prediction attempt. The module can be removed together with its additive field, UI and tests without removing captured history; restore the previous measurement condition only when removing this display feature entirely.
