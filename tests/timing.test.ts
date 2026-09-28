import test from "node:test";
import assert from "node:assert/strict";
import type { Row, TripUpdate } from "../server/model.ts";
import { reliableGenericDelay, TIMING_REJECTION } from "../server/timing.ts";
import { gtfsTime } from "../server/time.ts";

const date = "20260928";
const tripId = "5169L25651R1";
const stops: Row[] = [
  { trip_id: tripId, stop_id: "72305", stop_sequence: "001", arrival_time: "15:48:00", departure_time: "15:48:00" },
  { trip_id: tripId, stop_id: "71801", stop_sequence: "002", arrival_time: "15:54:00", departure_time: "15:55:00" },
];
function update(delay = 13080, time: number | string = "1790603640"): TripUpdate {
  return { trip: { tripId }, delay, stopTimeUpdate: [
    { stopId: "71801", arrival: { delay, time } },
  ] };
}

test("Maçanet 15:48 rejects contradictory 218-minute trip delay instead of hiding train", () => {
  assert.equal(gtfsTime(date, "15:54:00") / 1000, 1790603640);
  assert.deepEqual(reliableGenericDelay(update(), stops, date), {
    delay: undefined, rejection: TIMING_REJECTION.CONTRADICTORY_EVENT,
  });
});

test("consistent large delays remain valid with no arbitrary cap", () => {
  assert.deepEqual(reliableGenericDelay(update(13080, 1790603640 + 13080), stops, date), { delay: 13080 });
  assert.deepEqual(reliableGenericDelay(update(-60, 1790603640 - 60), stops, date), { delay: -60 });
});

test("looped stop without sequence is ambiguous and cannot reject generic delay", () => {
  const loop = [...stops, { ...stops[1], stop_sequence: "005", arrival_time: "16:54:00" }];
  assert.deepEqual(reliableGenericDelay(update(), loop, date), { delay: 13080 });
  const sequenced = update();
  sequenced.stopTimeUpdate![0].stopSequence = 2;
  assert.equal(reliableGenericDelay(sequenced, loop, date).rejection, TIMING_REJECTION.CONTRADICTORY_EVENT);
});

test("sequence-only matching works while conflicting stop and sequence cannot match", () => {
  const sequenced = update();
  sequenced.stopTimeUpdate![0] = { stopSequence: 2, arrival: { time: 1790603640, delay: 13080 } };
  assert.equal(reliableGenericDelay(sequenced, stops, date).rejection, TIMING_REJECTION.CONTRADICTORY_EVENT);
  sequenced.stopTimeUpdate![0].stopId = "72305";
  assert.deepEqual(reliableGenericDelay(sequenced, stops, date), { delay: 13080 });
});

test("after-midnight GTFS time uses original service date", () => {
  const overnight = [{ ...stops[1], arrival_time: "25:54:00" }];
  const time = gtfsTime(date, "25:54:00") / 1000;
  assert.deepEqual(reliableGenericDelay(update(600, time + 600), overnight, date), { delay: 600 });
  assert.equal(reliableGenericDelay(update(600, time), overnight, date).rejection, TIMING_REJECTION.CONTRADICTORY_EVENT);
});

test("arrival and departure compare against their own scheduled time", () => {
  const departure = update(60);
  departure.stopTimeUpdate = [{ stopId: "71801", departure: { time: 1790603760, delay: 60 } }];
  assert.deepEqual(reliableGenericDelay(departure, stops, date), { delay: 60 });
});

test("incomplete evidence does not invent contradictions or mutate station times", () => {
  const source = update();
  delete source.stopTimeUpdate![0].arrival!.delay;
  const before = JSON.stringify(source);
  assert.deepEqual(reliableGenericDelay(source, stops, date), { delay: 13080 });
  assert.equal(JSON.stringify(source), before);
  assert.deepEqual(reliableGenericDelay(undefined, stops, date), { delay: undefined });
  assert.deepEqual(reliableGenericDelay({ delay: 60 }, stops, date), { delay: 60 });
});

test("mismatched service date is not extrapolated and unrelated trips are ignored", () => {
  const source = update();
  source.trip!.startDate = "20260927";
  assert.deepEqual(reliableGenericDelay(source, stops, date), { delay: undefined });
  delete source.trip!.startDate;
  assert.deepEqual(reliableGenericDelay(source, stops.map((stop) => ({ ...stop, trip_id: "another" })), date), { delay: 13080 });
});

test("no-data and skipped stop updates do not supply a comparable event", () => {
  for (const relationship of ["NO_DATA", "SKIPPED", 1, 2]) {
    const source = update();
    source.stopTimeUpdate![0].scheduleRelationship = relationship;
    assert.deepEqual(reliableGenericDelay(source, stops, date), { delay: 13080 });
  }
});
