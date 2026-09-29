# Assignment stability diagnostic

## Purpose

Investigate why a line has many collected snapshots but little predictable track evidence. This is an **offline, read-only descriptive report**, not a new production predictor or an accuracy benchmark.

From the repository root:

```powershell
node --experimental-strip-types scripts/evaluate-assignments.ts --station 72305
# Reproduce the labels known by a specific receipt-time cutoff:
node --experimental-strip-types scripts/evaluate-assignments.ts --as-of 2026-09-29T15:00:00+02:00
```

Use `--db PATH` for a separate SQLite copy. Default is `data/viaradar.sqlite`. The command never creates tables, changes thresholds, saves reports, promotes models or modifies production predictions. Output contains aggregates, not trip identifiers or the local database path.

## What is counted

- Only fresh, resolved, nonterminal publications with a known line and destination.
- One final **observed publication** per station, service date and trip, available by the receipt-time cutoff. This is not proof of the physically used departure track.
- The newest source timestamp wins; contradictory platforms at the same latest source timestamp are excluded. Conflicting line/destination metadata is also excluded.
- Repeated messages do not increase service counts. Missing platform fields do not cancel an earlier publication.
- `changedServices` counts services with multiple published tracks in the available evidence; this exposes instability rather than hiding it.
- Destination groups show track frequencies, distinct service dates and descriptive sample sufficiency against 20 services / 3 dates / 80% majority share. These are diagnostic reference gates, **not permission to use assignment labels in the existing predictor**.

`majorityShare` is an in-sample distribution, not accuracy or calibrated confidence. `predictionAccuracy` is always `null`. A large sample split across tracks can fail the majority gate forever; collecting for longer is not necessarily the solution.

## Why this is not yet a lead-time benchmark

Assignment events do not preserve an immutable scheduled departure timestamp or a historical timetable version. Using the latest GTFS to reconstruct every old service could silently change historical features. Using first publication time as a prediction feature would also assume information not available before that publication.

Before comparing contextual hour/day models, capture schedule version, scheduled time and feature availability prospectively. For each target at scheduled departure minus 10 minutes, train only on earlier service dates whose outcome was already available before that cutoff; compare against later publications separately from actual departure observations. Report coverage, abstention and agreement by line/destination, and keep physical-departure accuracy unavailable unless independently validated. Do not lower thresholds merely to force R1 predictions.

As of 29 September, live collection also records `assignment_service_context` (see [capture contract](assignment-evidence.md)). This preserves the first known schedule for future services without rewriting historical assignment rows. The diagnostic above remains descriptive; an hour/day candidate and prospective comparison are still pending. A service captured after the desired checkpoint must not be used to pretend its context was available before publication.
