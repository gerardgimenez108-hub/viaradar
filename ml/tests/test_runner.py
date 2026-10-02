"""Automation safety tests, with synthetic reports in temporary directories only."""

from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import subprocess
from types import SimpleNamespace

import pytest

from ml import runner


@pytest.fixture
def successful_evaluation(monkeypatch):
    report = {"status": "insufficient_data", "counts": {"attempts": 15}}
    def execute(command, **kwargs):
        assert command[1] == "-m"
        assert command[2] in ("ml", "ml.assignment_evaluation")
        assert kwargs["timeout"] == (1080 if command[2] == "ml" else 60)
        Path(command[command.index("--output") + 1]).write_text(json.dumps(report), encoding="utf-8")
        return SimpleNamespace(returncode=0, stderr="")
    monkeypatch.setattr(runner.subprocess, "run", execute)
    return report


def test_success_publishes_insufficient_data_and_history(tmp_path, successful_evaluation):
    assert runner.run_once(tmp_path / "source.sqlite", tmp_path) == 0
    assert json.loads((tmp_path / "report.json").read_text()) == successful_evaluation
    status = json.loads((tmp_path / "status.json").read_text())
    assert status["state"] == "success"
    assert status["reportStatus"] == "insufficient_data"
    assert status["counts"] == {"attempts": 15}
    assert len(list((tmp_path / "history").glob("report-*.json"))) == 1
    assert not list(tmp_path.glob(".evaluation-*.json"))


@pytest.mark.parametrize("failure", ["exit", "timeout", "invalid"])
def test_failure_preserves_last_good_report(tmp_path, successful_evaluation, monkeypatch, failure):
    runner.run_once(tmp_path / "source.sqlite", tmp_path)
    before = (tmp_path / "report.json").read_bytes()
    old_status = json.loads((tmp_path / "status.json").read_text())
    def execute(command, **kwargs):
        if failure == "timeout":
            raise subprocess.TimeoutExpired(command, 1080)
        if failure == "invalid":
            Path(command[command.index("--output") + 1]).write_text("{}")
            return SimpleNamespace(returncode=0, stderr="")
        return SimpleNamespace(returncode=1, stderr="unavailable database")
    monkeypatch.setattr(runner.subprocess, "run", execute)
    assert runner.run_once(tmp_path / "source.sqlite", tmp_path) == 1
    assert (tmp_path / "report.json").read_bytes() == before
    status = json.loads((tmp_path / "status.json").read_text())
    assert status["state"] == "error"
    assert status["lastSuccessAt"] == old_status["lastSuccessAt"]
    assert status["counts"] == old_status["counts"]
    assert not list(tmp_path.glob(".evaluation-*.json"))


def test_lock_prevents_overlap_and_releases(tmp_path, successful_evaluation):
    with runner.exclusive_lock(tmp_path / "runner.lock"):
        assert runner.run_once(tmp_path / "source.sqlite", tmp_path) == 0
        assert not (tmp_path / "report.json").exists()
    assert runner.run_once(tmp_path / "source.sqlite", tmp_path) == 0


def test_history_prunes_only_owned_names_and_is_bounded(tmp_path):
    now = datetime.now(timezone.utc)
    def filename(date, number):
        return f"report-{date.strftime('%Y%m%dT%H%M%S%fZ')}-{number:032x}.json"
    old = tmp_path / filename(now - timedelta(days=31), 1)
    old.write_text("{}")
    arbitrary = tmp_path / "user-notes.json"
    arbitrary.write_text("keep")
    for index in range(722):
        (tmp_path / filename(now - timedelta(seconds=index), index)).write_text("{}")
    runner.prune_history(tmp_path, now)
    assert not old.exists()
    assert arbitrary.read_text() == "keep"
    assert len(list(tmp_path.glob("report-*.json"))) == 720


def test_atomic_write_failure_preserves_previous(tmp_path, monkeypatch):
    target = tmp_path / "report.json"
    target.write_text("previous")
    def fail(*args):
        raise OSError("cannot replace")
    monkeypatch.setattr(runner.os, "replace", fail)
    with pytest.raises(OSError):
        runner.atomic_json(target, {"new": True})
    assert target.read_text() == "previous"
    assert list(tmp_path.iterdir()) == [target]


def test_corrupt_status_does_not_block_next_run(tmp_path, successful_evaluation):
    (tmp_path / "status.json").write_text("[]")
    assert runner.run_once(tmp_path / "source.sqlite", tmp_path) == 0
    assert json.loads((tmp_path / "status.json").read_text())["state"] == "success"


@pytest.mark.parametrize("name", ["report.json", "assignment-report.json", "status.json", "runner.lock"])
def test_output_cannot_alias_source_database(tmp_path, name):
    database = tmp_path / name
    database.write_bytes(b"source must stay intact")
    with pytest.raises(ValueError, match="alias"):
        runner.run_once(database, tmp_path)
    assert database.read_bytes() == b"source must stay intact"


def test_output_cannot_hardlink_source_database(tmp_path):
    database = tmp_path / "source.sqlite"
    database.write_bytes(b"source must stay intact")
    (tmp_path / "report.json").hardlink_to(database)
    with pytest.raises(ValueError, match="alias"):
        runner.run_once(database, tmp_path)
    assert database.read_bytes() == b"source must stay intact"
