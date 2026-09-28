import { measurePredictionBoard, predictionMetrics } from "./measurement.ts";
import { captureAssignments, assignmentMetrics } from "./assignments.ts";
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { resolve, extname } from "node:path";
import { loadStatic } from "./static.ts";
import { createStaticRefresher } from "./static-refresh.ts";
import { createBoard } from "./board.ts";
import { collect, sourceStatus, sources } from "./realtime.ts";
import { db } from "./store.ts";
import { configuredOrigins } from "./origins.ts";
let data = loadStatic();
const stationIds = (process.env.STATION_IDS || "72305")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);
const refresher = createStaticRefresher({
  path: resolve(process.env.DATA_DIR || "data", "static.json"),
  stations: stationIds,
  initial: data,
  url: process.env.STATIC_URL,
  onUpdate: (updated) => { data = updated; console.log("Timetable refreshed", updated.importedAt); },
});
void refresher.check();
const refreshTimer = setInterval(() => void refresher.check(), 60 * 60 * 1000);
const allowedOrigins = configuredOrigins(process.env.ALLOWED_ORIGINS);
let collecting = false;
async function tick() {
  if (collecting) return;
  collecting = true;
  try {
    await collect();
    const vehicles = sources.get("vehicle_positions");
    if (vehicles?.feed && vehicles.status.fetchedAt) {
      captureAssignments(db, vehicles.feed, data, stationIds, Date.parse(vehicles.status.fetchedAt));
    }
    for (const station of stationIds) {
      const now = Date.now();
      measurePredictionBoard(db, createBoard(data, station, now), now);
    }
  } catch (error) {
    console.error(error);
  } finally {
    collecting = false;
  }
}
void tick();
const timer = setInterval(() => void tick(), 20000);
const server = createServer((req, res) => {
  try {
    res.setHeader("X-Content-Type-Options", "nosniff");
    const url = new URL(req.url || "/", "http://localhost");
    if (url.pathname.startsWith("/api/")) {
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Vary", "Origin");
      const origin = req.headers.origin;
      if (origin) {
        if (!allowedOrigins.has(origin)) {
          res.writeHead(403);
          res.end(JSON.stringify({ error: "Origin not allowed" }));
          return;
        }
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      }
      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }
      if (req.method !== "GET") {
        res.writeHead(405);
        res.end(JSON.stringify({ error: "Method not allowed" }));
        return;
      }
      let payload: unknown;
      if (url.pathname === "/api/health")
        payload = {
          ok: !!data && refresher.status().usable,
          timetableLoaded: !!data,
          timetable: refresher.status(),
          sources: sourceStatus(),
        };
      else if (url.pathname === "/api/stations")
        payload = stationIds.map((id) => ({
          id,
          name: data?.stops.find((s) => s.stop_id === id)?.stop_name || id,
        }));
      else if (url.pathname === "/api/history")
        payload = {
          snapshots: db
            .prepare(
              "SELECT kind, COUNT(*) as count,MIN(fetched_at) as firstFetchedAt,MAX(fetched_at) as lastFetchedAt FROM snapshots GROUP BY kind",
            )
            .all(),
          observations: db
            .prepare("SELECT COUNT(*) as count FROM observations")
            .get(),
          rawRetentionDays: 7,
          observationRetentionDays: 90,
        };
      else if (["/api/departures", "/api/predictions", "/api/assignments"].includes(url.pathname)) {
        const station = url.searchParams.get("stationId") || "72305";
        if (!stationIds.includes(station)) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: "Station not configured" }));
          return;
        }
        payload = url.pathname === "/api/assignments" ? assignmentMetrics(db, station) : url.pathname === "/api/predictions"
          ? predictionMetrics(db, station) : createBoard(data, station);
      } else {
        res.writeHead(404);
        payload = { error: "Not found" };
      }
      res.end(JSON.stringify(payload));
      return;
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(url.pathname);
    } catch {
      res.writeHead(400);
      res.end("Malformed URL");
      return;
    }
    const base = resolve("dist");
    const path = resolve(base, `.${decoded}`);
    if (
      path !== base &&
      !path.startsWith(base + "/") &&
      !path.startsWith(base + "\\")
    ) {
      res.writeHead(403);
      res.end();
      return;
    }
    const file =
      existsSync(path) && extname(path) ? path : resolve(base, "index.html");
    if (!existsSync(file)) {
      res.writeHead(503, { "Content-Type": "text/plain" });
      res.end("Build the frontend with npm run build, or use npm run dev.");
      return;
    }
    const mime: Record<string, string> = {
      ".html": "text/html",
      ".js": "text/javascript",
      ".css": "text/css",
      ".json": "application/json",
      ".webmanifest": "application/manifest+json",
      ".png": "image/png",
      ".svg": "image/svg+xml",
    };
    res.setHeader(
      "Content-Type",
      mime[extname(file)] || "application/octet-stream",
    );
    res.setHeader("Cache-Control", "no-cache");
    res.end(readFileSync(file));
  } catch (error) {
    console.error("Request failed", error);
    if (!res.headersSent)
      res.writeHead(500, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
    res.end(JSON.stringify({ error: "Departure service unavailable" }));
  }
});
server.listen(
  Number(process.env.PORT || 8787),
  process.env.HOST || "127.0.0.1",
  () => console.log("ViaRadar listening on http://127.0.0.1:8787"),
);
function shutdown() {
  clearInterval(timer);
  clearInterval(refreshTimer);
  server.close(() => {
    db.close();
    process.exit(0);
  });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
