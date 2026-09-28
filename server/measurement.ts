import type { DatabaseSync } from "node:sqlite";
import type { Board } from "./model.ts";
import { historicalEngine } from "./prediction.ts";

const DAY = 86400000;
const LABEL_WINDOW = 6 * 3600000;
export function initializePredictionMeasurement(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS prediction_official_seen (
      service_date TEXT NOT NULL, trip_id TEXT NOT NULL, station_id TEXT NOT NULL,
      seen_at INTEGER NOT NULL, PRIMARY KEY(service_date,trip_id,station_id));
    CREATE TABLE IF NOT EXISTS prediction_attempts (
      service_date TEXT NOT NULL, trip_id TEXT NOT NULL, station_id TEXT NOT NULL,
      engine_id TEXT NOT NULL, line TEXT NOT NULL, destination TEXT NOT NULL,
      evaluated_at INTEGER NOT NULL, scheduled_at INTEGER NOT NULL, expected_at INTEGER NOT NULL,
      predicted_platform TEXT, historical_share REAL, sample_count INTEGER NOT NULL,
      evidence_code TEXT, scheduled_lead_seconds REAL NOT NULL, expected_lead_seconds REAL NOT NULL,
      outcome_platform TEXT, outcome_at INTEGER, resolved_at INTEGER, unevaluable_reason TEXT,
      PRIMARY KEY(service_date,trip_id,station_id,engine_id));
    CREATE INDEX IF NOT EXISTS prediction_attempts_station_time ON prediction_attempts(station_id,evaluated_at);
  `);
}

// One first eligible collector checkpoint, never a retrospective replay or an API-read side effect.
export function measurePredictionBoard(db: DatabaseSync, board: Board, now = Date.now()): void {
  const station = board.station.id;
  db.prepare("DELETE FROM prediction_attempts WHERE evaluated_at < ?").run(now - 90 * DAY);
  db.prepare("DELETE FROM prediction_official_seen WHERE seen_at < ?").run(now - 90 * DAY);
  const freshSource = (kind: string) => board.sources.some(s => {
    const timestamp = Date.parse(s.feedTimestamp ?? "");
    return s.kind === kind && s.healthy && timestamp <= now && timestamp >= now - 90000;
  });
  const vehicleHealthy = freshSource("vehicle_positions");
  const bothHealthy = vehicleHealthy && freshSource("trip_updates");
  for (const row of board.departures) {
    const identity = [row.serviceDate, row.tripId, station];
    if (row.platform.kind === "official" || row.lastPublishedPlatform) {
      db.prepare("INSERT OR IGNORE INTO prediction_official_seen VALUES(?,?,?,?)").run(...identity, now);
    }
    if (row.cancelled) {
      db.prepare(`UPDATE prediction_attempts SET unevaluable_reason='cancelled',resolved_at=?
        WHERE service_date=? AND trip_id=? AND station_id=? AND resolved_at IS NULL`).run(now, ...identity);
      continue;
    }
    const scheduled = Date.parse(row.scheduledAt);
    const expected = Date.parse(row.expectedAt);
    if (!bothHealthy || row.platform.kind === "official" || row.lastPublishedPlatform || !Number.isFinite(scheduled) ||
      !Number.isFinite(expected) || scheduled <= now || expected <= now) continue;
    const known = db.prepare(`SELECT 1 FROM prediction_official_seen WHERE service_date=? AND trip_id=? AND station_id=?
      UNION ALL SELECT 1 FROM observations WHERE service_date=? AND trip_id=? AND station_id=? LIMIT 1`)
      .get(...identity, ...identity);
    if (known) continue;
    db.prepare(`INSERT OR IGNORE INTO prediction_attempts
      (service_date,trip_id,station_id,engine_id,line,destination,evaluated_at,scheduled_at,expected_at,
       predicted_platform,historical_share,sample_count,evidence_code,scheduled_lead_seconds,expected_lead_seconds)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(...identity, historicalEngine.id, row.line, row.destination,
        now, scheduled, expected, row.platform.kind === "prediction" ? row.platform.value : null,
        row.platform.confidence, row.platform.sampleCount, row.platform.evidenceCode ?? null,
        (scheduled - now) / 1000, (expected - now) / 1000);
  }
  // Training labels are written only for fresh STOPPED_AT publications by createBoard.
  // Freeze the first later qualifying label; later platform changes must not rewrite the score.
  if (vehicleHealthy) db.prepare(`UPDATE prediction_attempts AS attempt SET
    outcome_platform=(SELECT platform FROM observations o WHERE o.service_date=attempt.service_date AND o.trip_id=attempt.trip_id AND o.station_id=attempt.station_id),
    outcome_at=(SELECT observed_at FROM observations o WHERE o.service_date=attempt.service_date AND o.trip_id=attempt.trip_id AND o.station_id=attempt.station_id),
    resolved_at=?
    WHERE station_id=? AND resolved_at IS NULL AND ? <= expected_at + ? AND EXISTS
      (SELECT 1 FROM observations o WHERE o.service_date=attempt.service_date AND o.trip_id=attempt.trip_id
       AND o.station_id=attempt.station_id AND o.observed_at>attempt.evaluated_at AND o.observed_at<=? AND o.observed_at>=?)`)
    .run(now, station, now, LABEL_WINDOW, now, now - 90000);
  db.prepare(`UPDATE prediction_attempts SET unevaluable_reason='no_later_label',resolved_at=?
    WHERE station_id=? AND resolved_at IS NULL AND expected_at + ? < ?`).run(now, station, LABEL_WINDOW, now);
}

interface Counts {
  engineId: string; serviceDays: number; attempts: number; predicted: number; abstained: number;
  labelled: number; evaluatedPredictions: number; correct: number; incorrect: number;
  pending: number; unevaluable: number; firstAttemptAt: number; lastAttemptAt: number;
}
export function predictionMetrics(db: DatabaseSync, stationId: string, now = Date.now()) {
  const since = now - 90 * DAY;
  const groups = db.prepare(`SELECT engine_id AS engineId,COUNT(DISTINCT service_date) AS serviceDays,COUNT(*) AS attempts,
    SUM(predicted_platform IS NOT NULL) AS predicted,SUM(predicted_platform IS NULL) AS abstained,
    SUM(outcome_at IS NOT NULL) AS labelled,
    SUM(outcome_at IS NOT NULL AND predicted_platform IS NOT NULL) AS evaluatedPredictions,
    SUM(outcome_at IS NOT NULL AND predicted_platform IS NOT NULL AND predicted_platform=outcome_platform) AS correct,
    SUM(outcome_at IS NOT NULL AND predicted_platform IS NOT NULL AND predicted_platform<>outcome_platform) AS incorrect,
    SUM(resolved_at IS NULL AND expected_at + ? >= ?) AS pending,
    SUM(unevaluable_reason IS NOT NULL OR (resolved_at IS NULL AND expected_at + ? < ?)) AS unevaluable,
    MIN(evaluated_at) AS firstAttemptAt,MAX(evaluated_at) AS lastAttemptAt
    FROM prediction_attempts WHERE station_id=? AND evaluated_at>=? AND evaluated_at<=? GROUP BY engine_id`)
    .all(LABEL_WINDOW, now, LABEL_WINDOW, now, stationId, since, now) as unknown as Counts[];
  return {
    stationId, generatedAt: new Date(now).toISOString(), retentionDays: 90,
    checkpointPolicy: "first-eligible-collector-checkpoint-v1",
    outcomePolicy: "first-later-fresh-stopped-at-publication",
    labelWindowHours: 6,
    engines: groups.map(group => {
      const stats = db.prepare(`SELECT MIN(scheduled_lead_seconds) AS minScheduledLeadSeconds,
        AVG(scheduled_lead_seconds) AS meanScheduledLeadSeconds,MAX(scheduled_lead_seconds) AS maxScheduledLeadSeconds,
        MIN(expected_lead_seconds) AS minExpectedLeadSeconds,AVG(expected_lead_seconds) AS meanExpectedLeadSeconds,
        MAX(expected_lead_seconds) AS maxExpectedLeadSeconds,MIN(sample_count) AS minSampleCount,
        AVG(sample_count) AS meanSampleCount,MAX(sample_count) AS maxSampleCount,
        AVG(historical_share) AS meanHistoricalShare,
        AVG(CASE WHEN outcome_at IS NOT NULL THEN (outcome_at-evaluated_at)/1000.0 END) AS meanLeadToPublicationSeconds
        FROM prediction_attempts WHERE station_id=? AND engine_id=? AND evaluated_at>=? AND evaluated_at<=? AND predicted_platform IS NOT NULL`)
        .get(stationId, group.engineId, since, now);
      return { ...group, coverage: group.predicted / group.attempts,
        publishedPlatformAgreement: group.evaluatedPredictions ? group.correct / group.evaluatedPredictions : null,
        predictionStatistics: stats };
    }),
  };
}


