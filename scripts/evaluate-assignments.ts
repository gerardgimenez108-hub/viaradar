import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { evaluateAssignments, type AssignmentSample } from "../server/assignment-evaluation.ts";

const args = process.argv.slice(2);
const options = new Map<string, string>();
for (let i = 0; i < args.length; i += 2) {
  const flag = args[i], value = args[i + 1];
  if (!["--db", "--as-of", "--station"].includes(flag) || !value || value.startsWith("--") || options.has(flag))
    throw new Error("Usage: evaluate-assignments.ts [--db PATH] [--as-of ISO_TIMESTAMP] [--station ID]");
  options.set(flag, value);
}
const asOf = options.has("--as-of") ? Date.parse(options.get("--as-of")!) : Date.now();
if (!Number.isFinite(asOf)) throw new Error("Invalid --as-of timestamp");
// Do not import store.ts: its initialization can write to the production database.
const db = new DatabaseSync(resolve(options.get("--db") ?? "data/viaradar.sqlite"), { readOnly: true });
try {
  db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=5000");
  const rows = db.prepare(`SELECT station_id stationId, trip_id tripId, service_date serviceDate,
    observed_at observedAt, fetched_at fetchedAt, platform, line, destination, terminal, freshness
    FROM assignment_events WHERE station_id=? AND fetched_at<=?`).all(options.get("--station") ?? "72305", asOf);
  console.log(JSON.stringify(evaluateAssignments(rows as unknown as AssignmentSample[], asOf), null, 2));
} finally { db.close(); }
