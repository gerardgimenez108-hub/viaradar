import type { Platform, EvidenceCode } from "./model.ts";
export interface TrainingObservation {
  serviceDate: string;
  tripId: string;
  stationId: string;
  line: string;
  destination: string;
  platform: string;
  observedAt: number;
}
export interface PredictionContext {
  serviceDate: string;
  tripId: string;
  stationId: string;
  line: string;
  destination: string;
  now: number;
}
export interface PredictionEngine {
  id: string;
  predict(
    context: PredictionContext,
    observations: TrainingObservation[],
  ): Platform;
}
export function unknownPlatform(
  reason = "No published platform and not enough historical evidence",
  evidenceCode: EvidenceCode = "insufficient_history",
): Platform {
  return {
    kind: "unknown",
    value: null,
    confidence: null,
    sampleCount: 0,
    evidence: reason,
    evidenceCode,
  };
}
export const historicalEngine: PredictionEngine = {
  id: "historical-frequency-v1",
  predict(context, observations) {
    const unique = new Map<string, TrainingObservation>();
    for (const row of observations)
      if (
        row.serviceDate < context.serviceDate &&
        row.observedAt < context.now &&
        row.stationId === context.stationId &&
        row.line === context.line &&
        row.destination === context.destination
      )
        unique.set(`${row.serviceDate}:${row.tripId}:${row.stationId}`, row);
    const rows = [...unique.values()];
    if (
      rows.length < 20 ||
      new Set(rows.map((row) => row.serviceDate)).size < 3
    )
      return unknownPlatform();
    const counts = new Map<string, number>();
    for (const row of rows)
      counts.set(row.platform, (counts.get(row.platform) || 0) + 1);
    const winner = [...counts].sort((a, b) => b[1] - a[1])[0]!;
    const support = winner[1] / rows.length;
    if (support < 0.8)
      return unknownPlatform(
        "Historical platforms are too variable to estimate",
        "variable_history",
      );
    return {
      kind: "prediction",
      evidenceCode: "historical_share",
      value: winner[0],
      confidence: support,
      sampleCount: rows.length,
      evidence: `Historical share, not calibrated probability: ${winner[1]} of ${rows.length} earlier services. Check station announcements.`,
    };
  },
};
