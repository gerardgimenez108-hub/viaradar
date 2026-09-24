import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { DeparturesPage } from "./departures-page.ts";
import type { Board, Departure } from "../../server/model.ts";

function fixture(): Board {
  const now = Date.now();
  const base = {
    serviceDate: "20260924",
    line: "R1",
    destination: "Synthetic test destination",
    scheduledAt: new Date(now + 600000).toISOString(),
    expectedAt: new Date(now + 900000).toISOString(),
    cancelled: false,
    realtime: true,
  };
  const departures: Departure[] = [
    {
      ...base,
      tripId: "TEST-OFFICIAL",
      platform: {
        kind: "official",
        value: "4",
        confidence: null,
        sampleCount: 0,
        evidence: "Synthetic published evidence",
        expiresAt: new Date(now + 90000).toISOString(),
      },
    },
    {
      ...base,
      tripId: "TEST-PREDICTION",
      platform: {
        kind: "prediction",
        value: "7",
        confidence: 0.85,
        sampleCount: 40,
        evidence: "Uncalibrated historical share",
      },
    },
    {
      ...base,
      tripId: "TEST-UNKNOWN",
      platform: {
        kind: "unknown",
        value: null,
        confidence: null,
        sampleCount: 0,
        evidence: "Insufficient observations",
      },
    },
    {
      ...base,
      tripId: "TEST-CANCELLED",
      line: "R4",
      cancelled: true,
      platform: {
        kind: "unknown",
        value: null,
        confidence: null,
        sampleCount: 0,
        evidence: "Cancelled service",
      },
    },
  ];
  return {
    station: { id: "72305", name: "Hospitalet" },
    generatedAt: new Date(now).toISOString(),
    staticImportedAt: new Date(now).toISOString(),
    warnings: [],
    departures,
    sources: ["vehicle_positions", "trip_updates"].map((kind) => ({
      kind,
      url: "https://example.invalid",
      fetchedAt: new Date(now).toISOString(),
      feedTimestamp: new Date(now).toISOString(),
      healthy: true,
      error: null,
      ageSeconds: 0,
    })),
  };
}
const launch = () =>
  chromium.launch({
    channel:
      process.env.BROWSER_CHANNEL ||
      (process.platform === "win32" ? "msedge" : undefined),
    headless: true,
  });

test(
  "Departure states, mobile controls, and offline cancellation evidence",
  { timeout: 30000 },
  async (t) => {
    const browser = await launch();
    t.after(() => browser.close());
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { width: 390, height: 844 },
    });
    const page = await context.newPage();
    const board = new DeparturesPage(page);
    await page.route("**/api/departures?*", (route) =>
      route.fulfill({ json: fixture() }),
    );
    await board.goto();
    await board.rows.first().waitFor();
    assert.equal(await board.rows.count(), 4);
    assert.equal(await page.locator(".platform.official").count(), 1);
    assert.match(
      await page.locator(".platform.prediction").innerText(),
      /85% historical share/,
    );
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    await board.line.selectOption("R4");
    assert.equal(await board.rows.count(), 1);
    await board.line.selectOption("");
    await page.getByRole("button", { name: "Install app" }).click();
    assert.equal(await page.getByRole("dialog").isVisible(), true);
    await page.getByRole("button", { name: "Got it" }).click();
    await page.setViewportSize({ width: 1440, height: 1000 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    await context.setOffline(true);
    await page.waitForFunction(
      () =>
        document.querySelectorAll(".platform.official, .platform.prediction")
          .length === 0,
    );
    assert.doesNotMatch(
      await page.locator("#departures").innerText(),
      /min · live|Live estimate|Updated departure time/,
    );
    assert.match(
      await page.locator("#departures").innerText(),
      /Previously cancelled/,
    );
  },
);

test(
  "Malformed API response is a recoverable error, not a blank page",
  { timeout: 30000 },
  async (t) => {
    const browser = await launch();
    t.after(() => browser.close());
    const page = await browser.newPage({ serviceWorkers: "block", locale: "en-US" });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    for (const payload of [
      {},
      { ...fixture(), departures: [null] },
      { ...fixture(), sources: [null] },
    ]) {
      await page.unroute("**/api/departures?*");
      await page.route("**/api/departures?*", (route) =>
        route.fulfill({ json: payload }),
      );
      await new DeparturesPage(page).goto();
      await page
        .getByText("The live board is unavailable", { exact: true })
        .waitFor();
    }
    assert.deepEqual(errors, []);
  },
);

test(
  "First-visit offline PWA shell has assets but no cached live trains",
  { timeout: 30000 },
  async (t) => {
    const browser = await launch();
    t.after(() => browser.close());
    const context = await browser.newContext({ locale: "en-US" });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await new DeparturesPage(page).goto();
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    const urls = await page.evaluate(async () => {
      const names = await caches.keys();
      return (
        await Promise.all(
          names.map(async (name) =>
            (await (await caches.open(name)).keys()).map((r) => r.url),
          ),
        )
      ).flat();
    });
    assert.ok(urls.some((url) => /\/assets\/.*\.js$/.test(url)));
    assert.ok(urls.some((url) => /\/assets\/.*\.css$/.test(url)));
    assert.ok(!urls.some((url) => url.includes("/api/")));
    await context.setOffline(true);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page
      .getByText("The live board is unavailable", { exact: true })
      .waitFor();
    assert.equal(await page.getByRole("article").count(), 0);
    assert.deepEqual(errors, []);
  },
);

test("Device language selects Spanish or English with an explicit fallback", { timeout: 45000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  for (const [locale, expected] of [["es-ES", "es"], ["es-AR", "es"], ["en-US", "en"], ["fr-FR", "en"]]) {
    const context = await browser.newContext({ locale, serviceWorkers: "block", viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await page.route("**/api/departures?*", route => route.fulfill({ json: fixture() }));
    await new DeparturesPage(page).goto();
    await page.getByRole("article").first().waitFor();
    assert.equal(await page.locator("html").getAttribute("lang"), expected);
    assert.equal(await page.getByRole("combobox", { name: expected === "es" ? "Idioma" : "Language", exact: true }).inputValue(), "auto");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    if (expected === "es") {
      assert.doesNotMatch(await page.locator("body").innerText(), /Next three hours|Not published|Source details|Install app|Last checked/);
      await page.locator(".evidence summary").first().click();
      assert.doesNotMatch(await page.locator(".evidence").first().innerText(), /Synthetic published evidence|Service /);
    }
    await context.close();
  }
});

test("Manual language persists and automatic mode follows languagechange", { timeout: 30000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const context = await browser.newContext({ locale: "es-ES", serviceWorkers: "block" });
  const page = await context.newPage();
  await page.route("**/api/departures?*", route => route.fulfill({ json: fixture() }));
  await new DeparturesPage(page).goto();
  await page.getByRole("article").first().waitFor();
  await page.getByLabel("Idioma", { exact: true }).selectOption("en");
  assert.equal(await page.locator("html").getAttribute("lang"), "en");
  await page.reload();
  await page.getByRole("article").first().waitFor();
  assert.equal(await page.locator("html").getAttribute("lang"), "en");
  await page.getByLabel("Language", { exact: true }).selectOption("auto");
  assert.equal(await page.locator("html").getAttribute("lang"), "es");
  assert.equal(await page.evaluate(() => localStorage.getItem("viaradar.language")), null);
  await page.evaluate(() => {
    Object.defineProperty(navigator, "languages", { value: ["fr-FR", "en-GB"], configurable: true });
    window.dispatchEvent(new Event("languagechange"));
  });
  assert.equal(await page.locator("html").getAttribute("lang"), "en");
  await page.getByLabel("Language", { exact: true }).selectOption("es");
  await page.evaluate(() => window.dispatchEvent(new Event("languagechange")));
  assert.equal(await page.locator("html").getAttribute("lang"), "es");
  await context.setOffline(true);
  await page.waitForFunction(() => document.querySelectorAll(".platform.official, .platform.prediction").length === 0);
  assert.doesNotMatch(await page.locator("body").innerText(), /Offline or update failed|Previously cancelled|Updated departure time/);
});
