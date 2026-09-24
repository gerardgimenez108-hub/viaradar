import { pathToFileURL } from "node:url";

export const HOSTING_ORIGINS = [
  "https://buscando-la-via-h.web.app",
  "https://buscando-la-via-h.firebaseapp.com",
];

export function apiBaseUrl(value) {
  if (!value?.trim()) {
    throw new Error("Set VITE_API_BASE_URL in this shell to the deployed HTTPS backend. Hosting alone cannot run the API or collector.");
  }
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("VITE_API_BASE_URL must be an absolute HTTPS URL.");
  }
  const hostname = url.hostname.toLowerCase();
  const local = hostname === "localhost" || hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") || !hostname.includes(".") ||
    /^(?:127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(hostname) ||
    hostname.startsWith("[");
  if (url.protocol !== "https:" || local || url.username || url.password || url.search || url.hash) {
    throw new Error("VITE_API_BASE_URL must be a public HTTPS backend URL without credentials, query, or fragment; localhost/private addresses are not deployable.");
  }
  if (HOSTING_ORIGINS.includes(url.origin)) {
    throw new Error("Firebase Hosting is not this project's API. Configure a separately deployed backend, not the frontend Hosting origin.");
  }
  if (url.pathname.replace(/\/$/, "").endsWith("/api")) {
    throw new Error("VITE_API_BASE_URL must omit the final /api; endpoint paths already include it.");
  }
  return url.href.replace(/\/$/, "");
}

async function readJson(fetcher, url, origin) {
  const response = await fetcher(url, {
    headers: { Accept: "application/json", Origin: origin },
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  if (!response.headers.get("content-type")?.includes("application/json")) {
    throw new Error(`${url}: expected JSON, not a Hosting fallback page.`);
  }
  const allowed = response.headers.get("access-control-allow-origin");
  if (allowed !== origin && allowed !== "*") {
    throw new Error(`${url}: browser CORS does not allow ${origin}.`);
  }
  if (!response.headers.get("cache-control")?.includes("no-store")) {
    throw new Error(`${url}: live API must send Cache-Control: no-store.`);
  }
  return response.json();
}

export async function checkHosting(value, fetcher = fetch) {
  const base = apiBaseUrl(value);
  for (const origin of HOSTING_ORIGINS) {
    const health = await readJson(fetcher, `${base}/api/health`, origin);
    if (!health || health.ok !== true || health.timetableLoaded !== true) {
      throw new Error("Backend is not healthy or the timetable is not imported.");
    }
    const board = await readJson(fetcher, `${base}/api/departures?stationId=72305`, origin);
    if (!board || board.station?.id !== "72305" || !Array.isArray(board.departures) || !Array.isArray(board.sources)) {
      throw new Error("Backend does not return the expected Hospitalet departure-board contract.");
    }
    const age = Date.now() - Date.parse(board.generatedAt);
    if (!Number.isFinite(age) || age < -30000 || age > 90000) {
      throw new Error("Backend board timestamp is missing, stale, or in the future.");
    }
  }
  return base;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const base = await checkHosting(process.env.VITE_API_BASE_URL);
    console.log(`Hosting precondition passed: ${base}. No cloud changes were made by this check.`);
  } catch (error) {
    console.error(`Hosting deployment blocked: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}
