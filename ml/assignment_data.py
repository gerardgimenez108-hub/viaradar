"""Read-only, prospective assignment cohort; never manufacture physical-departure labels."""

from collections import Counter, defaultdict
from dataclasses import dataclass, replace
from datetime import date, datetime
from pathlib import Path
import sqlite3

from .data import Attempt

CHECKPOINT_MS = 10 * 60_000
OUTCOME_WINDOW_MS = 2 * 60 * 60_000
FEATURES = ("station", "line", "destination", "weekday", "scheduled_minute")
CATEGORICAL = ("station", "line", "destination")


@dataclass(frozen=True)
class AssignmentAttempt(Attempt):
    def features(self):
        return {key: value for key, value in super().features().items() if key in FEATURES}


def load_assignments(path: Path, station: str, as_of: int):
    path = path.resolve(strict=True)
    counts = Counter()
    with sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=5) as db:
        db.execute("PRAGMA query_only=ON")
        db.execute("BEGIN")  # Context and events must come from one consistent read snapshot.
        db.row_factory = sqlite3.Row
        tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if not {"assignment_events", "assignment_service_context"} <= tables:
            return [], {"status": "assignment_tables_missing", "counts": {}}
        contexts = db.execute("SELECT * FROM assignment_service_context WHERE station_id=? AND captured_at<=?",
                              (station, as_of)).fetchall()
        events = db.execute("SELECT * FROM assignment_events WHERE station_id=? AND fetched_at<=?",
                            (station, as_of)).fetchall()
    grouped = defaultdict(list)
    for event in events:
        grouped[(event["service_date"], event["trip_id"])].append(event)
    rows = []
    by_line = defaultdict(Counter)
    for context in contexts:
        count = by_line[context["line"] or "unknown"]
        count["contexts"] += 1
        try:
            raw_date = context["service_date"]
            day = date.fromisoformat(raw_date).isoformat()
            scheduled, captured = context["scheduled_at"], context["captured_at"]
            if any(type(v) is not int or v <= 0 for v in (scheduled, captured)):
                raise ValueError("Invalid timestamp")
            imported = datetime.fromisoformat(context["static_imported_at"].replace("Z", "+00:00"))
            if imported.tzinfo is None or imported.timestamp() * 1000 > captured:
                raise ValueError("Context predates timetable")
            if context["terminal"] == 1:
                count["terminalContextExcluded"] += 1
                continue
            if context["terminal"] != 0 or any(not isinstance(context[k], str) or not context[k].strip()
                                                       for k in ("line", "destination", "trip_id")):
                raise ValueError("Incomplete outbound context")
            checkpoint = scheduled - CHECKPOINT_MS
            end = scheduled + OUTCOME_WINDOW_MS
            if captured > checkpoint:
                count["contextCapturedTooLate"] += 1
                continue
            if checkpoint > as_of:
                count["checkpointNotReached"] += 1
                continue
            service_events = grouped[(raw_date, context["trip_id"])]
            # Even an unusable publication already received is not an unknown-track checkpoint.
            if any(e["platform"] and e["fetched_at"] <= checkpoint for e in service_events):
                count["alreadyPublishedAtCheckpoint"] += 1
                continue
            candidate = AssignmentAttempt(day, context["trip_id"], station, context["line"],
                                          context["destination"], checkpoint, scheduled, scheduled)
            candidate.features()
            later = [e for e in service_events if checkpoint < e["fetched_at"] <= end
                     and e["freshness"] == "fresh" and e["terminal"] == 0 and e["platform"]]
            reason = None
            if end > as_of:
                reason = "outcome_window_open"
            elif not later:
                reason = "no_later_publication"
            elif any(e["line"] != context["line"] or e["destination"] != context["destination"]
                     or not e["vehicle_id"] or type(e["observed_at"]) is not int
                     or not checkpoint < e["observed_at"] <= e["fetched_at"]
                     or e["fetched_at"] - e["observed_at"] > 90_000
                     for e in later):
                reason = "invalid_or_conflicting_evidence"
            elif len({e["vehicle_id"] for e in later}) != 1:
                reason = "ambiguous_vehicle_identity"
            else:
                latest_time = max(e["observed_at"] for e in later)
                latest = [e for e in later if e["observed_at"] == latest_time]
                if len({e["platform"] for e in latest}) != 1:
                    reason = "conflicting_latest_publications"
                else:
                    # The final-in-window label is not knowable before the entire window closes.
                    candidate = AssignmentAttempt(day, context["trip_id"], station, context["line"],
                        context["destination"], checkpoint, scheduled, scheduled,
                        outcome_platform=latest[0]["platform"], outcome_at=latest_time, resolved_at=end)
            if reason:
                candidate = replace(candidate, unevaluable_reason=reason)
                count[reason] += 1
            else:
                count["labelled"] += 1
            rows.append(candidate)
            count["eligibleCheckpoints"] += 1
        except (ValueError, TypeError, OverflowError, OSError):
            count["invalidContext"] += 1
    for count in by_line.values():
        counts.update(count)
    return sorted(rows, key=lambda r: (r.evaluated_at, r.identity)), {
        "status": "ok", "counts": dict(counts), "byLine": dict(by_line),
    }
