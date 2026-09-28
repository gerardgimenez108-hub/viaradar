import type { Row, StopUpdate, TripUpdate } from "./model.ts";
import { gtfsTime } from "./time.ts";

export const TIMING_REJECTION = {
  CONTRADICTORY_EVENT: "contradictory_event_time_and_delay",
} as const;

export interface GenericDelayResult {
  delay: number | undefined;
  rejection?: typeof TIMING_REJECTION[keyof typeof TIMING_REJECTION];
}

function uniqueScheduledStop(update: StopUpdate, stops: readonly Row[]): Row | undefined {
  if (update.stopSequence === undefined && !update.stopId) return undefined;
  const matches = stops.filter((stop) =>
    (update.stopSequence === undefined || Number(stop.stop_sequence) === update.stopSequence) &&
    (!update.stopId || stop.stop_id === update.stopId),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

/** Validate only the generic fallback; explicit station event times keep precedence.
 * The caller supplies a fresh, same-service update and that trip's static stop times.
 * A contradictory event makes the trip delay unsafe to extrapolate to other stops.
 * Ambiguous/unknown stops cannot establish a contradiction. No delay size cap applies.
 */
export function reliableGenericDelay(
  update: TripUpdate | undefined,
  tripStops: readonly Row[],
  serviceDate: string,
): GenericDelayResult {
  const delay = update?.delay;
  if (delay === undefined || !Number.isFinite(delay)) return { delay: undefined };
  if (update?.trip?.startDate && update.trip.startDate !== serviceDate)
    return { delay: undefined };
  const stops = update?.trip?.tripId
    ? tripStops.filter((stop) => stop.trip_id === update.trip!.tripId)
    : tripStops;
  for (const stopUpdate of update?.stopTimeUpdate ?? []) {
    // Changed service patterns do not provide a comparable scheduled event.
    if (stopUpdate.scheduleRelationship !== undefined &&
        stopUpdate.scheduleRelationship !== "SCHEDULED" &&
        stopUpdate.scheduleRelationship !== 0) continue;
    const stop = uniqueScheduledStop(stopUpdate, stops);
    if (!stop) continue;
    for (const [event, schedule] of [
      [stopUpdate.arrival, stop.arrival_time],
      [stopUpdate.departure, stop.departure_time],
    ] as const) {
      if (event?.time === undefined || event.delay === undefined || !schedule) continue;
      const absolute = Number(event.time);
      const scheduled = gtfsTime(serviceDate, schedule) / 1000;
      if (!Number.isFinite(absolute) || !Number.isFinite(event.delay) ||
          !Number.isFinite(scheduled)) continue;
      // GTFS-RT: when time and delay coexist, time takes precedence.
      // https://gtfs.org/documentation/realtime/reference/#stoptimeevent
      if (absolute !== scheduled + event.delay)
        return { delay: undefined, rejection: TIMING_REJECTION.CONTRADICTORY_EVENT };
    }
  }
  return { delay };
}
