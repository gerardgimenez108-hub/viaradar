# Hospitalet platform omission — 28 September 2026

Renfe published a platform before arrival and later omitted it. Absence in the latest message did not establish that no platform had ever been published. Collection previously required the platform and `STOPPED_AT` together, losing useful R1 assignment evidence.

## Evidence

All times below are Europe/Madrid (CEST). A bounded read-only audit inspected retained vehicle/trip snapshots between 15:20 and 16:20. Feed statuses are not independently verified physical movements.

| Service | Recorded source evidence |
| --- | --- |
| R1 Maçanet-Massanes 15:48, `5169L25651R1` | Target station `72305`, `PLATF.(13)`, `INCOMING_AT` in 45 snapshots received 15:33:26–15:48:07. Then `STOPPED_AT` without a platform in 21 snapshots, 15:48:27–15:55:07. Absent at 15:55:27. |
| R1 Mataró 15:57, `5169L25759R1` | `PLATF.(11)` received 15:42:26–15:57:07. Later stopped messages omitted the platform. |
| Earlier R1 Mataró 15:39, `5169L25757R1` | `PLATF.(11)` received 15:37:06–15:39:06. Later stopped messages omitted the platform. |

The user's screenshot, phone clock 15:55, shows Maçanet 15:48 as **Sin publicar**, Mataró **15:57** as published platform **11**, and an R4 historical estimate. This identifies the displayed Mataró service; it does not prove which physical train departed first or verify station announcements. The user's account separately reports Maçanet physically arriving on track 13 after being announced.

## Separate timing defect

At 15:42:06, the Maçanet trip update carried trip delay `13080` seconds and a Sants arrival event with `delay: 13080` but `time: 1790603640` (15:54, exactly the scheduled Sants arrival). Adjacent snapshots reported zero delay with the same absolute time.

Applying the contradictory generic delay to Hospitalet's 15:48 schedule moved its estimated departure to 19:26, outside the board's three-hour window. This is a reproducible software consequence, not evidence that the user observed the transient disappearance.

The [GTFS Realtime reference](https://gtfs.org/documentation/realtime/reference/#message-stoptimeevent) gives absolute event time precedence over delay. A contradiction guard must compare the same event against its exact static stop, service date and arrival/departure time. It must not cap legitimate large delays or infer current departure time from GPS.

## Evidence boundaries

- Preserve assignments independently of stopped-platform training labels.
- A retained publication is **last published, currently unconfirmed**, not a prediction or a fresh official confirmation.
- Omission is not an explicit withdrawal; neither is it proof that the old assignment remains valid.
- Historical recovery must not fabricate prospective predictions or improve past evaluation scores.
- Do not infer arrival from the GPS coordinates: the inspected incoming messages repeated Sants coordinates while targeting Hospitalet.

## Correction replay

An isolated-database replay at **15:55:10 CEST**, using the actual retained snapshots and current matching static timetable, returned:

- Maçanet `5169L25651R1`: unknown *current* platform plus retained platform **13**, source observation **15:47:46**, current-vehicle freshness expiry **15:56:16**.
- Mataró `5169L25759R1`: fresh official platform **11**, observation **15:54:46**, expiry **15:56:16**.

The replay database was under the Windows temporary directory. It did not write synthetic measurements or replay labels into production. A separate board regression reproduces the contradictory 218-minute update and verifies the Maçanet row remains at its scheduled time, marked **not realtime**, with fresh platform 13; an explicit station absolute time still takes precedence.
