import { saveSnapshot } from "./store.ts";
import type { Feed, SourceStatus } from "./model.ts";
export const MAX_AGE = 90;
export const sources = new Map<
  string,
  { feed: Feed | null; status: SourceStatus }
>();
for (const kind of ["vehicle_positions", "trip_updates"])
  sources.set(kind, {
    feed: null,
    status: {
      kind,
      url: `https://gtfsrt.renfe.com/${kind}.json`,
      fetchedAt: null,
      feedTimestamp: null,
      ageSeconds: null,
      healthy: false,
      error: "Waiting for first collection",
    },
  });
export function isFresh(timestamp: unknown, now = Date.now()): boolean {
  if (typeof timestamp !== "number" && typeof timestamp !== "string")
    return false;
  const age = now / 1000 - Number(timestamp);
  return Number.isFinite(age) && age >= -30 && age <= MAX_AGE;
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function numeric(value: unknown): boolean {
  return (
    (typeof value === "number" ||
      (typeof value === "string" && value.trim() !== "")) &&
    Number.isFinite(Number(value))
  );
}
function validDescriptor(value: unknown): boolean {
  if (value === undefined) return true;
  return (
    record(value) &&
    ["tripId", "startDate", "startTime"].every(
      (key) => value[key] === undefined || typeof value[key] === "string",
    )
  );
}
function validEvent(value: unknown): boolean {
  return (
    value === undefined ||
    (record(value) &&
      (value.time === undefined || numeric(value.time)) &&
      (value.delay === undefined ||
        (typeof value.delay === "number" && Number.isFinite(value.delay))))
  );
}
export function parseFeed(body: string): Feed {
  const value: unknown = JSON.parse(body);
  if (
    !record(value) ||
    !record(value.header) ||
    !numeric(value.header.timestamp) ||
    Number(value.header.timestamp) <= 0 ||
    Number(value.header.timestamp) > 8640000000000 ||
    value.header.incrementality === "DIFFERENTIAL" ||
    value.header.incrementality === 1
  ) {
    throw new Error("Invalid or unsupported realtime feed header");
  }
  const entities = value.entity ?? [];
  if (!Array.isArray(entities)) throw new Error("Invalid realtime entities");
  for (const entity of entities) {
    if (!record(entity)) throw new Error("Invalid realtime entity");
    if (entity.vehicle !== undefined) {
      const vehicle = entity.vehicle;
      if (
        !record(vehicle) ||
        !validDescriptor(vehicle.trip) ||
        (vehicle.stopId !== undefined && typeof vehicle.stopId !== "string") ||
        (vehicle.timestamp !== undefined && !numeric(vehicle.timestamp)) ||
        (vehicle.vehicle !== undefined &&
          (!record(vehicle.vehicle) ||
            (vehicle.vehicle.label !== undefined &&
              typeof vehicle.vehicle.label !== "string")))
      ) {
        throw new Error("Invalid vehicle position");
      }
    }
    if (entity.tripUpdate !== undefined) {
      const update = entity.tripUpdate;
      if (
        !record(update) ||
        !validDescriptor(update.trip) ||
        (update.timestamp !== undefined && !numeric(update.timestamp)) ||
        (update.delay !== undefined &&
          (typeof update.delay !== "number" ||
            !Number.isFinite(update.delay))) ||
        (update.stopTimeUpdate !== undefined &&
          !Array.isArray(update.stopTimeUpdate))
      ) {
        throw new Error("Invalid trip update");
      }
      for (const stop of (update.stopTimeUpdate ?? []) as unknown[]) {
        if (
          !record(stop) ||
          (stop.stopId !== undefined && typeof stop.stopId !== "string") ||
          (stop.stopSequence !== undefined && !numeric(stop.stopSequence)) ||
          !validEvent(stop.arrival) ||
          !validEvent(stop.departure)
        ) {
          throw new Error("Invalid stop-time update");
        }
      }
    }
  }
  return { header: value.header, entity: entities } as Feed;
}
export async function collect(): Promise<void> {
  await Promise.all(
    [...sources].map(async ([kind, source]) => {
      try {
        const response = await fetch(source.status.url, {
          signal: AbortSignal.timeout(15000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = await response.text();
        const feed = parseFeed(body);
        const now = Date.now();
        saveSnapshot(kind, body, Number(feed.header.timestamp) * 1000, now);
        source.feed = feed;
        source.status = {
          ...source.status,
          fetchedAt: new Date(now).toISOString(),
          feedTimestamp: new Date(
            Number(feed.header.timestamp) * 1000,
          ).toISOString(),
          healthy: isFresh(feed.header.timestamp, now),
          error: isFresh(feed.header.timestamp, now)
            ? null
            : "Upstream timestamp is stale",
        };
      } catch (error) {
        source.status = {
          ...source.status,
          healthy: false,
          error: error instanceof Error ? error.message : "Feed unavailable",
        };
      }
    }),
  );
}
export function sourceStatus(now = Date.now()): SourceStatus[] {
  return [...sources.values()].map(({ status, feed }) => ({
    ...status,
    healthy: status.healthy && isFresh(feed?.header.timestamp, now),
    ageSeconds: feed
      ? Math.max(0, Math.round(now / 1000 - Number(feed.header.timestamp)))
      : null,
  }));
}
export function liveFeed(kind: string, now: number): Feed | null {
  const source = sources.get(kind);
  return source?.status.healthy && isFresh(source.feed?.header.timestamp, now)
    ? source.feed
    : null;
}
