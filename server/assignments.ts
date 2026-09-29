import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { DateTime } from "luxon";
import type { Feed, Row } from "./model.ts";
import type { StaticData } from "./static.ts";
import { activeService, gtfsTime, serviceDays } from "./time.ts";

export const PROVENANCE = { LIVE: "live", BACKFILL: "backfill" } as const;
export type Provenance = typeof PROVENANCE[keyof typeof PROVENANCE];
export interface AssignmentEvent {
  id: string; stationId: string; tripId: string | null; vehicleId: string | null;
  serviceDate: string | null; rawStartDate: string | null; dateOrigin: string;
  fetchedAt: number; feedTimestamp: number | null; observedAt: number | null;
  rawStatus: string | null; platform: string | null; rawLabel: string | null;
  line: string | null; destination: string | null; terminal: number | null;
  freshness: string; provenance: Provenance;
}
export function initializeAssignments(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS assignment_events (
    id TEXT PRIMARY KEY, station_id TEXT NOT NULL, trip_id TEXT, vehicle_id TEXT,
    service_date TEXT, raw_start_date TEXT, date_origin TEXT NOT NULL,
    fetched_at INTEGER NOT NULL, feed_timestamp INTEGER, observed_at INTEGER,
    raw_status TEXT, platform TEXT, raw_label TEXT, line TEXT, destination TEXT,
    terminal INTEGER, freshness TEXT NOT NULL, provenance TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS assignment_events_station_time ON assignment_events(station_id,fetched_at);
    CREATE INDEX IF NOT EXISTS assignment_events_service_vehicle_time
      ON assignment_events(station_id,service_date,trip_id,vehicle_id,observed_at DESC);
    CREATE TABLE IF NOT EXISTS assignment_service_context (
      station_id TEXT NOT NULL, service_date TEXT NOT NULL, trip_id TEXT NOT NULL,
      scheduled_at INTEGER NOT NULL, captured_at INTEGER NOT NULL,
      static_imported_at TEXT NOT NULL, line TEXT, destination TEXT, terminal INTEGER,
      PRIMARY KEY(station_id,service_date,trip_id));
    CREATE INDEX IF NOT EXISTS assignment_service_context_capture ON assignment_service_context(captured_at);`);
}
function indexStatic(data: StaticData) {
  const stops = new Map<string, Row[]>();
  for (const row of data.stopTimes) { const rows = stops.get(row.trip_id) ?? []; rows.push(row); stops.set(row.trip_id, rows); }
  return { stops, scheduleTimes: new Map<string, number[]>(), trips: new Map(data.trips.map(r => [r.trip_id, r])), routes: new Map(data.routes.map(r => [r.route_id, r])),
    calendar: new Map(data.calendar.map(r => [r.service_id, r])), exceptions: new Map(data.exceptions.map(r => [`${r.service_id}:${r.date}`, r.exception_type])) };
}
const indices = new WeakMap<StaticData, ReturnType<typeof indexStatic>>();
function milliseconds(value: unknown): number | null {
  if ((typeof value !== "string" && typeof value !== "number") || String(value).trim() === "") return null;
  const n = Number(value) * 1000;
  return Number.isFinite(n) && n > 0 && n <= 8640000000000000 ? n : null;
}
function validDate(value: string): boolean {
  return /^\d{8}$/.test(value) && DateTime.fromFormat(value, "yyyyLLdd", { zone: "Europe/Madrid" }).toFormat("yyyyLLdd") === value;
}
export function extractAssignments(feed: Feed, data: StaticData | null, stationIds: readonly string[], fetchedAt: number, provenance: Provenance): AssignmentEvent[] {
  let index = data ? indices.get(data) : undefined;
  if (data && !index) { index = indexStatic(data); indices.set(data, index); }
  const feedTimestamp = milliseconds(feed.header.timestamp);
  const datesByTimestamp = new Map<number, string[]>();
  return feed.entity.flatMap(entity => {
    const vehicle = entity.vehicle;
    if (!vehicle?.stopId || !stationIds.includes(vehicle.stopId)) return [];
    const tripId = vehicle.trip?.tripId || null;
    const rawStartDate = vehicle.trip?.startDate ?? null;
    const observedAt = milliseconds(vehicle.timestamp);
    const rawStatus = vehicle.currentStatus === undefined ? null : String(vehicle.currentStatus);
    const rawLabel = vehicle.vehicle?.label ?? null;
    const platform = rawLabel?.match(/PLATF\.\((\d+[A-Za-z]?)\)/)?.[1] ?? null;
    const vehicleId = vehicle.vehicle?.id ?? entity.id ?? null;
    let freshness = !feedTimestamp || !observedAt ? "malformed_timestamp" :
      feedTimestamp > fetchedAt || observedAt > fetchedAt ? "future" :
      fetchedAt - feedTimestamp > 90000 || fetchedAt - observedAt > 90000 ? "stale" : "fresh";
    if (rawLabel?.includes("PLATF") && !platform) freshness = "malformed_platform";
    let serviceDate: string | null = rawStartDate && validDate(rawStartDate) ? rawStartDate : null;
    let dateOrigin = serviceDate ? "explicit" : rawStartDate ? "invalid_explicit" : "unresolved";
    const currentStatic = !!data && fetchedAt >= Date.parse(data.importedAt);
    const trip = currentStatic && tripId ? index?.trips.get(tripId) : undefined;
    const stops = tripId && currentStatic ? index?.stops.get(tripId) ?? [] : [];
    const stationStops = stops.filter(s => s.stop_id === vehicle.stopId);
    if (!rawStartDate && observedAt && trip && index) {
      let candidateDates = datesByTimestamp.get(observedAt);
      if (!candidateDates) { candidateDates = serviceDays(observedAt); datesByTimestamp.set(observedAt, candidateDates); }
      const dates = candidateDates.filter(date => {
        const key = JSON.stringify([tripId, vehicle.stopId, date]);
        let times = index.scheduleTimes.get(key);
        if (!times) {
          times = activeService(trip.service_id, date, index.calendar, index.exceptions)
            ? stationStops.map(s => gtfsTime(date, s.departure_time || s.arrival_time)).filter(Number.isFinite) : [];
          if (index.scheduleTimes.size >= 50000) index.scheduleTimes.clear();
          index.scheduleTimes.set(key, times);
        }
        return times.some(time => Math.abs(time - observedAt) <= 6 * 3600000);
      });
      if (dates.length === 1) { serviceDate = dates[0]; dateOrigin = "inferred_unique_schedule_6h"; }
    }
    const terminalStop = stops.reduce<Row | undefined>((last, row) => !last || Number(row.stop_sequence) > Number(last.stop_sequence) ? row : last, undefined);
    const terminal = terminalStop && stationStops.length ? Number(terminalStop.stop_id === vehicle.stopId) : null;
    const id = createHash("sha256").update(JSON.stringify([vehicle.stopId, tripId, rawStartDate, vehicleId, vehicle.timestamp ?? null, rawStatus, rawLabel,
      observedAt === null ? feed.header.timestamp ?? null : null])).digest("hex");
    return [{ id, stationId: vehicle.stopId, tripId, vehicleId, rawStartDate, serviceDate, dateOrigin,
      fetchedAt, feedTimestamp, observedAt, rawStatus, rawLabel, platform, line: trip ? index?.routes.get(trip.route_id)?.route_short_name ?? null : null,
      destination: trip ? trip.trip_headsign || data?.stops.find(s => s.stop_id === terminalStop?.stop_id)?.stop_name || null : null, terminal, freshness, provenance }];
  });
}
export function saveAssignments(db: DatabaseSync, events: readonly AssignmentEvent[]): number {
  const insert = db.prepare(`INSERT OR IGNORE INTO assignment_events VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  let inserted = 0;
  db.exec("BEGIN");
  try {
    for (const e of events) inserted += Number(insert.run(e.id, e.stationId, e.tripId, e.vehicleId, e.serviceDate, e.rawStartDate, e.dateOrigin,
      e.fetchedAt, e.feedTimestamp, e.observedAt, e.rawStatus, e.platform, e.rawLabel, e.line, e.destination, e.terminal, e.freshness, e.provenance).changes);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  return inserted;
}
export function captureAssignments(db: DatabaseSync, feed: Feed, data: StaticData | null, stationIds: readonly string[], fetchedAt: number, provenance: Provenance = PROVENANCE.LIVE): number {
  const events = extractAssignments(feed, data, stationIds, fetchedAt, provenance);
  const inserted = saveAssignments(db, events);
  saveServiceContexts(db, events, data);
  db.prepare("DELETE FROM assignment_events WHERE fetched_at < ?").run(fetchedAt - 90 * 86400000);
  db.prepare("DELETE FROM assignment_service_context WHERE captured_at < ?").run(fetchedAt - 90 * 86400000);
  return inserted;
}
function saveServiceContexts(db: DatabaseSync, events: readonly AssignmentEvent[], data: StaticData | null): void {
  if (!data || !Number.isFinite(Date.parse(data.importedAt))) return;
  const index = indices.get(data);
  if (!index) return;
  const insert = db.prepare(`INSERT OR IGNORE INTO assignment_service_context
    (station_id,service_date,trip_id,scheduled_at,captured_at,static_imported_at,line,destination,terminal)
    VALUES(?,?,?,?,?,?,?,?,?)`);
  db.exec("BEGIN");
  try {
    for (const event of events) {
      // Freeze only prospective live context: today's timetable cannot reconstruct old snapshots.
      if (event.provenance !== PROVENANCE.LIVE || event.freshness !== "fresh" ||
          !event.tripId || !event.serviceDate || !Number.isFinite(event.fetchedAt) ||
          event.fetchedAt < Date.parse(data.importedAt)) continue;
      const trip = index.trips.get(event.tripId);
      const stops = index.stops.get(event.tripId)?.filter(stop => stop.stop_id === event.stationId) ?? [];
      if (!trip || stops.length !== 1 || !stops[0].departure_time ||
          !activeService(trip.service_id, event.serviceDate, index.calendar, index.exceptions)) continue;
      const scheduledAt = gtfsTime(event.serviceDate, stops[0].departure_time);
      if (!Number.isFinite(scheduledAt)) continue;
      insert.run(event.stationId, event.serviceDate, event.tripId, scheduledAt, event.fetchedAt,
        data.importedAt, event.line, event.destination, event.terminal);
    }
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
export function assignmentMetrics(db: DatabaseSync, stationId: string, now = Date.now()) {
  const rows = db.prepare(`WITH events AS (
    SELECT *, lag(CASE WHEN freshness='fresh' THEN platform END) OVER (PARTITION BY service_date,trip_id,station_id,vehicle_id ORDER BY observed_at,fetched_at,id) previous_platform
    FROM assignment_events WHERE station_id=? AND fetched_at>=? AND fetched_at<=?
  ) SELECT coalesce(line,'unknown') line, count(*) events,
    count(DISTINCT CASE WHEN service_date IS NOT NULL AND trip_id IS NOT NULL AND freshness='fresh' THEN service_date || ':' || trip_id END) observedServices,
    count(DISTINCT CASE WHEN service_date IS NOT NULL AND trip_id IS NOT NULL AND freshness='fresh' AND platform IS NOT NULL THEN service_date || ':' || trip_id END) assignedServices,
    count(DISTINCT CASE WHEN service_date IS NOT NULL AND trip_id IS NOT NULL AND freshness='fresh' AND platform IS NOT NULL AND terminal=0 THEN service_date || ':' || trip_id END) outboundAssignedServices,
    count(DISTINCT CASE WHEN service_date IS NOT NULL AND trip_id IS NOT NULL AND freshness='fresh' AND platform IS NOT NULL AND terminal=1 THEN service_date || ':' || trip_id END) terminalAssignedServices,
    count(DISTINCT CASE WHEN service_date IS NOT NULL AND trip_id IS NOT NULL AND freshness='fresh' AND platform IS NOT NULL AND raw_status IN ('STOPPED_AT','1') THEN service_date || ':' || trip_id END) stoppedAssignedServices,
    count(DISTINCT CASE WHEN service_date IS NOT NULL AND trip_id IS NOT NULL AND freshness='fresh' AND platform IS NOT NULL AND raw_status IN ('INCOMING_AT','IN_TRANSIT_TO','0','2') THEN service_date || ':' || trip_id END) movingAssignedServices,
    sum(CASE WHEN freshness='fresh' AND platform IS NOT NULL THEN 1 ELSE 0 END) assignedEvents,
    sum(CASE WHEN freshness='fresh' AND platform IS NOT NULL AND raw_status IN ('STOPPED_AT','1') THEN 1 ELSE 0 END) stoppedAssignedEvents,
    sum(CASE WHEN freshness='fresh' AND platform IS NOT NULL AND raw_status IN ('INCOMING_AT','IN_TRANSIT_TO','0','2') THEN 1 ELSE 0 END) movingAssignedEvents,
    sum(CASE WHEN freshness='fresh' AND platform IS NULL AND previous_platform IS NOT NULL AND service_date IS NOT NULL AND trip_id IS NOT NULL THEN 1 ELSE 0 END) missingAfterAssignmentEvents,
    sum(CASE WHEN service_date IS NULL OR trip_id IS NULL THEN 1 ELSE 0 END) unidentifiedEvents,
    sum(CASE WHEN freshness!='fresh' THEN 1 ELSE 0 END) diagnosticEvents,
    sum(CASE WHEN terminal=1 THEN 1 ELSE 0 END) terminalEvents,
    sum(CASE WHEN provenance='backfill' THEN 1 ELSE 0 END) recoveredEvents
    FROM events GROUP BY coalesce(line,'unknown') ORDER BY line`).all(stationId, now - 90 * 86400000, now);
  return { stationId, generatedAt: new Date(now).toISOString(), retentionDays: 90,
    evidencePolicy: "published-assignments-not-confirmed-departures", dateInferenceWindowHours: 6,
    publicPredictorUsesAssignments: false, lines: rows };
}
