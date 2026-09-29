/** Descriptive publication diagnostics, deliberately not a prediction backtest. */
export interface AssignmentSample {
  stationId: string; tripId: string | null; serviceDate: string | null;
  observedAt: number | null; fetchedAt: number; platform: string | null;
  line: string | null; destination: string | null; terminal: number | null; freshness: string;
}
export const READINESS = { minimumServices: 20, minimumDates: 3, minimumShare: 0.8 } as const;

export function evaluateAssignments(samples: readonly AssignmentSample[], asOf: number) {
  if (!Number.isFinite(asOf)) throw new Error("Invalid as-of timestamp");
  const services = new Map<string, AssignmentSample[]>();
  let eligibleEvents = 0;
  for (const row of samples) {
    if (row.freshness !== "fresh" || row.terminal !== 0 || !row.tripId || !row.serviceDate ||
      !row.platform || !row.line || !row.destination || row.observedAt === null ||
      !Number.isFinite(row.observedAt) || !Number.isFinite(row.fetchedAt) ||
      row.observedAt > row.fetchedAt || row.fetchedAt > asOf) continue;
    eligibleEvents++;
    const key = JSON.stringify([row.stationId, row.serviceDate, row.tripId]);
    const history = services.get(key) ?? [];
    history.push(row); services.set(key, history);
  }
  const groups = new Map<string, { stationId: string; line: string; destination: string;
    dates: Set<string>; platforms: Map<string, number>; services: number; changedServices: number }>();
  let conflictingServices = 0;
  for (const history of services.values()) {
    const latestTime = Math.max(...history.map(row => row.observedAt!));
    const latest = history.filter(row => row.observedAt === latestTime);
    // Receptions do not break a tie between contradictory source timestamps.
    if (new Set(latest.map(row => row.platform)).size !== 1 ||
      new Set(history.map(row => JSON.stringify([row.line, row.destination]))).size !== 1) {
      conflictingServices++; continue;
    }
    const row = latest[0];
    const key = JSON.stringify([row.stationId, row.line, row.destination]);
    const group = groups.get(key) ?? { stationId: row.stationId, line: row.line!, destination: row.destination!,
      dates: new Set<string>(), platforms: new Map<string, number>(), services: 0, changedServices: 0 };
    group.services++; group.dates.add(row.serviceDate!);
    group.platforms.set(row.platform!, (group.platforms.get(row.platform!) ?? 0) + 1);
    if (new Set(history.map(event => event.platform)).size > 1) group.changedServices++;
    groups.set(key, group);
  }
  return {
    asOf: new Date(asOf).toISOString(), kind: "assignment-stability-diagnostic",
    target: "latest-observed-published-assignment-not-confirmed-departure",
    productionPredictorChanged: false, predictionAccuracy: null,
    thresholds: READINESS, eligibleEvents, identifiedServices: services.size, conflictingServices,
    groups: [...groups.values()].map(group => {
      const platforms = [...group.platforms].map(([platform, services]) => ({ platform, services }))
        .sort((a, b) => b.services - a.services || a.platform.localeCompare(b.platform));
      const majority = platforms[0];
      const share = majority.services / group.services;
      return { stationId: group.stationId, line: group.line, destination: group.destination,
        services: group.services, dates: [...group.dates].sort(), changedServices: group.changedServices,
        platforms, majorityPlatform: majority.platform, majorityShare: share,
        servicesMissing: Math.max(0, READINESS.minimumServices - group.services),
        datesMissing: Math.max(0, READINESS.minimumDates - group.dates.size),
        meetsDescriptiveGate: group.services >= READINESS.minimumServices &&
          group.dates.size >= READINESS.minimumDates && share >= READINESS.minimumShare };
    }).sort((a, b) => a.stationId.localeCompare(b.stationId) || a.line.localeCompare(b.line) || a.destination.localeCompare(b.destination)),
    limitations: ["Majority share is not held-out accuracy or calibrated confidence.",
      "A missing publication is not a track withdrawal. No physical departure is inferred.",
      "Readiness is descriptive only and never enables production predictions.",
      "No lead-time evaluation: immutable historical schedule features are not available in assignment events."]
  };
}
