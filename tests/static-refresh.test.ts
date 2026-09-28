import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync, strToU8 } from "fflate";
import { createStaticRefresher, downloadTimetable, validateTimetable } from "../server/static-refresh.ts";
import type { StaticData } from "../server/static.ts";
const NOW = Date.parse("2026-09-28T12:00:00Z");
function archive(overrides: Record<string, string> = {}) {
  const files = {
    "stops.txt": "stop_id,stop_name\n72305,Hospitalet\n71801,Sants\n",
    "routes.txt": "route_id,route_short_name\nr,R1\n",
    "trips.txt": "route_id,service_id,trip_id\nr,s,t\n",
    "stop_times.txt": "trip_id,arrival_time,departure_time,stop_id,stop_sequence\nt,15:48:00,15:48:00,72305,1\nt,15:54:00,15:55:00,71801,2\n",
    "calendar.txt": "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\ns,1,1,1,1,1,1,1,20260901,20261004\n",
    ...overrides,
  };
  return zipSync(Object.fromEntries(Object.entries(files).map(([key, value]) => [key, strToU8(value)])));
}
function fetchArchive(overrides: Record<string, string> = {}): typeof fetch {
  return async () => new Response(Buffer.from(archive(overrides)));
}
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "viaradar-refresh-"));
  const path = join(dir, "static.json");
  const initial = await downloadTimetable("https://fixture.test", ["72305"], NOW - 2 * 86400000, fetchArchive());
  await writeFile(path, JSON.stringify(initial));
  return { dir, path, initial };
}
test("refresh atomically replaces valid data and adopts it without restart, at most daily", async () => {
  const f = await fixture();
  let now = NOW, requests = 0;
  let adopted: StaticData | null = null;
  try {
    const r = createStaticRefresher({ ...f, stations: ["72305"], now: () => now, fetcher: async (...args) => { requests++; return fetchArchive()(...args); }, onUpdate: (data) => { adopted = data; } });
    await r.check();
    assert.equal(requests, 1);
    assert.equal(adopted!.importedAt, new Date(NOW).toISOString());
    assert.deepEqual(JSON.parse(await readFile(f.path, "utf8")), adopted);
    assert.equal(r.status().stale, false);
    assert.equal(r.status().usable, true);
    assert.equal(r.status().validThrough, "20261004");
    await r.check(); assert.equal(requests, 1);
    now += 86400000; await r.check(); assert.equal(requests, 2);
    assert.deepEqual(await readdir(f.dir), ["static.json"]);
  } finally { await rm(f.dir, { recursive: true }); }
});
test("empty, missing station, invalid references and expired schedules retain last-known-good", async () => {
  for (const invalid of [
    { "trips.txt": "route_id,service_id,trip_id\n" },
    { "stops.txt": "stop_id,stop_name\n71801,Sants\n" },
    { "trips.txt": "route_id,service_id,trip_id\nmissing,s,t\n" },
    { "calendar.txt": "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\ns,1,1,1,1,1,1,1,20260901,20260927\n" },
  ] as Record<string, string>[]) {
    const f = await fixture();
    try {
      const before = await readFile(f.path, "utf8");
      const r = createStaticRefresher({ ...f, stations: ["72305"], now: () => NOW, fetcher: fetchArchive(invalid), onUpdate: () => assert.fail("Invalid timetable adopted") });
      await r.check();
      assert.ok(r.status().lastError);
      assert.equal(await readFile(f.path, "utf8"), before);
      assert.equal(r.status().importedAt, f.initial.importedAt);
      assert.deepEqual(await readdir(f.dir), ["static.json"]);
    } finally { await rm(f.dir, { recursive: true }); }
  }
});
test("simultaneous checks share one request and failed downloads back off one hour", async () => {
  const f = await fixture();
  let now = NOW, calls = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  try {
    const r = createStaticRefresher({ ...f, stations: ["72305"], now: () => now, fetcher: async () => { calls++; await held; throw new Error("network unavailable"); }, onUpdate: () => assert.fail() });
    const first = r.check(); assert.equal(r.check(), first); assert.equal(calls, 1);
    release(); await first; assert.match(r.status().lastError!, /network unavailable/);
    await r.check(); assert.equal(calls, 1);
    now += 3600000; await r.check(); assert.equal(calls, 2);
  } finally { await rm(f.dir, { recursive: true }); }
});
test("download timeout passes abort signal and preserves existing file", async () => {
  const f = await fixture();
  try {
    const r = createStaticRefresher({ ...f, stations: ["72305"], now: () => NOW, timeoutMs: 10, fetcher: async (_url, init) => {
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
      init!.signal!.throwIfAborted();
      return new Response("unreachable");
    }, onUpdate: () => assert.fail() });
    await r.check(); assert.match(r.status().lastError!, /timeout/i);
    assert.equal(JSON.parse(await readFile(f.path, "utf8")).importedAt, f.initial.importedAt);
  } finally { await rm(f.dir, { recursive: true }); }
});
test("coverage checks each configured station and reports expiry instead of silent health", async () => {
  const data = await downloadTimetable("https://fixture.test", ["72305"], NOW, fetchArchive());
  assert.throws(() => validateTimetable(data, ["72305", "missing"], NOW));
  const r = createStaticRefresher({ path: "unused", initial: data, stations: ["72305"], now: () => Date.parse("2026-10-05T12:00:00Z"), onUpdate: () => assert.fail() });
  assert.equal(r.status().usable, false);
  assert.equal(r.status().stale, true);
});
test("calendar_dates-only valid GTFS is accepted", async () => {
  const data = await downloadTimetable("https://fixture.test", ["72305"], NOW, fetchArchive({ "calendar.txt": "service_id\n", "calendar_dates.txt": "service_id,date,exception_type\ns,20260928,1\ns,20260929,1\n" }));
  assert.equal(data.trips.length, 1);
});
