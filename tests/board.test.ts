import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StaticData } from "../server/static.ts";
import type { TripUpdate, Vehicle } from "../server/model.ts";
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "viaradar-test-"));
const { createBoard } = await import("../server/board.ts");
const { sources } = await import("../server/realtime.ts");
const now = Date.parse("2026-09-22T10:00:00Z");
const data: StaticData = {
  importedAt: new Date(now).toISOString(),
  stops: [
    { stop_id: "72305", stop_name: "Hospitalet" },
    { stop_id: "end", stop_name: "Destination" },
  ],
  trips: [{ trip_id: "trip", service_id: "service", route_id: "route" }],
  routes: [{ route_id: "route", route_short_name: "R1" }],
  stopTimes: [
    {
      trip_id: "trip",
      stop_id: "72305",
      stop_sequence: "1",
      departure_time: "12:10:00",
    },
    {
      trip_id: "trip",
      stop_id: "end",
      stop_sequence: "2",
      departure_time: "12:20:00",
    },
  ],
  calendar: [
    {
      service_id: "service",
      start_date: "20260922",
      end_date: "20260922",
      tuesday: "1",
    },
  ],
  exceptions: [],
};
function feeds(update?: TripUpdate, vehicle?: Vehicle) {
  for (const [kind, source] of sources) {
    source.status.healthy = true;
    source.feed = {
      header: { timestamp: now / 1000 },
      entity:
        kind === "trip_updates"
          ? update
            ? [{ tripUpdate: update }]
            : []
          : vehicle
            ? [{ vehicle }]
            : [],
    };
  }
}
function board() {
  return createBoard(data, "72305", now).departures;
}
test("Board joins actual final stop destination and excludes terminal visits", () => {
  feeds();
  assert.equal(board()[0]?.destination, "Destination");
  assert.equal(createBoard(data, "end", now).departures.length, 0);
});
test("Cancelled services retain scheduled time and hide platforms", () => {
  feeds({
    trip: {
      tripId: "trip",
      startDate: "20260922",
      scheduleRelationship: "CANCELED",
    },
    delay: 600,
  });
  assert.equal(board()[0]?.cancelled, true);
  assert.equal(board()[0]?.realtime, false);
  assert.equal(board()[0]?.platform.kind, "unknown");
});
test("Skipped station is not a departure", () => {
  feeds({
    trip: { tripId: "trip" },
    stopTimeUpdate: [{ stopId: "72305", scheduleRelationship: "SKIPPED" }],
  });
  assert.equal(board().length, 0);
});
test("NO_DATA blocks trip-level realtime delay at that stop", () => {
  feeds({
    trip: { tripId: "trip" },
    delay: 600,
    stopTimeUpdate: [{ stopId: "72305", scheduleRelationship: "NO_DATA" }],
  });
  assert.equal(board()[0]?.realtime, false);
  assert.equal(board()[0]?.expectedAt, board()[0]?.scheduledAt);
});
test("Fresh downstream vehicle suppresses an already passed departure", () => {
  feeds(undefined, {
    trip: { tripId: "trip" },
    timestamp: now / 1000,
    stopId: "end",
  });
  assert.equal(board().length, 0);
});
test("Mismatching realtime service date cannot cancel today", () => {
  feeds({
    trip: {
      tripId: "trip",
      startDate: "20260921",
      scheduleRelationship: "CANCELED",
    },
  });
  assert.equal(board()[0]?.cancelled, false);
});
test("Calendar cancellation prevents departure even with realtime update", () => {
  feeds({ trip: { tripId: "trip" }, delay: 600 });
  const inactive = {
    ...data,
    exceptions: [
      { service_id: "service", date: "20260922", exception_type: "2" },
    ],
  };
  assert.equal(createBoard(inactive, "72305", now).departures.length, 0);
});
