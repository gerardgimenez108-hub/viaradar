import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { DeparturesPage } from "./departures-page.ts";
import type { Board, Departure } from "../../server/model.ts";

function fixture(alerts: Board["incidents"]["items"] = []): Board {
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
    incidents: { status: "healthy", fetchedAt: new Date(now).toISOString(), feedTimestamp: new Date(now).toISOString(), error: null, items: alerts },
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

test("Renfe alerts open as accessible localized details and render source text safely", { timeout: 30000 }, async t => {
  const browser = await launch();
  t.after(() => browser.close());
  const context = await browser.newContext({ locale: "es-ES", serviceWorkers: "block" });
  const page = await context.newPage();
  const alerts: Board["incidents"]["items"] = [{
    id: "notice-1",
    translations: [{ language: "es", text: "<img src=x onerror=alert(1)> Ascensor fuera de servicio" }, { language: "en", text: "Lift out of service" }],
    stopIds: ["72305"], lines: ["R1"], activePeriods: [{ start: new Date(Date.now() - 60000).toISOString(), end: null }],
  }];
  const testBoard = fixture(alerts);
  await page.route("**/api/departures?*", route => route.fulfill({ json: testBoard }));
  await new DeparturesPage(page).goto();
  const trigger = page.getByRole("button", { name: "Avisos de Renfe · 1" });
  await trigger.waitFor();
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Información del servicio" });
  await dialog.waitFor();
  assert.match(await dialog.innerText(), /Ascensor fuera de servicio/);
  assert.match(await dialog.innerText(), /L’Hospitalet de Llobregat/);
  assert.match(await dialog.innerText(), /Líneas R1/);
  assert.equal(await dialog.locator("img").count(), 0);
  assert.match(await dialog.innerText(), /Activo desde/);
  await page.getByRole("button", { name: "Cerrar información del servicio" }).click();
  assert.deepEqual(await page.evaluate(() => document.querySelectorAll("[onerror]").length), 0);
  await page.locator("#settings > summary").click();
  await page.getByLabel("Idioma", { exact: true }).selectOption("en");
  const englishTrigger = page.getByRole("button", { name: "Renfe alerts · 1" });
  await englishTrigger.click();
  const englishDialog = page.getByRole("dialog", { name: "Service information" });
  await englishDialog.waitFor();
  assert.match(await englishDialog.innerText(), /Lift out of service/);
  await page.getByRole("button", { name: "Close service information" }).click();
  testBoard.incidents = { status: "stale", fetchedAt: null, feedTimestamp: new Date(Date.now() - 120000).toISOString(), error: null, items: [] };
  await page.getByRole("button", { name: "Refresh departures" }).click();
  await page.getByText("Renfe notices are out of date", { exact: false }).waitFor();
  assert.equal(await page.locator("#incident-trigger").count(), 0);
  await context.close();
});

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
    await page.locator("#settings > summary").click();
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
  await page.locator("#settings > summary").click();
  await page.getByLabel("Idioma", { exact: true }).selectOption("en");
  assert.equal(await page.locator("html").getAttribute("lang"), "en");
  await page.reload();
  await page.getByRole("article").first().waitFor();
  await page.locator("#settings > summary").click();
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

test("Appearance follows device, persists overrides, and highlights only meaningful changes", { timeout: 45000 }, async t => {
  const browser = await launch(); t.after(() => browser.close());
  const context = await browser.newContext({ locale: "es-ES", colorScheme: "dark", serviceWorkers: "block", viewport: { width: 390, height: 844 } });
  const page = await context.newPage(); const board = new DeparturesPage(page);
  const data = fixture();
  await page.route("**/api/departures?*", route => route.fulfill({ json: data }));
  await board.goto(); await board.rows.first().waitFor();
  await page.locator("#settings > summary").click();
  assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
  assert.equal(await page.locator(".beta,.station-symbol").count(), 0);
  assert.equal(await page.locator(".brand-icon").count(), 1);
  assert.equal(await page.locator(".brand-icon").getAttribute("src"), "/icons/viaradar-mark.svg");
  assert.equal(await page.locator("h1").innerText(), "L’Hospitalet de Llobregat");
  assert.equal(await page.locator(".station-identity p").innerText(), "RODALIES DE CATALUNYA · BARCELONA");
  const manifest = await page.evaluate(async () => {
    const href = document.querySelector<HTMLLinkElement>('link[rel="manifest"]')!.href;
    return await (await fetch(href)).json() as { icons: { src: string }[] };
  });
  assert.deepEqual(manifest.icons.map(icon => icon.src), ["/icons/icon-192.png", "/icons/icon-512.png"]);
  assert.equal(await page.evaluate(async () => (await fetch("/icons/viaradar-mark.svg")).status), 200);
  assert.equal(await page.locator(".change-note").count(), 0);
  await page.screenshot({ path: "test-results/redesign-mobile-dark.png", fullPage: true });
  await page.getByLabel("Apariencia", { exact: true }).selectOption("light");
  await page.reload(); await board.rows.first().waitFor();
  await page.locator("#settings > summary").click();
  assert.equal(await page.locator("html").getAttribute("data-theme"), "light");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: "test-results/redesign-desktop-light.png", fullPage: true });
  await page.getByLabel("Apariencia", { exact: true }).selectOption("auto");
  assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
  await page.emulateMedia({ colorScheme: "light" });
  await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
  const refresh = page.getByRole("button", { name: "Actualizar salidas" });
  await refresh.click(); await board.ready();
  assert.equal(await page.locator(".change-note").count(), 0);
  data.departures[2].platform = { ...data.departures[0].platform, value: "8" };
  await refresh.click(); await page.getByText("Vía publicada", { exact: true }).waitFor();
  assert.equal(await page.locator(".change-positive").count(), 1);
  data.departures[0].platform.value = "6";
  await refresh.click(); await page.getByText("Cambio de vía: 4 → 6", { exact: true }).waitFor();
  assert.equal(await page.locator(".change-caution").count(), 1);
  await page.emulateMedia({ reducedMotion: "reduce" });
  assert.equal(await page.locator(".change-caution").evaluate(el => getComputedStyle(el).animationName), "none");
  await page.waitForTimeout(12500);
  assert.equal(await page.locator(".change-note").count(), 0);
  await refresh.click(); await board.ready();
  assert.equal(await page.locator(".change-note").count(), 0);
});
