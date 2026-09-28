import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { extractAssignments, initializeAssignments, saveAssignments, assignmentMetrics, PROVENANCE } from "../server/assignments.ts";
import type { Feed, Vehicle } from "../server/model.ts";
import type { StaticData } from "../server/static.ts";
const now = Date.parse("2026-09-28T08:00:00Z");
const data: StaticData = {
  importedAt: "2026-09-27T00:00:00Z", stops: [],
  trips: [{ trip_id: "r1", route_id: "route1", service_id: "daily", trip_headsign: "Maçanet" }],
  routes: [{ route_id: "route1", route_short_name: "R1" }],
  stopTimes: [{ trip_id: "r1", stop_id: "72305", stop_sequence: "1", departure_time: "10:05:00" }, { trip_id: "r1", stop_id: "end", stop_sequence: "2", departure_time: "11:00:00" }],
  calendar: [{ service_id: "daily", start_date: "20260101", end_date: "20261231", monday: "1", tuesday: "1", wednesday: "1", thursday: "1", friday: "1", saturday: "1", sunday: "1" }], exceptions: [],
};
function feed(overrides: Partial<Vehicle> = {}, time = now): Feed { return { header: { timestamp: time / 1000 }, entity: [{ id: "entity", vehicle: {
  trip: { tripId: "r1" }, vehicle: { id: "vehicle", label: "R1-123-PLATF.(14)" }, timestamp: time / 1000,
  stopId: "72305", currentStatus: "INCOMING_AT", ...overrides,
} }] }; }
function extract(overrides: Partial<Vehicle> = {}, time = now) { return extractAssignments(feed(overrides, time), data, ["72305"], time, PROVENANCE.LIVE); }
function database() { const db = new DatabaseSync(":memory:"); initializeAssignments(db); return db; }
test("moving publication is retained when stopped update omits platform; no invented confirmation", () => {
  const db = database();
  try {
    saveAssignments(db, extract());
    saveAssignments(db, extract({ currentStatus: "STOPPED_AT", vehicle: { id: "vehicle", label: "R1-123" } }, now + 20000));
    const report = assignmentMetrics(db, "72305", now + 20000).lines[0];
    assert.equal(report.assignedServices, 1); assert.equal(report.movingAssignedEvents, 1);
    assert.equal(report.stoppedAssignedEvents, 0); assert.equal(report.missingAfterAssignmentEvents, 1);
    assert.equal(report.outboundAssignedServices, 1); assert.equal(report.terminalAssignedServices, 0);
    assert.equal(db.prepare("SELECT platform FROM assignment_events WHERE platform IS NOT NULL").get()?.platform, "14");
  } finally { db.close(); }
});
test("source-time events preserve platform changes and deduplicate repeated live/backfill reads", () => {
  const db = database();
  try {
    const first = extract();
    assert.equal(saveAssignments(db, first), 1);
    assert.equal(saveAssignments(db, extractAssignments(feed(), data, ["72305"], now + 20000, PROVENANCE.BACKFILL)), 0);
    assert.equal(saveAssignments(db, extract({ vehicle: { id: "vehicle", label: "R1-123-PLATF.(16)" } }, now + 20000)), 1);
    assert.equal(assignmentMetrics(db, "72305", now + 20000).lines[0].observedServices, 1);
    assert.equal(db.prepare("SELECT count(*) n FROM assignment_events").get()?.n, 2);
  } finally { db.close(); }
});
test("terminal services retained and classified rather than dropped by departures board", () => {
  const terminal = { ...data, stopTimes: data.stopTimes.slice(0, 1) };
  const event = extractAssignments(feed(), terminal, ["72305"], now, PROVENANCE.LIVE)[0];
  assert.equal(event.terminal, 1); assert.equal(event.line, "R1"); assert.equal(event.serviceDate, "20260928");
  const db = database();
  try { saveAssignments(db, [event]); const report = assignmentMetrics(db, "72305", now).lines[0]; assert.equal(report.terminalAssignedServices, 1); assert.equal(report.outboundAssignedServices, 0); }
  finally { db.close(); }
});
test("freshness excludes stale/future/malformed evidence while retaining raw diagnostics", () => {
  for (const [timestamp, expected] of [[now / 1000 - 100, "stale"], [now / 1000 + 1, "future"], ["bad", "malformed_timestamp"]] as const) {
    const rows = extract({ timestamp });
    assert.equal(rows[0].freshness, expected);
    const db = database();
    try { saveAssignments(db, rows); const metrics = assignmentMetrics(db, "72305", now).lines[0]; assert.equal(metrics.assignedServices, 0); assert.equal(metrics.diagnosticEvents, 1); }
    finally { db.close(); }
  }
  const staleFeed = feed(); staleFeed.header.timestamp = now / 1000 - 100;
  assert.equal(extractAssignments(staleFeed, data, ["72305"], now, PROVENANCE.LIVE)[0].freshness, "stale");
});
test("unresolved, invalid and old-timetable identities never become identified service counts", () => {
  assert.equal(extract({ trip: { tripId: "missing" } })[0].serviceDate, null);
  assert.equal(extract({ trip: { tripId: "r1", startDate: "20260230" } })[0].dateOrigin, "invalid_explicit");
  const old = extractAssignments(feed(), { ...data, importedAt: "2026-09-29T00:00:00Z" }, ["72305"], now, PROVENANCE.BACKFILL)[0];
  assert.equal(old.line, null); assert.equal(old.serviceDate, null);
  assert.equal(extract({ trip: { tripId: "r1", startDate: "20260928" } })[0].dateOrigin, "explicit");
  assert.equal(extract()[0].dateOrigin, "inferred_unique_schedule_6h");
  assert.equal(extractAssignments(feed({ stopId: "elsewhere" }), data, ["72305"], now, PROVENANCE.LIVE).length, 0);
});
test("ambiguous overnight service date stays unresolved", () => {
  const ambiguous = { ...data, stopTimes: [
    { trip_id: "r1", stop_id: "72305", stop_sequence: "1", departure_time: "09:00:00" },
    { trip_id: "r1", stop_id: "72305", stop_sequence: "2", departure_time: "33:00:00" },
  ] };
  assert.equal(extractAssignments(feed(), ambiguous, ["72305"], now, PROVENANCE.LIVE)[0].serviceDate, null);
});
test("new schema and capture never modify legacy observations or prediction outcomes", () => {
  const db = database();
  try {
    db.exec("CREATE TABLE observations(value TEXT); INSERT INTO observations VALUES('legacy'); CREATE TABLE prediction_attempts(value TEXT); INSERT INTO prediction_attempts VALUES('frozen');");
    initializeAssignments(db); saveAssignments(db, extract());
    assert.deepEqual(db.prepare("SELECT value FROM observations").all().map(r => r.value), ["legacy"]);
    assert.deepEqual(db.prepare("SELECT value FROM prediction_attempts").all().map(r => r.value), ["frozen"]);
  } finally { db.close(); }
});
test("recovery is read-only by default and explicit apply is idempotent without legacy writes", () => {
  const dir = mkdtempSync(join(tmpdir(), "viaradar-assignment-test-"));
  const path = join(dir, "test.sqlite"); const staticPath = join(dir, "static.json");
  try {
    writeFileSync(staticPath, JSON.stringify(data));
    const fixture = new DatabaseSync(path);
    fixture.exec("CREATE TABLE snapshots(id INTEGER PRIMARY KEY,kind TEXT,fetched_at INTEGER,body TEXT); CREATE TABLE observations(value TEXT); INSERT INTO observations VALUES('legacy'); CREATE TABLE prediction_attempts(value TEXT); INSERT INTO prediction_attempts VALUES('frozen');");
    fixture.prepare("INSERT INTO snapshots VALUES(1,'vehicle_positions',?,?)").run(now, JSON.stringify({ header: { timestamp: now / 1000 }, entity: [null] }));
    fixture.prepare("INSERT INTO snapshots VALUES(2,'vehicle_positions',?,?)").run(now, JSON.stringify(feed()));
    fixture.prepare("INSERT INTO snapshots VALUES(3,'vehicle_positions',?,?)").run(now, JSON.stringify({ header: { timestamp: now / 1000 } }));
    fixture.prepare("INSERT INTO snapshots VALUES(4,'vehicle_positions',?,?)").run(now, JSON.stringify({ header: { timestamp: now / 1000 }, entity: null })); fixture.close();
    const run = (apply: boolean) => spawnSync(process.execPath, ["--experimental-strip-types", resolve("scripts/backfill-assignments.ts"), "--db", path, "--static", staticPath, ...(apply ? ["--apply"] : [])], { encoding: "utf8", env: { ...process.env, STATION_IDS: "72305" } });
    const dry = run(false); assert.equal(dry.status, 0, dry.stderr);
    assert.equal(JSON.parse(dry.stdout).snapshots, 4); assert.equal(JSON.parse(dry.stdout).invalidSnapshots, 2);
    const readonly = new DatabaseSync(path, { readOnly: true });
    assert.equal(readonly.prepare("SELECT name FROM sqlite_master WHERE name='assignment_events'").get(), undefined); readonly.close();
    const first = run(true); assert.equal(first.status, 0, first.stderr); assert.equal(JSON.parse(first.stdout).insertedEvents, 1);
    const second = run(true); assert.equal(second.status, 0, second.stderr); assert.equal(JSON.parse(second.stdout).insertedEvents, 0);
    const result = new DatabaseSync(path, { readOnly: true });
    assert.equal(result.prepare("SELECT value FROM observations").get()?.value, "legacy");
    assert.equal(result.prepare("SELECT value FROM prediction_attempts").get()?.value, "frozen");
    assert.equal(result.prepare("SELECT provenance FROM assignment_events").get()?.provenance, "backfill"); result.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
