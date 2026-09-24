import test from "node:test";
import assert from "node:assert/strict";
import { gtfsTime, activeService, serviceDays } from "../server/time.ts";
import {
  historicalEngine,
  type TrainingObservation,
} from "../server/prediction.ts";
import { isFresh } from "../server/realtime.ts";
import { publishedPlatform } from "../server/board.ts";
test("GTFS times past midnight use the previous service day", () => {
  assert.equal(
    new Date(gtfsTime("20260922", "25:15:00")).toISOString(),
    "2026-09-22T23:15:00.000Z",
  );
  assert.ok(
    serviceDays(Date.parse("2026-09-22T23:15:00Z")).includes("20260922"),
  );
});
test("Calendar exceptions override regular service", () => {
  const calendar = new Map([
    ["a", { start_date: "20260101", end_date: "20261231", tuesday: "1" }],
  ]);
  assert.equal(activeService("a", "20260922", calendar, new Map()), true);
  assert.equal(
    activeService("a", "20260922", calendar, new Map([["a:20260922", "2"]])),
    false,
  );
  assert.equal(
    activeService("b", "20260922", calendar, new Map([["b:20260922", "1"]])),
    true,
  );
});
test("Stale and future timestamps are not fresh", () => {
  const now = 1790112000000;
  assert.equal(isFresh(now / 1000, now), true);
  assert.equal(isFresh(now / 1000 - 91, now), false);
  assert.equal(isFresh(now / 1000 + 31, now), false);
});
test("Official platform must belong to exact station and service date", () => {
  const now = 1790112000000;
  const vehicle = {
    stopId: "72305",
    timestamp: now / 1000,
    vehicle: { label: "R1-123-PLATF.(14)" },
    trip: { startDate: "20260922" },
  };
  assert.equal(
    publishedPlatform(vehicle, "72305", "20260922", now, true).value,
    "14",
  );
  assert.equal(
    publishedPlatform(vehicle, "71707", "20260922", now, true).kind,
    "unknown",
  );
  assert.equal(
    publishedPlatform(vehicle, "72305", "20260921", now, true).kind,
    "unknown",
  );
  assert.equal(
    publishedPlatform(
      { ...vehicle, timestamp: now / 1000 - 91 },
      "72305",
      "20260922",
      now,
      true,
    ).kind,
    "unknown",
  );
  assert.equal(
    publishedPlatform({ ...vehicle, trip: {} }, "72305", "20260922", now, false)
      .kind,
    "unknown",
  );
});
test("Prediction abstains on cold start and deduplicates snapshots", () => {
  const context = {
    serviceDate: "20260922",
    tripId: "current",
    stationId: "72305",
    line: "R1",
    destination: "Maçanet",
    now: 1790112000000,
  };
  const row: TrainingObservation = {
    ...context,
    serviceDate: "20260920",
    tripId: "previous",
    platform: "14",
    observedAt: context.now - 86400000,
  };
  assert.equal(historicalEngine.predict(context, []).kind, "unknown");
  assert.equal(
    historicalEngine.predict(context, Array(100).fill(row)).kind,
    "unknown",
  );
  const data = Array.from({ length: 24 }, (_, i) => ({
    ...row,
    tripId: `trip${i}`,
    serviceDate: `202609${17 + (i % 3)}`,
  }));
  assert.equal(historicalEngine.predict(context, data).kind, "prediction");
  assert.equal(historicalEngine.predict(context, data).confidence, 1);
  assert.equal(
    historicalEngine.predict(
      context,
      data.map((r) => ({ ...r, serviceDate: "20260922" })),
    ).kind,
    "unknown",
  );
});

test("GTFS DST service-day origin is noon minus twelve hours", () => {
  assert.equal(
    new Date(gtfsTime("20260329", "12:00:00")).toISOString(),
    "2026-03-29T10:00:00.000Z",
  );
  assert.equal(Number.isNaN(gtfsTime("20260922", "12:99:00")), true);
});
