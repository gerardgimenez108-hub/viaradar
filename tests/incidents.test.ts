import test from "node:test";
import assert from "node:assert/strict";
import { parseAlertsFeed, selectRelevantIncidents, incidentBoardFromFeed } from "../server/incidents.ts";
import type { StaticData } from "../server/static.ts";

const now = Date.parse("2026-09-24T10:00:00Z");
const seconds = (iso: string) => String(Date.parse(iso) / 1000);
const data: StaticData = {
  importedAt: new Date(now).toISOString(),
  stops: [{ stop_id: "72305", stop_name: "L'Hospitalet" }, { stop_id: "end", stop_name: "Destination" }],
  routes: [
    { route_id: "r1-forward", route_short_name: "R1" },
    { route_id: "r4-forward", route_short_name: "R4" },
    { route_id: "r2", route_short_name: "R2" },
  ],
  trips: [
    { trip_id: "t1", route_id: "r1-forward" },
    { trip_id: "t4", route_id: "r4-forward" },
    { trip_id: "t2", route_id: "r2" },
  ],
  stopTimes: [
    { trip_id: "t1", stop_id: "72305" },
    { trip_id: "t4", stop_id: "72305" },
    { trip_id: "t2", stop_id: "72305" },
  ],
  calendar: [], exceptions: [],
};
const feedFixture = {
  header: { timestamp: seconds("2026-09-24T09:59:50Z") },
  entity: [
    { id: "station", alert: { activePeriod: [{ start: seconds("2026-09-24T09:00:00Z") }], informedEntity: [{ stopId: "72305" }], descriptionText: { translation: [{ language: "es", text: "<img src=x onerror=alert(1)> Ascensor fuera de servicio" }, { language: "en", text: "Lift out of service" }] } } },
    { id: "line-r1", alert: { activePeriod: [{ start: seconds("2026-09-24T09:00:00Z"), end: seconds("2026-09-24T11:00:00Z") }], informedEntity: [{ routeId: "r1-forward" }], descriptionText: { translation: [{ language: "es", text: "Aviso R1" }] } } },
    { id: "line-r4", alert: { informedEntity: [{ routeId: "r4-forward" }], descriptionText: { translation: [{ text: "Aviso R4" }] } } },
    { id: "expired", alert: { activePeriod: [{ start: seconds("2026-09-24T08:00:00Z"), end: seconds("2026-09-24T09:00:00Z") }], informedEntity: [{ stopId: "72305" }], descriptionText: { translation: [{ text: "Expired" }] } } },
    { id: "future", alert: { activePeriod: [{ start: seconds("2026-09-24T11:00:00Z") }], informedEntity: [{ stopId: "72305" }], descriptionText: { translation: [{ text: "Not active yet" }] } } },
    { id: "other-line", alert: { informedEntity: [{ routeId: "r2" }], descriptionText: { translation: [{ text: "Out of scope" }] } } },
    { id: "other-stop", alert: { informedEntity: [{ stopId: "99999" }], descriptionText: { translation: [{ text: "Other station" }] } } },
  ],
};

test("parses Renfe alerts feed and rejects invalid structures", () => {
  const parsed = parseAlertsFeed(JSON.stringify(feedFixture));
  assert.equal(parsed.entity.length, 7);
  assert.throws(() => parseAlertsFeed("{}"), /Invalid Renfe alerts feed/);
  assert.throws(() => parseAlertsFeed(JSON.stringify({ ...feedFixture, entity: [{ id: "bad", alert: { activePeriod: [{ start: "bad" }] } }] })), /active period/);
});

test("filters active station notices and R1/R4 notices mapped from station GTFS", () => {
  const parsed = parseAlertsFeed(JSON.stringify(feedFixture));
  const items = selectRelevantIncidents(parsed, data, "72305", now);
  assert.deepEqual(items.map((item) => item.id), ["station", "line-r1", "line-r4"]);
  assert.deepEqual(items[0]?.stopIds, ["72305"]);
  assert.deepEqual(items[1]?.lines, ["R1"]);
  assert.deepEqual(items[2]?.lines, ["R4"]);
  assert.match(items[0]?.translations[0]?.text ?? "", /<img/);
});

test("marks stale or unavailable alert sources and does not expose stale messages", () => {
  const parsed = parseAlertsFeed(JSON.stringify(feedFixture));
  const oldTimestamp = seconds("2026-09-24T09:50:00Z");
  const stale = incidentBoardFromFeed({ ...parsed, header: { timestamp: oldTimestamp } }, null, null, new Date(Number(oldTimestamp) * 1000).toISOString(), data, "72305", now);
  assert.equal(stale.status, "stale");
  assert.equal(stale.items.length, 0);
  assert.equal(stale.error, null);
  const unavailable = incidentBoardFromFeed(null, "HTTP 503", null, null, data, "72305", now);
  assert.equal(unavailable.status, "unavailable");
  assert.equal(unavailable.error, "HTTP 503");
  assert.deepEqual(unavailable.items, []);
});
