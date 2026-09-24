import type { Board } from "../server/model.ts";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function timestamp(value: unknown): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
function strings(value: Record<string, unknown>, fields: string[]): boolean {
  return fields.every((field) => typeof value[field] === "string");
}
export function isBoard(value: unknown): value is Board {
  if (
    !record(value) ||
    !record(value.station) ||
    !strings(value.station, ["id", "name"]) ||
    !timestamp(value.generatedAt) ||
    !(value.staticImportedAt === null || timestamp(value.staticImportedAt)) ||
    !Array.isArray(value.warnings) ||
    !value.warnings.every((item) => typeof item === "string") ||
    !Array.isArray(value.sources) ||
    !Array.isArray(value.departures)
  )
    return false;
  if (
    !value.sources.every(
      (source) =>
        record(source) &&
        strings(source, ["kind", "url"]) &&
        typeof source.healthy === "boolean" &&
        (source.error === null || typeof source.error === "string") &&
        (source.fetchedAt === null || timestamp(source.fetchedAt)) &&
        (source.feedTimestamp === null || timestamp(source.feedTimestamp)),
    )
  )
    return false;
  return value.departures.every((row) => {
    if (
      !record(row) ||
      !strings(row, ["tripId", "serviceDate", "line", "destination"]) ||
      !timestamp(row.scheduledAt) ||
      !timestamp(row.expectedAt) ||
      typeof row.cancelled !== "boolean" ||
      typeof row.realtime !== "boolean" ||
      !record(row.platform)
    )
      return false;
    const platform = row.platform;
    return (
      ["official", "prediction", "unknown"].includes(String(platform.kind)) &&
      (platform.value === null || typeof platform.value === "string") &&
      typeof platform.evidence === "string" &&
      (platform.confidence === null ||
        (typeof platform.confidence === "number" &&
          Number.isFinite(platform.confidence) &&
          platform.confidence >= 0 &&
          platform.confidence <= 1)) &&
      typeof platform.sampleCount === "number" &&
      Number.isInteger(platform.sampleCount) &&
      platform.sampleCount >= 0 &&
      (platform.expiresAt === undefined || timestamp(platform.expiresAt))
    );
  });
}
