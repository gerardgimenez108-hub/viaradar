"""CLI entrypoint: python -m ml --db data/viaradar.sqlite --output data/ml/report.json."""

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import sqlite3
import sys

from .data import load_attempts
from .evaluation import Settings, evaluate


def parse_as_of(value: str) -> int:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("--as-of must include an explicit timezone, for example 2026-09-27T08:00:00Z")
    return int(parsed.timestamp() * 1000)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Offline ML experiments; never changes the live predictor or SQLite database")
    parser.add_argument("--db", type=Path, default=Path("data/viaradar.sqlite"))
    parser.add_argument("--output", type=Path, default=Path("data/ml/report.json"))
    parser.add_argument("--station", default="72305")
    parser.add_argument("--holdout-days", type=int, default=2)
    parser.add_argument("--min-train-samples", type=int, default=50)
    parser.add_argument("--min-train-days", type=int, default=3)
    parser.add_argument("--threshold", type=float, default=0.8)
    parser.add_argument("--iterations", type=int, default=100)
    parser.add_argument("--as-of", help="Replay information available by an ISO timestamp with timezone")
    args = parser.parse_args(argv)
    try:
        db_path = args.db.resolve(strict=True)
        output = args.output.resolve()
        if output == db_path or str(output) in {str(db_path) + "-wal", str(db_path) + "-shm"}:
            raise ValueError("Report output must not overwrite the input database or SQLite sidecars")
        if output.suffix.lower() != ".json":
            raise ValueError("Report output must use a .json extension")
        now = int(datetime.now(timezone.utc).timestamp() * 1000)
        as_of = parse_as_of(args.as_of) if args.as_of else now
        if as_of > now:
            raise ValueError("--as-of cannot be in the future")
        settings = Settings(args.holdout_days, args.min_train_samples, args.min_train_days,
                            args.threshold, args.iterations)
        rows, source = load_attempts(db_path, args.station, as_of)
        report = evaluate(rows, settings, as_of)
        report.update({"source": source, "stationId": args.station})
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(report, indent=2, ensure_ascii=False, allow_nan=False) + "\n", encoding="utf-8")
        print(json.dumps({"status": report["status"], "counts": report["counts"],
                          "catboostStatus": report["catboostStatus"], "output": str(output)}))
        return 0
    except (OSError, ValueError, sqlite3.Error) as error:
        print(f"ML evaluation failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
