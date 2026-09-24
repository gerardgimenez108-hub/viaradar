import { DateTime } from "luxon";
export const ZONE = "Europe/Madrid";
export function serviceDays(now: number): string[] {
  const local = DateTime.fromMillis(now, { zone: ZONE });
  return [-1, 0, 1].map((delta) =>
    local.plus({ days: delta }).toFormat("yyyyLLdd"),
  );
}
export function gtfsTime(date: string, time: string): number {
  const parts = time.split(":").map(Number);
  if (
    parts.length !== 3 ||
    parts.some((x) => !Number.isFinite(x)) ||
    parts[0]! < 0 ||
    parts[1]! < 0 ||
    parts[1]! > 59 ||
    parts[2]! < 0 ||
    parts[2]! > 59
  )
    return NaN;
  // GTFS service-day origin is noon minus twelve hours, including DST transition days.
  return DateTime.fromFormat(date, "yyyyLLdd", { zone: ZONE })
    .set({ hour: 12 })
    .minus({ hours: 12 })
    .plus({ seconds: parts[0]! * 3600 + parts[1]! * 60 + parts[2]! })
    .toMillis();
}
export function activeService(
  service: string,
  date: string,
  calendar: Map<string, Record<string, string>>,
  exceptions: Map<string, string>,
): boolean {
  const exception = exceptions.get(`${service}:${date}`);
  if (exception) return exception === "1";
  const row = calendar.get(service);
  if (!row || date < row.start_date! || date > row.end_date!) return false;
  const day = DateTime.fromFormat(date, "yyyyLLdd", { zone: ZONE }).weekday;
  return (
    row[
      [
        "monday",
        "tuesday",
        "wednesday",
        "thursday",
        "friday",
        "saturday",
        "sunday",
      ][day - 1]!
    ] === "1"
  );
}
