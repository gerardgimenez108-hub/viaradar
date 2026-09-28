import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Row } from "./model.ts";
export interface StaticData {
  importedAt: string;
  stops: Row[];
  trips: Row[];
  routes: Row[];
  stopTimes: Row[];
  calendar: Row[];
  exceptions: Row[];
}
export function loadStatic(path = resolve(process.env.DATA_DIR || "data", "static.json")): StaticData | null {
  if (!existsSync(path)) return null;
  try {
    const data: unknown = JSON.parse(readFileSync(path, "utf8"));
    assertStaticShape(data);
    return data;
  } catch (error) {
    console.error("Timetable could not be loaded", error);
    return null;
  }
}
export function assertStaticShape(value: unknown): asserts value is StaticData {
  if (!value || typeof value !== "object") throw new Error("Invalid timetable object");
  const data = value as Record<string, unknown>;
  if (typeof data.importedAt !== "string" || !Number.isFinite(Date.parse(data.importedAt)))
    throw new Error("Invalid timetable import date");
  for (const key of ["stops", "trips", "routes", "stopTimes", "calendar", "exceptions"]) {
    if (!Array.isArray(data[key]) || !(data[key] as unknown[]).every((row) => row && typeof row === "object" && !Array.isArray(row) && Object.values(row).every((field) => typeof field === "string")))
      throw new Error(`Invalid timetable table: ${key}`);
  }
}
