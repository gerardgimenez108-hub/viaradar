import { unzipSync, strFromU8 } from "fflate";
import { parse } from "csv-parse/sync";
import { writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "./store.ts";
import type { Row } from "./model.ts";
const url =
  process.env.STATIC_URL ||
  "https://ssl.renfe.com/ftransit/Fichero_CER_FOMENTO/fomento_transit.zip";
const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
if (!response.ok) throw new Error(`GTFS download failed: ${response.status}`);
const files = unzipSync(new Uint8Array(await response.arrayBuffer()));
function rows(name: string): Row[] {
  const file = Object.entries(files).find(([path]) => path.endsWith(name));
  if (!file) return [];
  return parse(strFromU8(file[1]), {
    bom: true,
    columns: (headers: string[]) => headers.map((h) => h.trim()),
    trim: true,
    skip_empty_lines: true,
    relax_column_count: true,
  }) as Row[];
}
const allTimes = rows("stop_times.txt");
const stationIds = new Set((process.env.STATION_IDS || "72305").split(","));
const tripIds = new Set(
  allTimes
    .filter((row) => stationIds.has(row.stop_id!))
    .map((row) => row.trip_id),
);
const data = {
  importedAt: new Date().toISOString(),
  stops: rows("stops.txt"),
  trips: rows("trips.txt").filter((row) => tripIds.has(row.trip_id)),
  routes: rows("routes.txt"),
  stopTimes: allTimes.filter((row) => tripIds.has(row.trip_id)),
  calendar: rows("calendar.txt"),
  exceptions: rows("calendar_dates.txt"),
};
if (
  !data.stops.some((s) => s.stop_id === "72305") ||
  !data.trips.length ||
  !data.stopTimes.length
)
  throw new Error("Invalid GTFS: missing Hospitalet or timetable");
writeFileSync(join(dataDir, "static.tmp"), JSON.stringify(data));
renameSync(join(dataDir, "static.tmp"), join(dataDir, "static.json"));
console.log(
  `Imported ${data.trips.length} trips and ${data.stopTimes.length} stop times. Restart the server to load the new timetable.`,
);
