import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "./store.ts";
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
export function loadStatic(): StaticData | null {
  const path = join(dataDir, "static.json");
  return existsSync(path)
    ? (JSON.parse(readFileSync(path, "utf8")) as StaticData)
    : null;
}
