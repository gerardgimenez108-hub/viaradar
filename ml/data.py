"""Read immutable prospective checkpoints without importing the live server."""

from dataclasses import asdict, dataclass, replace
from datetime import date, datetime
import hashlib
import json
from pathlib import Path
import sqlite3
from zoneinfo import ZoneInfo


BASELINE = "historical-frequency-v1"
TIMEZONE = ZoneInfo("Europe/Madrid")
FEATURES = ("station", "line", "destination", "weekday", "scheduled_minute", "delay_minutes")
CATEGORICAL = ("station", "line", "destination")


@dataclass(frozen=True)
class Attempt:
    service_date: str
    trip_id: str
    station_id: str
    line: str
    destination: str
    evaluated_at: int
    scheduled_at: int
    expected_at: int
    predicted_platform: str | None = None
    outcome_platform: str | None = None
    outcome_at: int | None = None
    resolved_at: int | None = None
    unevaluable_reason: str | None = None

    @property
    def identity(self) -> tuple[str, str, str]:
        return self.service_date, self.trip_id, self.station_id

    @property
    def context(self) -> tuple[str, str, str]:
        return self.station_id, self.line, self.destination

    def features(self) -> dict[str, str | int | float]:
        scheduled = datetime.fromtimestamp(self.scheduled_at / 1000, TIMEZONE)
        return {
            "station": self.station_id,
            "line": self.line,
            "destination": self.destination,
            "weekday": date.fromisoformat(self.service_date).weekday(),
            "scheduled_minute": scheduled.hour * 60 + scheduled.minute,
            "delay_minutes": (self.expected_at - self.scheduled_at) / 60000,
        }

    def label_available(self, timestamp: int) -> bool:
        return bool(
            self.outcome_platform and self.unevaluable_reason is None
            and self.outcome_at is not None and self.resolved_at is not None
            and self.evaluated_at < self.outcome_at <= self.resolved_at <= timestamp
        )


def load_attempts(path: Path, station: str, as_of: int) -> tuple[list[Attempt], dict]:
    """Use SQLite mode=ro; missing files/tables never create a database."""
    path = path.resolve(strict=True)
    columns = tuple(Attempt.__dataclass_fields__)
    with sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=5) as db:
        db.execute("PRAGMA query_only=ON")
        exists = db.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='prediction_attempts'"
        ).fetchone()
        if not exists:
            return [], {"status": "measurement_table_missing", "invalidRows": 0, "duplicates": 0}
        db.row_factory = sqlite3.Row
        rows = db.execute(
            f"SELECT {','.join(columns)} FROM prediction_attempts "
            "WHERE engine_id=? AND station_id=? AND evaluated_at<=? "
            "ORDER BY evaluated_at,service_date,trip_id,station_id",
            (BASELINE, station, as_of),
        ).fetchall()
    unique: dict[tuple[str, str, str], Attempt] = {}
    invalid = duplicates = 0
    for raw in rows:
        try:
            item = Attempt(**dict(raw))
            service_date = date.fromisoformat(item.service_date)
            if item.service_date not in (service_date.isoformat(), service_date.strftime("%Y%m%d")):
                raise ValueError("Non-canonical service date")
            item = replace(item, service_date=service_date.isoformat())
            if any(not isinstance(getattr(item, key), str) or not getattr(item, key).strip()
                   for key in ("trip_id", "station_id", "line", "destination")):
                raise ValueError("Missing categorical field")
            if any(type(getattr(item, key)) is not int or getattr(item, key) <= 0
                   for key in ("evaluated_at", "scheduled_at", "expected_at")):
                raise ValueError("Invalid checkpoint timestamp")
            if min(item.scheduled_at, item.expected_at) <= item.evaluated_at:
                raise ValueError("Not an advance checkpoint")
            if any(getattr(item, key) is not None and
                   (type(getattr(item, key)) is not int or getattr(item, key) <= 0)
                   for key in ("outcome_at", "resolved_at")):
                raise ValueError("Invalid resolution timestamp")
            if item.predicted_platform is not None and (
                not isinstance(item.predicted_platform, str) or not item.predicted_platform.strip()
            ):
                raise ValueError("Invalid baseline platform")
            if item.outcome_platform is not None:
                if not isinstance(item.outcome_platform, str) or not item.outcome_platform.strip():
                    raise ValueError("Invalid label")
                if not item.label_available(max(as_of, item.resolved_at or 0)):
                    raise ValueError("Invalid label chronology")
            elif item.outcome_at is not None:
                raise ValueError("Timestamp without label")
            item.features()  # Validate datetime range before model input.
        except (ValueError, TypeError, OverflowError, OSError):
            invalid += 1
            continue
        if item.identity in unique:
            duplicates += 1
        else:
            unique[item.identity] = item
    return list(unique.values()), {"status": "ok", "invalidRows": invalid, "duplicates": duplicates}


def dataset_hash(rows: list[Attempt]) -> str:
    content = json.dumps([asdict(row) for row in rows], sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(content.encode("utf-8")).hexdigest()
