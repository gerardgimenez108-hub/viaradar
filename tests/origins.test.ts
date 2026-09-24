import test from "node:test";
import assert from "node:assert/strict";
import { configuredOrigins } from "../server/origins.ts";

test("Default CORS origins allow local frontend ports and both ViaRadar hosting names", () => {
  const origins = configuredOrigins();
  for (const origin of ["http://localhost:8787", "http://127.0.0.1:8787", "http://localhost:5173", "http://127.0.0.1:5173", "https://viaradar.web.app", "https://viaradar.firebaseapp.com"])
    assert.equal(origins.has(origin), true, origin);
  for (const origin of ["*", "null", "http://localhost:9999", "https://evil.example", "http://localhost.evil.example:8787"])
    assert.equal(origins.has(origin), false, origin);
});

test("Explicit CORS configuration replaces defaults without expanding access", () => {
  assert.deepEqual([...configuredOrigins(" https://example.test, ,https://example.test ")], ["https://example.test"]);
});
