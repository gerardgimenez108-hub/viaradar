import { resolve } from "node:path";
import { createStaticRefresher } from "./static-refresh.ts";
import { loadStatic } from "./static.ts";
const path = resolve(process.env.DATA_DIR || "data", "static.json");
const refresher = createStaticRefresher({
  path,
  stations: (process.env.STATION_IDS || "72305").split(",").map((id) => id.trim()).filter(Boolean),
  initial: loadStatic(path),
  url: process.env.STATIC_URL,
  onUpdate: (data) => console.log(`Imported ${data.trips.length} trips and ${data.stopTimes.length} stop times. The running server refreshes its own timetable automatically.`),
});
await refresher.check(true);
if (refresher.status().lastError) throw new Error(refresher.status().lastError!);
