import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "viaradar-feed-test-"));
const { parseFeed, isFresh, sources, liveFeed } =
  await import("../server/realtime.ts");
const { db, saveSnapshot } = await import("../server/store.ts");
const stamp = 1790112000;

test("Feed parser accepts Renfe camelCase timestamps and empty full snapshots", () => {
  const feed = parseFeed(
    JSON.stringify({
      header: { timestamp: String(stamp) },
      entity: [
        {
          vehicle: {
            trip: { tripId: "R1-trip" },
            stopId: "72305",
            timestamp: String(stamp),
            vehicle: { label: "R1-123-PLATF.(4)" },
          },
        },
      ],
    }),
  );
  assert.equal(feed.entity[0].vehicle?.stopId, "72305");
  assert.deepEqual(
    parseFeed(JSON.stringify({ header: { timestamp: stamp } })).entity,
    [],
  );
});

test("Invalid nested realtime values cannot reach the departure builder", () => {
  const invalid = [
    null,
    { vehicle: { vehicle: { label: 4 } } },
    { tripUpdate: { stopTimeUpdate: {} } },
    { tripUpdate: { stopTimeUpdate: [null] } },
    { tripUpdate: { stopTimeUpdate: [{ departure: { time: "tomorrow" } }] } },
    { vehicle: { trip: { tripId: 12 } } },
  ];
  for (const entity of invalid) {
    assert.throws(() =>
      parseFeed(
        JSON.stringify({ header: { timestamp: stamp }, entity: [entity] }),
      ),
    );
  }
  assert.throws(() => parseFeed("null"));
  assert.throws(() =>
    parseFeed(
      JSON.stringify({
        header: { timestamp: stamp, incrementality: "DIFFERENTIAL" },
      }),
    ),
  );
  assert.equal(isFresh(null, stamp * 1000), false);
});

test("Repeated snapshots are deduplicated and old snapshots expire", () => {
  const body = JSON.stringify({ header: { timestamp: stamp }, entity: [] });
  saveSnapshot("test", body, stamp * 1000, stamp * 1000);
  saveSnapshot("test", body, stamp * 1000, stamp * 1000 + 1000);
  assert.equal(
    db
      .prepare("SELECT COUNT(*) AS count FROM snapshots WHERE kind='test'")
      .get()?.count,
    1,
  );
  saveSnapshot("test", "{}", stamp * 1000, (stamp + 8 * 86400) * 1000);
  assert.equal(
    db
      .prepare("SELECT COUNT(*) AS count FROM snapshots WHERE kind='test'")
      .get()?.count,
    1,
  );
});

test("A successful download never makes an old source timestamp live", () => {
  const source = sources.get("vehicle_positions")!;
  source.status.healthy = true;
  source.feed = { header: { timestamp: stamp - 91 }, entity: [] };
  assert.equal(liveFeed("vehicle_positions", stamp * 1000), null);
  source.feed.header.timestamp = stamp;
  assert.notEqual(liveFeed("vehicle_positions", stamp * 1000), null);
  source.status.healthy = false;
  assert.equal(liveFeed("vehicle_positions", stamp * 1000), null);
});
