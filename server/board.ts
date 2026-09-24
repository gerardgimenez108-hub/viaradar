import type {
  Board,
  Departure,
  Platform,
  TripDescriptor,
  Vehicle,
  Row,
} from "./model.ts";
import type { StaticData } from "./static.ts";
import { incidentsForStation } from "./incidents.ts";
import { activeService, gtfsTime, serviceDays } from "./time.ts";
import { isFresh, liveFeed, sourceStatus } from "./realtime.ts";
import { db } from "./store.ts";
import {
  historicalEngine,
  unknownPlatform,
  type TrainingObservation,
} from "./prediction.ts";
function buildStaticIndex(data: StaticData) {
  const byStation = new Map<string, Row[]>();
  const byTrip = new Map<string, Row[]>();
  const terminals = new Map<string, Row>();
  for (const row of data.stopTimes) {
    const stationRows = byStation.get(row.stop_id) ?? [];
    stationRows.push(row);
    byStation.set(row.stop_id, stationRows);
    const tripRows = byTrip.get(row.trip_id) ?? [];
    tripRows.push(row);
    byTrip.set(row.trip_id, tripRows);
    if (
      Number(row.stop_sequence) >
      Number(terminals.get(row.trip_id)?.stop_sequence ?? -1)
    ) {
      terminals.set(row.trip_id, row);
    }
  }
  return {
    byStation,
    byTrip,
    terminals,
    calendar: new Map(data.calendar.map((row) => [row.service_id, row])),
    exceptions: new Map(
      data.exceptions.map((row) => [
        `${row.service_id}:${row.date}`,
        row.exception_type,
      ]),
    ),
    trips: new Map(data.trips.map((row) => [row.trip_id, row])),
    routes: new Map(data.routes.map((row) => [row.route_id, row])),
    stops: new Map(data.stops.map((row) => [row.stop_id, row])),
  };
}
const staticIndices = new WeakMap<
  StaticData,
  ReturnType<typeof buildStaticIndex>
>();
export function publishedPlatform(
  vehicle: Vehicle,
  stationId: string,
  serviceDate: string,
  now: number,
  uniqueDate: boolean,
): Platform {
  if (
    vehicle.stopId !== stationId ||
    !isFresh(vehicle.timestamp, now) ||
    (vehicle.trip?.startDate
      ? vehicle.trip.startDate !== serviceDate
      : !uniqueDate)
  )
    return unknownPlatform();
  const value = vehicle.vehicle?.label?.match(/PLATF\.\((\d+[A-Za-z]?)\)/)?.[1];
  return value
    ? {
        kind: "official",
        evidenceCode: "official_vehicle",
        evidenceContext: { stationId, observedAt: new Date(Number(vehicle.timestamp) * 1000).toISOString() },
        expiresAt: new Date(
          Number(vehicle.timestamp) * 1000 + 90000,
        ).toISOString(),
        value,
        confidence: null,
        sampleCount: 0,
        evidence: `Renfe vehicle label at stop ${stationId}; ${new Date(Number(vehicle.timestamp) * 1000).toISOString()}. Recheck station announcements.`,
      }
    : unknownPlatform();
}
export function createBoard(
  data: StaticData | null,
  stationId: string,
  now = Date.now(),
): Board {
  const board: Board = {
    station: {
      id: stationId,
      name:
        data?.stops.find((s) => s.stop_id === stationId)?.stop_name ||
        "L'Hospitalet de Llobregat",
    },
    generatedAt: new Date(now).toISOString(),
    staticImportedAt: data?.importedAt || null,
    sources: sourceStatus(now),
    incidents: incidentsForStation(data, stationId, now),
    departures: [],
    warnings: [],
  };
  if (!data) {
    board.warnings.push(
      "Timetable not imported. Run npm run import:gtfs and restart the server.",
    );
    return board;
  }
  let index = staticIndices.get(data);
  if (!index) {
    index = buildStaticIndex(data);
    staticIndices.set(data, index);
  }
  const {
    calendar,
    exceptions,
    trips,
    routes,
    stops,
    terminals,
    byStation,
    byTrip,
  } = index;
  const vehicleFeed = liveFeed("vehicle_positions", now);
  const updateFeed = liveFeed("trip_updates", now);
  const vehicles = new Map(
    vehicleFeed?.entity
      .filter((e) => e.vehicle?.trip?.tripId)
      .map((e) => [e.vehicle!.trip!.tripId!, e.vehicle!]) || [],
  );
  const updates = new Map(
    updateFeed?.entity
      .filter((e) => e.tripUpdate?.trip?.tripId)
      .map((e) => [e.tripUpdate!.trip!.tripId!, e.tripUpdate!]) || [],
  );
  const historical = db
    .prepare(
      "SELECT service_date as serviceDate, trip_id as tripId, station_id as stationId, line, destination, platform, observed_at as observedAt FROM observations WHERE station_id=?",
    )
    .all(stationId) as unknown as TrainingObservation[];
  for (const stop of byStation.get(stationId) ?? []) {
    if (
      stop.stop_id !== stationId ||
      stop.pickup_type === "1" ||
      stop.stop_sequence === terminals.get(stop.trip_id!)?.stop_sequence
    )
      continue;
    const trip = trips.get(stop.trip_id!);
    if (!trip) continue;
    const dates = serviceDays(now).filter((date) =>
      activeService(trip.service_id!, date, calendar, exceptions),
    );
    for (const date of dates) {
      const scheduled = gtfsTime(
        date,
        stop.departure_time || stop.arrival_time!,
      );
      if (
        !Number.isFinite(scheduled) ||
        scheduled < now - 3600000 ||
        scheduled > now + 4 * 3600000
      )
        continue;
      const line =
        routes.get(trip.route_id!)?.route_short_name || trip.route_id!;
      const destination =
        trip.trip_headsign ||
        stops.get(terminals.get(stop.trip_id!)?.stop_id || "")?.stop_name ||
        "Destination unavailable";
      const uniqueDate =
        dates.filter(
          (d) =>
            Math.abs(
              gtfsTime(d, stop.departure_time || stop.arrival_time!) - now,
            ) <
            4 * 3600000,
        ).length === 1;
      const matches = (descriptor: TripDescriptor | undefined) =>
        descriptor?.startDate ? descriptor.startDate === date : uniqueDate;
      const vehicle = vehicles.get(stop.trip_id!);
      const rawUpdate = updates.get(stop.trip_id!);
      const update =
        rawUpdate &&
        matches(rawUpdate.trip) &&
        (!rawUpdate.timestamp || isFresh(rawUpdate.timestamp, now))
          ? rawUpdate
          : undefined;
      const stopUpdate = update?.stopTimeUpdate?.find(
        (s) =>
          s.stopId === stationId &&
          (!s.stopSequence ||
            Number(s.stopSequence) === Number(stop.stop_sequence)),
      );
      if (
        stopUpdate?.scheduleRelationship === "SKIPPED" ||
        stopUpdate?.scheduleRelationship === 1
      )
        continue;
      const cancelled =
        update?.trip?.scheduleRelationship === "CANCELED" ||
        update?.trip?.scheduleRelationship === 3;
      const vehicleStop =
        vehicle && isFresh(vehicle.timestamp, now) && matches(vehicle.trip)
          ? (byTrip.get(stop.trip_id) ?? []).filter(
              (s) => s.trip_id === stop.trip_id && s.stop_id === vehicle.stopId,
            )
          : [];
      if (
        vehicleStop.length === 1 &&
        Number(vehicleStop[0]!.stop_sequence) > Number(stop.stop_sequence)
      )
        continue;
      const noData =
        stopUpdate?.scheduleRelationship === "NO_DATA" ||
        stopUpdate?.scheduleRelationship === 2;
      const departure = noData || cancelled ? undefined : stopUpdate?.departure;
      const delay =
        noData || cancelled ? undefined : (departure?.delay ?? update?.delay);
      const expected = departure?.time
        ? Number(departure.time) * 1000
        : delay !== undefined
          ? scheduled + delay * 1000
          : scheduled;
      // A timetable cutoff is not evidence that a delayed train has departed.
      // Only fresh, same-service vehicle evidence can keep an overdue row visible.
      const stoppedHere = !cancelled && vehicle?.stopId === stationId &&
        isFresh(vehicle.timestamp, now) && matches(vehicle.trip) &&
        (vehicle.currentStatus === "STOPPED_AT" || vehicle.currentStatus === 1);
      if (
        !Number.isFinite(expected) ||
        (expected < now - 60000 && !stoppedHere) ||
        expected > now + 3 * 3600000
      )
        continue;
      let platform = vehicle
        ? publishedPlatform(vehicle, stationId, date, now, uniqueDate)
        : unknownPlatform();
      if (
        platform.kind === "official" &&
        !cancelled &&
        (vehicle?.currentStatus === "STOPPED_AT" ||
          vehicle?.currentStatus === 1)
      ) {
        db.prepare(
          "INSERT INTO observations VALUES(?,?,?,?,?,?,?) ON CONFLICT(service_date,trip_id,station_id) DO UPDATE SET platform=excluded.platform,observed_at=excluded.observed_at",
        ).run(
          date,
          stop.trip_id!,
          stationId,
          line,
          destination,
          platform.value!,
          Number(vehicle.timestamp) * 1000,
        );
      }
      if (platform.kind !== "official" && !cancelled)
        platform = historicalEngine.predict(
          {
            serviceDate: date,
            tripId: stop.trip_id!,
            stationId,
            line,
            destination,
            now,
          },
          historical,
        );
      if (cancelled) platform = unknownPlatform("Service cancelled", "cancelled");
      const result: Departure = {
        destinationUnavailable: destination === "Destination unavailable",
        tripId: stop.trip_id!,
        serviceDate: date,
        line,
        destination,
        scheduledAt: new Date(scheduled).toISOString(),
        expectedAt: new Date(expected).toISOString(),
        cancelled,
        realtime: !!departure || delay !== undefined,
        platform,
      };
      board.departures.push(result);
    }
  }
  board.departures.sort((a, b) => a.expectedAt.localeCompare(b.expectedAt));
  board.departures = board.departures.slice(0, 40);
  if (board.sources.some((s) => !s.healthy))
    board.warnings.push(
      "Some live sources are unavailable or stale. Timetable times are not live confirmations.",
    );
  if (!board.departures.length)
    board.warnings.push(
      "No departures found in the next three hours. The timetable may be outside its validity range.",
    );
  return board;
}
