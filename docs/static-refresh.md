# Automatic timetable refresh

The backend refreshes the scoped Renfe GTFS timetable when it is missing, older than 24 hours, or fails its coverage check. A successful candidate must contain the configured station, referenced trips/routes/stops, valid times, calendar or calendar-date service, and active service for today and tomorrow. It is parsed into a temporary file, validated again after serialization, and atomically renamed only after all checks pass.

The running process adopts a verified timetable without a restart. Failed or incomplete downloads retain the last-known-good file and retry no more than hourly. `/api/health` exposes `timetable.importedAt`, `validThrough`, `stale`, `refreshing`, `lastAttemptAt`, and `lastError`; `ok` is false when no usable timetable is available. Realtime collection remains on its 20-second cadence.

This does not claim that the timetable publisher updates continuously or that an accepted static schedule proves a train's physical movement. It only prevents the application from silently running an expired static calendar.
