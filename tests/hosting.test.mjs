import test from "node:test";
import assert from "node:assert/strict";
import { apiBaseUrl, checkHosting } from "../scripts/check-hosting.mjs";

test("Hosting refuses an absent, local, insecure or credential-bearing backend", () => {
  for (const url of [
    undefined,
    "http://api.example.com",
    "https://localhost",
    "https://127.0.0.1",
    "https://10.0.0.1",
    "https://u:p@api.example.com",
    "https://buscando-la-via-h.web.app",
    "https://api.example.com/api",
  ]) {
    assert.throws(() => apiBaseUrl(url));
  }
  assert.equal(
    apiBaseUrl("https://api.example.com/"),
    "https://api.example.com",
  );
});

test("Hosting requires working JSON, no-store and browser CORS for both origins", async () => {
  let count = 0;
  const fetcher = async (url, options) => {
    count++;
    return Response.json(
      url.includes("/health")
        ? { ok: true, timetableLoaded: true }
        : {
            station: { id: "72305" },
            generatedAt: new Date().toISOString(),
            sources: [],
            departures: [],
          },
      {
        headers: {
          "Cache-Control": "no-store",
          "Access-Control-Allow-Origin": options.headers.Origin,
        },
      },
    );
  };
  await checkHosting("https://api.example.com", fetcher);
  assert.equal(count, 4);
  await assert.rejects(
    checkHosting("https://api.example.com", async () => new Response("<html>")),
    /expected JSON/,
  );
  await assert.rejects(
    checkHosting("https://api.example.com", async () => Response.json({})),
    /CORS/,
  );
});
