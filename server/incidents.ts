import type { Incident, IncidentBoard, IncidentTranslation } from "./model.ts";
import type { StaticData } from "./static.ts";
import { saveSnapshot } from "./store.ts";

const URL = "https://gtfsrt.renfe.com/alerts.json";
const MAX_AGE_SECONDS = 90;
export interface FeedAlert {
  id: string;
  alert: {
    activePeriod?: { start?: string | number; end?: string | number }[];
    informedEntity?: { stopId?: string; routeId?: string }[];
    descriptionText?: { translation?: { text?: string; language?: string }[] };
  };
}
export interface AlertsFeed { header: { timestamp: string | number }; entity: FeedAlert[]; }
let feed: AlertsFeed | null = null;
let fetchedAt: string | null = null;
let feedTimestamp: string | null = null;
let error: string | null = "Waiting for first collection";
const stationRoutes = new WeakMap<StaticData, Map<string, Map<string, string>>>();

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function numericTimestamp(value: unknown): number | null {
  if ((typeof value !== "number" && typeof value !== "string") || String(value).trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 && number <= 8640000000000 ? number : null;
}
export function parseAlertsFeed(body: string): AlertsFeed {
  const value: unknown = JSON.parse(body);
  if (!record(value) || !record(value.header) || numericTimestamp(value.header.timestamp) === null || !Array.isArray(value.entity))
    throw new Error("Invalid Renfe alerts feed");
  const entity: FeedAlert[] = [];
  for (const raw of value.entity) {
    if (!record(raw) || typeof raw.id !== "string" || !record(raw.alert)) throw new Error("Invalid Renfe alert entity");
    const alert = raw.alert;
    if (alert.activePeriod !== undefined && (!Array.isArray(alert.activePeriod) || !alert.activePeriod.every((period) =>
      record(period) && (period.start === undefined || numericTimestamp(period.start) !== null) && (period.end === undefined || numericTimestamp(period.end) !== null))))
      throw new Error("Invalid Renfe alert active period");
    if (alert.informedEntity !== undefined && (!Array.isArray(alert.informedEntity) || !alert.informedEntity.every((target) =>
      record(target) && (target.stopId === undefined || typeof target.stopId === "string") && (target.routeId === undefined || typeof target.routeId === "string"))))
      throw new Error("Invalid Renfe alert informed entity");
    const translations = alert.descriptionText === undefined ? undefined : alert.descriptionText;
    if (translations !== undefined && (!record(translations) || (translations.translation !== undefined && (!Array.isArray(translations.translation) || !translations.translation.every((item) =>
      record(item) && (item.text === undefined || typeof item.text === "string") && (item.language === undefined || typeof item.language === "string"))))))
      throw new Error("Invalid Renfe alert description");
    entity.push(raw as unknown as FeedAlert);
  }
  return { header: value.header as AlertsFeed["header"], entity };
}

export async function collectIncidents(now = Date.now()): Promise<void> {
  try {
    const response = await fetch(URL, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.text();
    const parsed = parseAlertsFeed(body);
    const stamp = Number(parsed.header.timestamp) * 1000;
    saveSnapshot("alerts", body, stamp, now);
    feed = parsed;
    fetchedAt = new Date(now).toISOString();
    feedTimestamp = new Date(stamp).toISOString();
    error = isFresh(parsed.header.timestamp, now) ? null : "Upstream timestamp is stale";
  } catch (cause) {
    error = cause instanceof Error ? cause.message : "Renfe alerts unavailable";
  }
}

function isFresh(timestamp: unknown, now: number): boolean {
  const seconds = numericTimestamp(timestamp);
  if (seconds === null) return false;
  const age = now / 1000 - seconds;
  return age >= -30 && age <= MAX_AGE_SECONDS;
}
function active(alert: FeedAlert["alert"], now: number): boolean {
  if (!alert.activePeriod?.length) return true;
  return alert.activePeriod.some((period) => {
    const start = period.start === undefined ? null : numericTimestamp(period.start);
    const end = period.end === undefined ? null : numericTimestamp(period.end);
    return (start !== null || period.start === undefined) && (end !== null || period.end === undefined) &&
      (start === null || start * 1000 <= now) && (end === null || end * 1000 >= now);
  });
}
function translations(alert: FeedAlert["alert"]): IncidentTranslation[] {
  return (alert.descriptionText?.translation ?? [])
    .filter((item): item is { text: string; language?: string } => typeof item.text === "string" && item.text.trim().length > 0)
    .map(({ text, language }) => ({ text, ...(language ? { language } : {}) }));
}

export function selectRelevantIncidents(source: AlertsFeed, data: StaticData, stationId: string, now = Date.now()): Incident[] {
  let byStation = stationRoutes.get(data);
  if (!byStation) {
    const lineByRoute = new Map(data.routes.filter((route) => route.route_id && (route.route_short_name === "R1" || route.route_short_name === "R4")).map((route) => [route.route_id!, route.route_short_name!]));
    const routeByTrip = new Map(data.trips.filter((trip) => trip.trip_id && trip.route_id).map((trip) => [trip.trip_id!, trip.route_id!]));
    byStation = new Map();
    for (const stop of data.stopTimes) {
      const routeId = stop.trip_id ? routeByTrip.get(stop.trip_id) : undefined;
      const line = routeId ? lineByRoute.get(routeId) : undefined;
      if (!line || !stop.stop_id || !routeId) continue;
      let routes = byStation.get(stop.stop_id);
      if (!routes) { routes = new Map(); byStation.set(stop.stop_id, routes); }
      routes.set(routeId, line);
    }
    stationRoutes.set(data, byStation);
  }
  const stationRouteIds = byStation.get(stationId) ?? new Map<string, string>();
  const items: Incident[] = [];
  for (const entity of source.entity) {
    if (!active(entity.alert, now)) continue;
    const informed = entity.alert.informedEntity ?? [];
    const stopIds = [...new Set(informed.filter((target) => target.stopId === stationId).map((target) => target.stopId!))];
    const lines = [...new Set(informed.flatMap((target) => {
      const line = target.routeId ? stationRouteIds.get(target.routeId) : undefined;
      return line ? [line] : [];
    }))];
    if (!stopIds.length && !lines.length) continue;
    const message = translations(entity.alert);
    if (!message.length) continue;
    const periods = (entity.alert.activePeriod ?? []).map((period) => ({
      start: period.start === undefined ? null : new Date(Number(period.start) * 1000).toISOString(),
      end: period.end === undefined ? null : new Date(Number(period.end) * 1000).toISOString(),
    }));
    items.push({ id: entity.id, translations: message, stopIds, lines, activePeriods: periods });
  }
  return items;
}

export function incidentBoardFromFeed(source: AlertsFeed | null, sourceError: string | null, fetched: string | null, stamp: string | null, data: StaticData | null, stationId: string, now = Date.now()): IncidentBoard {
  const fresh = !!source && isFresh(source.header.timestamp, now) && !sourceError;
  const status: IncidentBoard["status"] = fresh ? "healthy" : source ? "stale" : "unavailable";
  if (!fresh || !data) return { status: data ? status : "unavailable", fetchedAt: fetched, feedTimestamp: stamp, error: sourceError ?? (data ? null : "Timetable unavailable"), items: [] };
  return { status: "healthy", fetchedAt: fetched, feedTimestamp: stamp, error: null, items: selectRelevantIncidents(source, data, stationId, now) };
}
export function incidentsForStation(data: StaticData | null, stationId: string, now = Date.now()): IncidentBoard {
  return incidentBoardFromFeed(feed, error, fetchedAt, feedTimestamp, data, stationId, now);
}
