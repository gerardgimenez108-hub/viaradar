import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
export const dataDir = resolve(process.env.DATA_DIR || "data");
mkdirSync(dataDir, { recursive: true });
export const db = new DatabaseSync(resolve(dataDir, "viaradar.sqlite"));
db.exec(`PRAGMA journal_mode=WAL;
 CREATE TABLE IF NOT EXISTS snapshots(id INTEGER PRIMARY KEY, kind TEXT NOT NULL, fetched_at INTEGER NOT NULL, feed_timestamp INTEGER, hash TEXT NOT NULL, body TEXT NOT NULL, UNIQUE(kind,hash));
 CREATE INDEX IF NOT EXISTS snapshots_time ON snapshots(fetched_at);
 CREATE TABLE IF NOT EXISTS observations(service_date TEXT, trip_id TEXT, station_id TEXT, line TEXT, destination TEXT, platform TEXT, observed_at INTEGER, PRIMARY KEY(service_date,trip_id,station_id));`);
export function saveSnapshot(
  kind: string,
  body: string,
  stamp: number,
  now = Date.now(),
): void {
  db.prepare(
    "INSERT OR IGNORE INTO snapshots(kind,fetched_at,feed_timestamp,hash,body) VALUES(?,?,?,?,?)",
  ).run(
    kind,
    now,
    stamp,
    createHash("sha256").update(body).digest("hex"),
    body,
  );
  db.prepare("DELETE FROM snapshots WHERE fetched_at < ?").run(
    now - 7 * 86400000,
  );
  db.prepare("DELETE FROM observations WHERE observed_at < ?").run(
    now - 90 * 86400000,
  );
}
