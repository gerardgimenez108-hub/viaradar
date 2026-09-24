import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { resolve, extname } from "node:path";
import { loadStatic } from "./static.ts";
import { createBoard } from "./board.ts";
import { collect, sourceStatus } from "./realtime.ts";
import { db } from "./store.ts";
const data = loadStatic();
const stationIds = (process.env.STATION_IDS || "72305")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);
const allowedOrigins = new Set(
  (
    process.env.ALLOWED_ORIGINS ||
    "https://buscando-la-via-h.web.app,https://buscando-la-via-h.firebaseapp.com,https://viaradar.web.app"
  )
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
);
let collecting = false;
async function tick() {
  if (collecting) return;
  collecting = true;
  try {
    await collect();
    for (const station of stationIds) createBoard(data, station);
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
          ok: true,
          timetableLoaded: !!data,
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
      else if (url.pathname === "/api/departures") {
        const station = url.searchParams.get("stationId") || "72305";
        if (!stationIds.includes(station)) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: "Station not configured" }));
          return;
        }
        payload = createBoard(data, station);
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
  server.close(() => {
    db.close();
    process.exit(0);
  });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
