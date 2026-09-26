import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Board, Departure } from "../server/model.ts";
import { initializePredictionMeasurement, measurePredictionBoard, predictionMetrics } from "../server/measurement.ts";

const now = Date.parse("2026-09-27T10:00:00Z");
function setup(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "viaradar-measurement-"));
  const db = new DatabaseSync(join(dir, "test.sqlite"));
  db.exec("CREATE TABLE observations(service_date TEXT,trip_id TEXT,station_id TEXT,line TEXT,destination TEXT,platform TEXT,observed_at INTEGER,PRIMARY KEY(service_date,trip_id,station_id))");
  initializePredictionMeasurement(db);
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  return db;
}
function departure(id = "trip"): Departure {
  return { tripId: id, serviceDate: "20260927", line: "R1", destination: "Destination",
    scheduledAt: new Date(now + 600000).toISOString(), expectedAt: new Date(now + 660000).toISOString(),
    realtime: true, cancelled: false,
    platform: { kind: "prediction", value: "4", confidence: .9, sampleCount: 30, evidence: "Historical share", evidenceCode: "historical_share" } };
}
function board(rows = [departure()], time = now): Board {
  return { station: { id: "72305", name: "Hospitalet" }, generatedAt: new Date(time).toISOString(),
    staticImportedAt: null, departures: rows, warnings: [],
    incidents: { status: "unavailable", fetchedAt: null, feedTimestamp: null, error: null, items: [] },
    sources: ["vehicle_positions", "trip_updates"].map(kind => ({ kind, url: "https://example.test", fetchedAt: new Date(time).toISOString(),
      feedTimestamp: new Date(time).toISOString(), ageSeconds: 0, healthy: true, error: null })) };
}
function label(db: DatabaseSync, time: number, platform = "4", trip = "trip") {
  db.prepare("INSERT OR REPLACE INTO observations VALUES(?,?,?,?,?,?,?)").run("20260927", trip, "72305", "R1", "Destination", platform, time);
}
const metrics = (db: DatabaseSync, time = now) => predictionMetrics(db, "72305", time).engines[0]!;

test("Prospective first checkpoint is immutable and repeated polls/API metrics do not inflate samples", t => {
  const db = setup(t);
  measurePredictionBoard(db, board(), now);
  const changed = departure(); changed.platform.value = "7";
  measurePredictionBoard(db, board([changed], now + 20000), now + 20000);
  assert.equal(metrics(db).attempts, 1);
  assert.equal(metrics(db).publishedPlatformAgreement, null);
  assert.equal(metrics(db).pending, 1);
  assert.equal(metrics(db).predictionStatistics?.meanSampleCount, 30);
  assert.equal(metrics(db).predictionStatistics?.meanScheduledLeadSeconds, 600);
  assert.equal(metrics(db).predictionStatistics?.meanExpectedLeadSeconds, 660);
  assert.equal(db.prepare("SELECT predicted_platform FROM prediction_attempts").get()?.predicted_platform, "4");
  assert.equal(metrics(db).attempts, 1);
});

test("First later publication matches or mismatches and never changes retrospectively", t => {
  const db = setup(t);
  measurePredictionBoard(db, board([departure(), departure("other")]), now);
  label(db, now + 10000); label(db, now + 10000, "9", "other");
  measurePredictionBoard(db, board([], now + 20000), now + 20000);
  const result = metrics(db, now + 20000);
  assert.equal(result.correct, 1); assert.equal(result.incorrect, 1);
  assert.equal(result.publishedPlatformAgreement, .5);
  assert.equal(result.predictionStatistics?.meanLeadToPublicationSeconds, 10);
  label(db, now + 30000, "8");
  measurePredictionBoard(db, board([], now + 40000), now + 40000);
  assert.equal(metrics(db, now + 40000).correct, 1);
});

test("Abstentions count toward coverage, not agreement or predicted sample statistics", t => {
  const db = setup(t); const abstained = departure("abstained");
  abstained.platform = { kind: "unknown", value: null, confidence: null, sampleCount: 0, evidence: "Insufficient", evidenceCode: "insufficient_history" };
  measurePredictionBoard(db, board([departure(), abstained]), now);
  label(db, now + 10000, "8", "abstained");
  measurePredictionBoard(db, board([], now + 20000), now + 20000);
  const result = metrics(db);
  assert.equal(result.coverage, .5); assert.equal(result.abstained, 1);
  assert.equal(result.labelled, 1); assert.equal(result.evaluatedPredictions, 0);
  assert.equal(result.correct, 0); assert.equal(result.incorrect, 0);
  assert.equal(result.publishedPlatformAgreement, null);
});

test("No future, same-time, old, stale-source, or prior official label can create false accuracy", t => {
  const db = setup(t);
  measurePredictionBoard(db, board(), now);
  for (const stamp of [now - 1, now, now + 60000]) {
    label(db, stamp); measurePredictionBoard(db, board([], now + 20000), now + 20000);
    assert.equal(metrics(db).evaluatedPredictions, 0);
  }
  label(db, now + 1);
  measurePredictionBoard(db, board([], now + 100000), now + 100000);
  assert.equal(metrics(db).evaluatedPredictions, 0);
  label(db, now + 10000);
  const stale = board([], now + 20000); stale.sources[0]!.healthy = false;
  measurePredictionBoard(db, stale, now + 20000);
  assert.equal(metrics(db).evaluatedPredictions, 0);
});

test("Eligibility excludes known/withdrawn official, cancelled, overdue and unhealthy services", t => {
  const db = setup(t);
  const official = departure(); official.platform.kind = "official";
  measurePredictionBoard(db, board([official]), now);
  measurePredictionBoard(db, board(), now);
  label(db, now - 1000, "4", "known");
  const cancelled = departure("cancelled"); cancelled.cancelled = true;
  const overdue = departure("overdue"); overdue.scheduledAt = new Date(now - 1).toISOString();
  measurePredictionBoard(db, board([departure("known"), cancelled, overdue]), now);
  const unhealthy = board([departure("fresh")]); unhealthy.sources[0]!.healthy = false;
  measurePredictionBoard(db, unhealthy, now);
  const future = board([departure("future")], now + 1000);
  measurePredictionBoard(db, future, now);
  assert.deepEqual(predictionMetrics(db, "72305", now).engines, []);
});

test("Unresolved and cancelled trials are unevaluable, never incorrect; metrics reads do not write expiry", t => {
  const db = setup(t);
  measurePredictionBoard(db, board([departure(), departure("cancelled")]), now);
  const cancelled = departure("cancelled"); cancelled.cancelled = true;
  measurePredictionBoard(db, board([cancelled], now + 20000), now + 20000);
  const later = now + 7 * 3600000;
  assert.equal(metrics(db, later).unevaluable, 2);
  assert.equal(metrics(db, later).incorrect, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM prediction_attempts WHERE resolved_at IS NULL").get()?.n, 1);
  measurePredictionBoard(db, board([], later), later);
  assert.equal(metrics(db, later).pending, 0);
  assert.equal(metrics(db, later).publishedPlatformAgreement, null);
});

test("Additive migration is repeatable and retains old data; retention removes trials and official markers after 90 days", t => {
  const db = setup(t); label(db, now - 1000, "4", "legacy");
  initializePredictionMeasurement(db); initializePredictionMeasurement(db);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM observations").get()?.n, 1);
  measurePredictionBoard(db, board(), now);
  const official = departure("official"); official.platform.kind = "official";
  measurePredictionBoard(db, board([official]), now);
  const later = now + 91 * 86400000;
  assert.deepEqual(predictionMetrics(db, "72305", later).engines, []);
  measurePredictionBoard(db, board([], later), later);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM prediction_attempts").get()?.n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM prediction_official_seen").get()?.n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM observations").get()?.n, 1);
});


test("Reports exclude future attempts and separate station cohorts", t => {
  const db = setup(t);
  measurePredictionBoard(db, board(), now);
  assert.deepEqual(predictionMetrics(db, "72305", now - 1).engines, []);
  assert.deepEqual(predictionMetrics(db, "other", now).engines, []);
  assert.equal(metrics(db).serviceDays, 1);
});
