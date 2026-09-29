import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { evaluateAssignments, type AssignmentSample } from "../server/assignment-evaluation.ts";

function sample(overrides: Partial<AssignmentSample> = {}): AssignmentSample {
  return { stationId: "72305", tripId: "r1-a", serviceDate: "20260924", observedAt: 1000, fetchedAt: 1020,
    platform: "11", line: "R1", destination: "Mataro", terminal: 0, freshness: "fresh", ...overrides };
}
test("counts services, not snapshots, and never presents majority share as accuracy", () => {
  const report = evaluateAssignments(Array.from({ length: 60 }, (_, i) => sample({ observedAt: 1000 + i, fetchedAt: 1100 + i })), 2000);
  assert.equal(report.groups[0].services, 1);
  assert.equal(report.groups[0].majorityShare, 1);
  assert.equal(report.groups[0].meetsDescriptiveGate, false);
  assert.equal(report.predictionAccuracy, null);
});
test("as-of cutoff excludes labels received later even with an earlier source timestamp", () => {
  const rows = [sample(), sample({ platform: "13", observedAt: 1100, fetchedAt: 3000 })];
  assert.equal(evaluateAssignments(rows, 2000).groups[0].majorityPlatform, "11");
  assert.equal(evaluateAssignments(rows, 4000).groups[0].majorityPlatform, "13");
  assert.equal(evaluateAssignments(rows, 4000).groups[0].changedServices, 1);
});
test("rejects stale, terminal, unresolved, absent-platform and impossible-time evidence", () => {
  const report = evaluateAssignments([
    sample({ freshness: "stale" }), sample({ terminal: 1 }), sample({ serviceDate: null }),
    sample({ platform: null }), sample({ observedAt: 1200, fetchedAt: 1000 }), sample({ line: null }),
  ], 2000);
  assert.equal(report.identifiedServices, 0);
  assert.deepEqual(report.groups, []);
});
test("contradictory equal source timestamps are excluded regardless of receipt order", () => {
  const report = evaluateAssignments([sample(), sample({ platform: "13", fetchedAt: 1030 })], 2000);
  assert.equal(report.conflictingServices, 1);
  assert.deepEqual(report.groups, []);
});
test("separates service dates, stations and destinations and preserves genuine variability", () => {
  const rows = Array.from({ length: 20 }, (_, i) => sample({ tripId: `trip${i}`,
    serviceDate: `2026092${4 + i % 3}`, platform: i < 16 ? "11" : "13" }));
  const first = evaluateAssignments(rows, 2000).groups[0];
  assert.equal(first.meetsDescriptiveGate, true);
  assert.equal(first.majorityShare, 0.8);
  rows[15].platform = "13";
  assert.equal(evaluateAssignments(rows, 2000).groups[0].meetsDescriptiveGate, false);
  rows.push(sample({ destination: "Blanes" }), sample({ stationId: "71801" }));
  assert.equal(evaluateAssignments(rows, 2000).groups.length, 3);
});
test("CLI is read-only, leaves rows/schema untouched and emits no database path", () => {
  const directory = mkdtempSync(join(tmpdir(), "viaradar-assignment-report-"));
  const path = join(directory, "private-database.sqlite");
  try {
    const db = new DatabaseSync(path);
    db.exec(`CREATE TABLE assignment_events (station_id TEXT, trip_id TEXT, service_date TEXT,
      observed_at INTEGER, fetched_at INTEGER, platform TEXT, line TEXT, destination TEXT, terminal INTEGER, freshness TEXT);
      INSERT INTO assignment_events VALUES('72305','a','20260924',1000,1020,'11','R1','Mataro',0,'fresh');`);
    const before = db.prepare("SELECT * FROM sqlite_master ORDER BY name").all();
    db.close();
    const result = spawnSync(process.execPath, ["--experimental-strip-types", "scripts/evaluate-assignments.ts", "--db", path,
      "--as-of", "1970-01-01T00:00:02Z"], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).groups[0].services, 1);
    assert.equal(result.stdout.includes(path), false);
    const after = new DatabaseSync(path, { readOnly: true });
    assert.deepEqual(after.prepare("SELECT * FROM sqlite_master ORDER BY name").all(), before);
    assert.equal(after.prepare("SELECT count(*) n FROM assignment_events").get()?.n, 1);
    after.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
