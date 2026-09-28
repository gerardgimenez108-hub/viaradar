import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { extractAssignments, initializeAssignments, saveAssignments, PROVENANCE, type AssignmentEvent } from "../server/assignments.ts";
import type { Feed } from "../server/model.ts";
import type { StaticData } from "../server/static.ts";

// No store/realtime imports: dry runs must never initialize or mutate production tables.
const args = process.argv.slice(2);
const allowed = new Set(["--db", "--static", "--since", "--apply"]);
for (let i = 0; i < args.length; i++) {
  if (!allowed.has(args[i])) throw new Error(`Unknown argument: ${args[i]}`);
  if (args[i] !== "--apply" && (!args[++i] || args[i].startsWith("--"))) throw new Error("Missing argument value");
}
function option(name: string, fallback: string): string { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; }
const apply = args.includes("--apply");
const path = resolve(option("--db", "data/viaradar.sqlite"));
const data = JSON.parse(readFileSync(resolve(option("--static", "data/static.json")), "utf8")) as StaticData;
const since = Date.parse(option("--since", data.importedAt));
if (!Number.isFinite(since)) throw new Error("Invalid --since or static importedAt timestamp");
const stations = (process.env.STATION_IDS || "72305").split(",").map(s => s.trim()).filter(Boolean);
const db = new DatabaseSync(path, { readOnly: !apply });
db.exec("PRAGMA busy_timeout=5000");
if (apply) {
  db.exec("PRAGMA journal_mode=WAL");
  initializeAssignments(db);
}
let last = 0, snapshots = 0, extracted = 0, inserted = 0, invalidSnapshots = 0;
const upperId = Number(db.prepare("SELECT coalesce(max(id),0) id FROM snapshots").get()?.id ?? 0);
const diagnostics: Record<string, number> = {};
const dates: Record<string, number> = {};
try {
  while (true) {
    const rows = db.prepare("SELECT id,fetched_at,body FROM snapshots WHERE kind='vehicle_positions' AND fetched_at>=? AND id>? AND id<=? ORDER BY id LIMIT 100").all(since, last, upperId);
    if (!rows.length) break;
    for (const row of rows) {
      last = Number(row.id); snapshots++;
      let events: AssignmentEvent[];
      try {
        const feed = JSON.parse(String(row.body)) as Feed;
        // GTFS-RT FULL_DATASET may omit entity entirely when no vehicles exist.
        if (feed.entity === undefined) feed.entity = [];
        if (!feed.header || !Array.isArray(feed.entity)) throw new Error("Invalid feed");
        events = extractAssignments(feed, data, stations, Number(row.fetched_at), PROVENANCE.BACKFILL);
      }
      catch { invalidSnapshots++; continue; }
      extracted += events.length;
      for (const event of events) { diagnostics[event.freshness] = (diagnostics[event.freshness] ?? 0) + 1; dates[event.dateOrigin] = (dates[event.dateOrigin] ?? 0) + 1; }
      if (apply) inserted += saveAssignments(db, events);
      if (snapshots % 1000 === 0) console.error(`Processed ${snapshots} snapshots; extracted ${extracted}; inserted ${inserted}`);
    }
  }
} finally { db.close(); }
console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", db: path, since: new Date(since).toISOString(), snapshots, invalidSnapshots,
  extractedEventsBeforeDeduplication: extracted, insertedEvents: apply ? inserted : null, diagnosticsBeforeDeduplication: diagnostics,
  dateOriginsBeforeDeduplication: dates, warning: "Recovered assignments are not prospective predictions or confirmed departures. Existing observations and prediction attempts are untouched." }, null, 2));
