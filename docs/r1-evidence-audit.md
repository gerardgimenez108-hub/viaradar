# Why R1 currently abstains

Audit: **27 September 2026, 23:20 Europe/Madrid**. No line-specific exclusion or threshold defect was found. The current evidence policy leaves R1 with too few qualifying labels. This is a real coverage limitation, not a promise that every part of the system is faultless.

## Stored evidence

Read-only SQLite inspection found **5 R1 observations**, compared with **288 R4 observations**. R1 groups were Blanes (1 service, 1 date), Mataró (2 services, 2 dates), and Maçanet-Massanes (2 services, 2 dates). The live baseline requires at least 20 earlier independent services over 3 earlier dates **per station, line and destination**, then at least 80% modal share. No R1 group qualifies even before excluding today's rows.

Today's prospective cohort contained R1: 69 attempts, 0 predictions, 0 later qualifying labels; R4: 106 attempts, 90 predictions, 89 later labels. These are dated counts, not fixed system totals. All R1 abstentions had `insufficient_history`.

## Renfe does publish some R1 assignments

A bounded scan of 3,229 retained vehicle-position snapshots from 05:00 to about 23:20 local time found:

| R1 evidence at station 72305 | Snapshot entities | Distinct trip IDs |
| --- | ---: | ---: |
| Nonterminal service, platform present, moving | 118 | 51 |
| Nonterminal service, stopped, no platform | 383 | 25 |
| Nonterminal service, stopped with platform | 0 | 0 |
| Terminating service, stopped with platform | 83 | 43 |

Moving means `IN_TRANSIT_TO` or `INCOMING_AT`; stopped means `STOPPED_AT` (numeric 1 is also recognized by the application). The training and measurement policy requires a fresh official platform and stopped status simultaneously. Terminating arrivals are deliberately not departures from this station.

These raw snapshot counts contain repeated sightings, not independent training examples, and do not independently establish departure-platform truth. Do not conclude that Renfe never supplies R1 platforms. The inspected feed supplies assignments but lacks the particular combination needed for outbound training labels.

## Reproduce the bounded inspection

Open SQLite with `mode=ro`. Select `snapshots` where `kind='vehicle_positions'` and `fetched_at >= 1790478000000`. Parse vehicle entities, join `trip.tripId` to static trips/routes and require route short name R1 and `stopId='72305'`. Use the highest numeric stop sequence to identify whether the trip terminates at 72305. Count `PLATF.` in the vehicle label by status and terminal/nonterminal category. Count distinct trips separately from entity sightings. The snapshot retention window is finite, so later reproduction requires an archived database snapshot.

## Capture correction — 28 September

The separate [assignment-event stream](assignment-evidence.md) now preserves moving publications, missing-platform messages and stopped publications outside the departure-board filters. Retained snapshots can be recovered explicitly and idempotently, with provenance and unresolved dates preserved. See [verification](verification.md) for activation and measured recovery counts.

## Next model work — not implemented

Keep existing thresholds and the stopped-publication evaluation cohort unchanged. Use the separate **published assignment** stream to measure stability and later confirmation/missing confirmation before deciding whether it can train an R1 candidate. Never silently relabel this evidence as a confirmed physical departure or mix it into the current outcome cohort.

CatBoost and River cannot repair missing trustworthy labels merely by being more sophisticated. Their automatic reports consume the current cohort; they do not remove this R1 limitation.
