"""One-shot scheduled evaluation; never promotes models or writes the source database."""

import argparse
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import uuid

HISTORY_NAME = re.compile(r"report-\d{8}T\d{12}Z-[0-9a-f]{32}\.json\Z")


class AlreadyRunning(Exception):
    pass


@contextmanager
def exclusive_lock(path: Path):
    """An OS-owned lock releases even if the process is killed; keep the file inode."""
    with path.open("a+b") as handle:
        handle.seek(0)
        if os.fstat(handle.fileno()).st_size == 0:
            handle.write(b"0")
            handle.flush()
        handle.seek(0)
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            raise AlreadyRunning("Another ML evaluation is running") from error
        try:
            yield
        finally:
            handle.seek(0)
            if os.name == "nt":
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def atomic_json(path: Path, content: dict):
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        with temporary.open("w", encoding="utf-8") as handle:
            json.dump(content, handle, indent=2, ensure_ascii=False, allow_nan=False)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def prune_history(directory: Path, now: datetime):
    """Only delete our regular, precisely named reports; leave arbitrary files alone."""
    owned = sorted((path for path in directory.iterdir()
                    if HISTORY_NAME.fullmatch(path.name) and path.is_file() and not path.is_symlink()),
                   key=lambda path: path.name, reverse=True)
    cutoff = (now - timedelta(days=30)).strftime("%Y%m%dT%H%M%S%fZ")
    for index, path in enumerate(owned):
        stamp = path.name.removeprefix("report-").split("-")[0]
        if index >= 720 or stamp < cutoff:
            path.unlink()


def run_once(db: Path, output_dir: Path, station: str = "72305") -> int:
    # Final destinations must not alias the source, including symlinks/hardlinks.
    source = db.resolve()
    protected = {source, Path(str(source) + "-wal"), Path(str(source) + "-shm")}
    for name in ("report.json", "status.json", "runner.lock"):
        destination = output_dir / name
        if destination.resolve() in protected or any(
            destination.exists() and item.exists() and destination.samefile(item)
            for item in protected
        ):
            raise ValueError("Runner output must not alias the input database or SQLite sidecars")
    output_dir.mkdir(parents=True, exist_ok=True)
    try:
        with exclusive_lock(output_dir / "runner.lock"):
            return _run_locked(db, output_dir, station)
    except AlreadyRunning:
        print("ML evaluation skipped: another runner owns the lock")
        return 0


def _run_locked(db: Path, output_dir: Path, station: str) -> int:
    started = datetime.now(timezone.utc)
    status_path = output_dir / "status.json"
    previous = {}
    if status_path.exists():
        try:
            previous = json.loads(status_path.read_text(encoding="utf-8"))
            if not isinstance(previous, dict):
                previous = {}
        except (ValueError, OSError):
            pass
    temporary = output_dir / f".evaluation-{uuid.uuid4().hex}.json"
    status = {"startedAt": started.isoformat(), "stationId": station,
              "lastSuccessAt": previous.get("lastSuccessAt"),
              "counts": previous.get("counts"), "mode": "offline-replay-no-promotion"}
    try:
        completed = subprocess.run(
            [sys.executable, "-m", "ml", "--db", str(db.resolve()),
             "--output", str(temporary.resolve()), "--station", station],
            cwd=Path(__file__).resolve().parents[1], capture_output=True, text=True,
            timeout=18 * 60, check=False,
        )
        if completed.returncode:
            raise RuntimeError(f"Evaluation exited {completed.returncode}: {completed.stderr[-2000:]}")
        report = json.loads(temporary.read_text(encoding="utf-8"))
        if not isinstance(report, dict) or not isinstance(report.get("counts"), dict) or not isinstance(report.get("status"), str):
            raise ValueError("Evaluation output does not contain a report status and counts")
        history = output_dir / "history"
        history.mkdir(exist_ok=True)
        name = f"report-{started.strftime('%Y%m%dT%H%M%S%fZ')}-{uuid.uuid4().hex}.json"
        atomic_json(history / name, report)
        prune_history(history, started)
        atomic_json(output_dir / "report.json", report)
        status.update({"state": "success", "lastSuccessAt": datetime.now(timezone.utc).isoformat(),
                       "reportStatus": report["status"], "counts": report["counts"], "error": None})
        result = 0
    except Exception as error:
        status.update({"state": "error", "error": str(error)[-2500:]})
        result = 1
    finally:
        temporary.unlink(missing_ok=True)
    status["finishedAt"] = datetime.now(timezone.utc).isoformat()
    atomic_json(status_path, status)
    print(json.dumps(status))
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, default=Path("data/viaradar.sqlite"))
    parser.add_argument("--output-dir", type=Path, default=Path("data/ml"))
    parser.add_argument("--station", default="72305")
    args = parser.parse_args(argv)
    return run_once(args.db, args.output_dir, args.station)


if __name__ == "__main__":
    sys.exit(main())
