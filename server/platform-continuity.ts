import type { DatabaseSync } from "node:sqlite";
import type { LastPublishedPlatform, Vehicle } from "./model.ts";

const RETENTION_MS = 15 * 60000;
/** Context only: never an official label, training target or confirmed departure. */
export function lastPublishedPlatform(db: DatabaseSync, vehicle: Vehicle, stationId: string,
  serviceDate: string, uniqueDate: boolean, now: number): LastPublishedPlatform | undefined {
  const observedAt = Number(vehicle.timestamp) * 1000;
  if (!vehicle.trip?.tripId || !vehicle.vehicle?.id || vehicle.stopId !== stationId ||
      !Number.isFinite(observedAt) || observedAt > now || now - observedAt > 90000 ||
      (vehicle.trip.startDate ? vehicle.trip.startDate !== serviceDate : !uniqueDate) ||
      vehicle.vehicle.label?.includes("PLATF") ||
      !["STOPPED_AT", "INCOMING_AT", "IN_TRANSIT_TO", 0, 1, 2].includes(vehicle.currentStatus ?? "")) return;
  const evidence = db.prepare(`SELECT platform, observed_at FROM assignment_events
    WHERE station_id=? AND service_date=? AND trip_id=? AND vehicle_id=?
      AND freshness='fresh' AND date_origin IN ('explicit','inferred_unique_schedule_6h')
      AND platform IS NOT NULL AND observed_at>? AND observed_at<=?
      AND fetched_at<=? AND feed_timestamp<=fetched_at
    ORDER BY observed_at DESC, fetched_at DESC LIMIT 1`).get(
      stationId, serviceDate, vehicle.trip.tripId, vehicle.vehicle.id, now - RETENTION_MS, observedAt, now,
    ) as { platform: string; observed_at: number } | undefined;
  if (!evidence) return;
  return { value: evidence.platform, observedAt: new Date(evidence.observed_at).toISOString(),
    expiresAt: new Date(Math.min(evidence.observed_at + RETENTION_MS, observedAt + 90000)).toISOString() };
}
