import { unzip, strFromU8 } from "fflate";
import { parse } from "csv-parse/sync";
import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import type { Row } from "./model.ts";
import { assertStaticShape, type StaticData } from "./static.ts";
import { activeService, serviceDays } from "./time.ts";

export const STATIC_URL = "https://ssl.renfe.com/ftransit/Fichero_CER_FOMENTO/fomento_transit.zip";
const DAY = 24 * 60 * 60 * 1000;
const RETRY = 60 * 60 * 1000;
const MAX_DOWNLOAD = 80 * 1024 * 1024;
const MAX_EXPANDED = 512 * 1024 * 1024;
const TABLES = ["stops.txt", "trips.txt", "routes.txt", "stop_times.txt", "calendar.txt", "calendar_dates.txt"];

export function timetableCoverage(data: StaticData | null, stations: string[], now: number) {
  if (!data) return { usable: false, dates: [], validThrough: null };
  const calendars = new Map(data.calendar.map((row) => [row.service_id, row]));
  const exceptions = new Map(data.exceptions.map((row) => [`${row.service_id}:${row.date}`, row.exception_type]));
  const trips = new Map(data.trips.map((row) => [row.trip_id, row]));
  const stationServices = new Map(stations.map((id) => [id, new Set<string>()]));
  for (const row of data.stopTimes) {
    const trip = trips.get(row.trip_id);
    if (trip && row.pickup_type !== "1") stationServices.get(row.stop_id)?.add(trip.service_id);
  }
  const dates = serviceDays(now).slice(1).map((date) => ({
    date,
    stations: stations.map((stationId) => ({ stationId, active: [...stationServices.get(stationId)!].some((service) => activeService(service, date, calendars, exceptions)) })),
  }));
  const serviceIds = new Set(data.trips.map((trip) => trip.service_id));
  const ends = [...data.calendar.filter((row) => serviceIds.has(row.service_id)).map((row) => row.end_date), ...data.exceptions.filter((row) => serviceIds.has(row.service_id) && row.exception_type === "1").map((row) => row.date)].filter(Boolean).sort();
  return { usable: dates.every((entry) => entry.stations.every((station) => station.active)), dates, validThrough: ends.at(-1) || null };
}

export function validateTimetable(data: StaticData, stations: string[], now: number): void {
  assertStaticShape(data);
  if (!stations.length || !data.stops.length || !data.trips.length || !data.routes.length || !data.stopTimes.length || (!data.calendar.length && !data.exceptions.length)) throw new Error("Empty required timetable data");
  const stops = new Set(data.stops.map((row) => row.stop_id));
  const routes = new Set(data.routes.map((row) => row.route_id));
  const services = new Set([...data.calendar, ...data.exceptions].map((row) => row.service_id));
  const trips = new Set(data.trips.map((row) => row.trip_id));
  if (trips.size !== data.trips.length || data.trips.some((row) => !row.trip_id || !routes.has(row.route_id) || !services.has(row.service_id))) throw new Error("Invalid timetable trip references");
  const timedTrips = new Set<string>();
  for (const row of data.stopTimes) {
    if (!trips.has(row.trip_id) || !stops.has(row.stop_id) || !/^\d+$/.test(row.stop_sequence || "") || !/^\d{1,3}:[0-5]\d:[0-5]\d$/.test(row.departure_time || "") || !/^\d{1,3}:[0-5]\d:[0-5]\d$/.test(row.arrival_time || "")) throw new Error("Invalid timetable stop-time references or times");
    timedTrips.add(row.trip_id);
  }
  if (data.trips.some((row) => !timedTrips.has(row.trip_id))) throw new Error("Timetable trip has no stop times");
  if (stations.some((station) => !stops.has(station)) || !timetableCoverage(data, stations, now).usable) throw new Error("Timetable lacks configured station service today or tomorrow");
}

export async function downloadTimetable(url: string, stations: string[], now: number, fetcher: typeof fetch = fetch, timeoutMs = 120000): Promise<StaticData> {
  const signal = AbortSignal.timeout(timeoutMs);
  const response = await fetcher(url, { signal });
  if (!response.ok) throw new Error(`GTFS download failed: ${response.status}`);
  if (!response.body) throw new Error("Empty GTFS download");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const result = await reader.read();
      if (result.done) break;
      size += result.value.length;
      if (size > MAX_DOWNLOAD) throw new Error("GTFS download exceeds size limit");
      chunks.push(result.value);
    }
  } finally { await reader.cancel(); }
  const packed = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { packed.set(chunk, offset); offset += chunk.length; }
  let expanded = 0;
  const files = await new Promise<Record<string, Uint8Array>>((resolve, reject) => {
    const stop = unzip(packed, { filter: (file) => {
      if (!TABLES.includes(file.name.split("/").at(-1)!)) return false;
      expanded += file.originalSize;
      return expanded <= MAX_EXPANDED;
    } }, (error, result) => error ? reject(error) : resolve(result));
    const abort = () => { stop(); reject(signal.reason); };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
  if (expanded > MAX_EXPANDED) throw new Error("GTFS expanded data exceeds size limit");
  function rows(name: string): Row[] {
    const matches = Object.entries(files).filter(([path]) => path.split("/").at(-1) === name);
    if (matches.length > 1) throw new Error(`Duplicate GTFS table: ${name}`);
    return matches.length ? parse(strFromU8(matches[0]![1]), { bom: true, columns: (headers: string[]) => headers.map((header) => header.trim()), trim: true, skip_empty_lines: true }) as Row[] : [];
  }
  const allTimes = rows("stop_times.txt");
  const stationSet = new Set(stations);
  const tripIds = new Set(allTimes.filter((row) => stationSet.has(row.stop_id)).map((row) => row.trip_id));
  const data: StaticData = { importedAt: new Date(now).toISOString(), stops: rows("stops.txt"), trips: rows("trips.txt").filter((row) => tripIds.has(row.trip_id)), routes: rows("routes.txt"), stopTimes: allTimes.filter((row) => tripIds.has(row.trip_id)), calendar: rows("calendar.txt"), exceptions: rows("calendar_dates.txt") };
  signal.throwIfAborted();
  validateTimetable(data, stations, now);
  return data;
}

// National GTFS CSV parsing must not block the 20-second realtime collector.
if (!isMainThread && workerData?.kind === "viaradar-static-refresh") {
  downloadTimetable(workerData.url, workerData.stations, workerData.now, fetch, workerData.timeoutMs)
    .then((data) => parentPort!.postMessage(data))
    .catch((error) => { throw error; });
}
function downloadInWorker(url: string, stations: string[], now: number, timeoutMs = 120000): Promise<StaticData> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), { workerData: { kind: "viaradar-static-refresh", url, stations, now, timeoutMs }, execArgv: ["--experimental-strip-types"] });
    const timeout = setTimeout(() => { void worker.terminate(); reject(new Error("GTFS refresh timed out")); }, timeoutMs);
    worker.once("message", (data: StaticData) => { clearTimeout(timeout); void worker.terminate(); resolve(data); });
    worker.once("error", (error) => { clearTimeout(timeout); reject(error); });
    worker.once("exit", (code) => { clearTimeout(timeout); if (code !== 0) reject(new Error(`GTFS refresh worker exited: ${code}`)); });
  });
}
interface RefreshOptions {
  path: string;
  stations: string[];
  initial: StaticData | null;
  onUpdate: (data: StaticData) => void;
  url?: string;
  now?: () => number;
  fetcher?: typeof fetch;
  timeoutMs?: number;
}
export function createStaticRefresher(options: RefreshOptions) {
  let current = options.initial;
  let running: Promise<void> | null = null;
  let lastAttempt: number | null = null;
  let lastError: string | null = null;
  const now = options.now || Date.now;
  function status() {
    const time = now();
    const imported = current ? Date.parse(current.importedAt) : NaN;
    return { ...timetableCoverage(current, options.stations, time), importedAt: current?.importedAt || null, stale: !Number.isFinite(imported) || time - imported >= DAY || imported > time, refreshing: !!running, lastAttemptAt: lastAttempt === null ? null : new Date(lastAttempt).toISOString(), lastError };
  }
  async function perform() {
    lastAttempt = now();
    const temporary = `${options.path}.${randomUUID()}.tmp`;
    try {
      const data = options.fetcher
        ? await downloadTimetable(options.url || STATIC_URL, options.stations, now(), options.fetcher, options.timeoutMs)
        : await downloadInWorker(options.url || STATIC_URL, options.stations, now(), options.timeoutMs);
      await mkdir(dirname(options.path), { recursive: true });
      await writeFile(temporary, JSON.stringify(data), { flag: "wx" });
      const verified: unknown = JSON.parse(await readFile(temporary, "utf8"));
      assertStaticShape(verified);
      validateTimetable(verified, options.stations, now());
      await rename(temporary, options.path);
      current = verified;
      options.onUpdate(verified);
      lastError = null;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    } finally { await rm(temporary, { force: true }).catch(() => undefined); }
  }
  function check(force = false): Promise<void> {
    if (running) return running;
    const health = status();
    if (!force && ((!health.stale && health.usable) || (lastAttempt !== null && now() - lastAttempt < RETRY))) return Promise.resolve();
    running = perform().finally(() => { running = null; });
    return running;
  }
  return { check, status };
}

