import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StaticData } from "../server/static.ts";
import type { Vehicle } from "../server/model.ts";
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "viaradar-continuity-"));
const { db } = await import("../server/store.ts");
const { createBoard } = await import("../server/board.ts");
const { sources } = await import("../server/realtime.ts");
const { captureAssignments } = await import("../server/assignments.ts");
const { measurePredictionBoard } = await import("../server/measurement.ts");
const { isBoard } = await import("../src/board-contract.ts");
const now = Date.parse("2026-09-28T13:55:00Z");
const published = Date.parse("2026-09-28T13:48:07Z");
const data: StaticData = {
  importedAt: "2026-09-24T17:03:05.825Z", stops: [{stop_id:"72305",stop_name:"Hospitalet"}],
  trips:[{trip_id:"5169L25651R1",service_id:"weekday",route_id:"R1",trip_headsign:"Maçanet-Massanes"}],
  routes:[{route_id:"R1",route_short_name:"R1"}],
  stopTimes:[{trip_id:"5169L25651R1",stop_id:"72305",stop_sequence:"1",departure_time:"15:48:00"},
    {trip_id:"5169L25651R1",stop_id:"71801",stop_sequence:"2",departure_time:"15:55:00"}],
  calendar:[{service_id:"weekday",start_date:"20260928",end_date:"20260928",monday:"1"}],exceptions:[],
};
const vehicle: Vehicle = {trip:{tripId:"5169L25651R1",startDate:"20260928"},vehicle:{id:"train-1",label:"R1-25651"},
  stopId:"72305",timestamp:now/1000,currentStatus:"STOPPED_AT"};
function seed(at=published) {
  db.exec("DELETE FROM assignment_events; DELETE FROM observations; DELETE FROM prediction_attempts; DELETE FROM prediction_official_seen;");
  captureAssignments(db,{header:{timestamp:at/1000},entity:[{vehicle:{...vehicle,timestamp:at/1000,currentStatus:"INCOMING_AT",
    vehicle:{id:"train-1",label:"R1-25651-PLATF.(13)"}}}]},data,["72305"],at);
}
function current(v=vehicle, at=now, cancelled=false) {
  for (const [kind,source] of sources) {
    source.status.healthy=true;source.status.feedTimestamp=new Date(at).toISOString();
    source.feed={header:{timestamp:at/1000},entity:kind==="vehicle_positions"?[{vehicle:v}]:cancelled?
      [{tripUpdate:{trip:{tripId:v.trip!.tripId,startDate:"20260928",scheduleRelationship:"CANCELED"}}}]:[]};
  }
  return createBoard(data,"72305",at);
}
test("15:55 screenshot case preserves track 13 as unconfirmed, without official labels",()=>{
  seed(); const board=current(); const row=board.departures[0];
  assert.equal(row?.lastPublishedPlatform?.value,"13");
  assert.equal(row.lastPublishedPlatform.observedAt,"2026-09-28T13:48:07.000Z");
  assert.equal(row.platform.kind,"unknown");
  assert.equal(db.prepare("SELECT count(*) n FROM observations").get()?.n,0);
  assert.equal(isBoard(board),true);
  assert.equal(isBoard({...board,departures:[{...row,lastPublishedPlatform:{...row.lastPublishedPlatform,value:"<script>"}}]}),false);
});
test("Continuity rejects wrong identity/date/station, stale/future evidence, malformed labels, cancellation and expiry",()=>{
  seed();
  for (const v of [ {...vehicle,vehicle:{id:"other",label:"R1-25651"}},
    {...vehicle,trip:{...vehicle.trip,startDate:"20260927"}}, {...vehicle,stopId:"71801"},
    {...vehicle,timestamp:now/1000-91}, {...vehicle,timestamp:now/1000+1},
    {...vehicle,vehicle:{id:"train-1",label:"PLATF.(?)"}}, {...vehicle,vehicle:{label:"R1-25651"}}]) {
    assert.equal(current(v).departures[0]?.lastPublishedPlatform,undefined);
  }
  assert.equal(current(vehicle,now,true).departures[0]?.lastPublishedPlatform,undefined);
  const late=published+900001;
  assert.equal(current({...vehicle,timestamp:late/1000},late).departures[0]?.lastPublishedPlatform,undefined);
  for (const invalid of ["future","stale","malformed_timestamp"]) {
    db.prepare("UPDATE assignment_events SET freshness=?").run(invalid);
    assert.equal(current().departures[0]?.lastPublishedPlatform,undefined);
  }
  seed(); sources.get("vehicle_positions")!.status.healthy=false;
  assert.equal(createBoard(data,"72305",now).departures[0]?.lastPublishedPlatform,undefined);
});
test("New official publication overrides previous platform; last publication never becomes a prediction checkpoint",()=>{
  seed(); assert.equal(current({...vehicle,vehicle:{id:"train-1",label:"R1-PLATF.(11)"}}).departures[0]?.lastPublishedPlatform,undefined);
  assert.equal(current({...vehicle,vehicle:{id:"train-1",label:"R1-PLATF.(11)"}}).departures[0]?.platform.value,"11");
  const early=Date.parse("2026-09-28T13:45:00Z");seed(early-60000);
  const board=current({...vehicle,timestamp:early/1000},early);
  assert.equal(board.departures[0]?.lastPublishedPlatform?.value,"13");
  measurePredictionBoard(db,board,early);
  assert.equal(db.prepare("SELECT count(*) n FROM prediction_attempts").get()?.n,0);
  assert.equal(db.prepare("SELECT count(*) n FROM observations").get()?.n,0);
});
