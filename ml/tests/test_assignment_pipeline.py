"""Prospective timing and separate assignment-target regression tests."""
from datetime import datetime, timezone
from pathlib import Path
import sqlite3
import json
from types import SimpleNamespace

import pytest

from ml.assignment_data import load_assignments, AssignmentAttempt
from ml.assignment_evaluation import evaluate_assignments
from ml.evaluation import Settings, river_predictions
from ml import runner


def stamp(day, hour=12):
    return int(datetime(2026, 9, day, hour, tzinfo=timezone.utc).timestamp()*1000)


@pytest.fixture
def database(tmp_path):
    path = tmp_path / "source.sqlite"
    with sqlite3.connect(path) as db:
        db.executescript('''CREATE TABLE assignment_service_context (
          station_id TEXT, service_date TEXT, trip_id TEXT, scheduled_at INTEGER,
          captured_at INTEGER, static_imported_at TEXT, line TEXT, destination TEXT, terminal INTEGER);
          CREATE TABLE assignment_events (station_id TEXT,service_date TEXT,trip_id TEXT,
          fetched_at INTEGER,observed_at INTEGER,freshness TEXT,terminal INTEGER,platform TEXT,
          vehicle_id TEXT,line TEXT,destination TEXT);''')
    return path


def context(db, day=20, trip="t", captured=None, line="R1"):
    with sqlite3.connect(db) as connection:
        connection.execute("INSERT INTO assignment_service_context VALUES (?,?,?,?,?,?,?,?,?)",
            ("72305", f"202609{day:02}", trip, stamp(day), captured or stamp(day)-3600000,
             "2026-09-01T00:00:00Z", line, "Mataro", 0))


def event(db, day=20, trip="t", platform="13", receipt=None, observed=None, vehicle="v", line="R1"):
    receipt = receipt or stamp(day)
    with sqlite3.connect(db) as connection:
        connection.execute("INSERT INTO assignment_events VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            ("72305", f"202609{day:02}", trip, receipt, observed or receipt-1000,
             "fresh", 0, platform, vehicle, line, "Mataro"))


def test_readonly_last_publication_and_closed_window(database):
    context(database)
    event(database, platform="11")
    event(database, platform="13", receipt=stamp(20)+60000)
    before=database.read_bytes()
    rows, source=load_assignments(database, "72305", stamp(20)+3600000)
    assert rows[0].unevaluable_reason == "outcome_window_open"
    rows, source=load_assignments(database, "72305", stamp(21))
    assert rows[0].outcome_platform == "13"
    assert rows[0].resolved_at == stamp(20)+7200000
    assert not rows[0].label_available(stamp(20)+7199999)
    assert "delay_minutes" not in rows[0].features()
    assert database.read_bytes() == before


@pytest.mark.parametrize("scenario,reason", [
    ("late", "contextCapturedTooLate"), ("known", "alreadyPublishedAtCheckpoint"),
    ("conflict", "conflicting_latest_publications"), ("vehicle", "ambiguous_vehicle_identity"),
    ("metadata", "invalid_or_conflicting_evidence")])
def test_unsafe_evidence_does_not_become_label(database,scenario,reason):
    context(database, captured=stamp(20) if scenario=="late" else None)
    event(database)
    if scenario=="known": event(database, receipt=stamp(20)-600000)
    if scenario=="conflict": event(database,platform="11")
    if scenario=="vehicle": event(database,vehicle="other", receipt=stamp(20)+60000)
    if scenario=="metadata": event(database,line="R4", receipt=stamp(20)+60000)
    rows,source=load_assignments(database,"72305",stamp(21))
    assert source["counts"][reason]==1
    assert not rows or rows[0].outcome_platform is None


def test_future_receipt_never_changes_asof_result(database):
    context(database);event(database)
    event(database,platform="8",receipt=stamp(21),observed=stamp(20)+1000)
    rows,_=load_assignments(database,"72305",stamp(20)+7200000)
    assert rows[0].outcome_platform=="13"


def test_missing_database_is_not_created(tmp_path):
    path=tmp_path/"absent.sqlite"
    with pytest.raises(FileNotFoundError): load_assignments(path,"72305",stamp(21))
    assert not path.exists()


def test_per_line_report_and_insufficient_final_dates(database):
    for day in range(20,24):
        for index in range(3):
            trip=str(index)
            context(database,day,trip)
            event(database,day,trip,platform=str(index%2+1))
    rows,source=load_assignments(database,"72305",stamp(25))
    report=evaluate_assignments(rows,source,Settings(iterations=2),stamp(25))
    assert report["byLine"]["R1"]["status"]=="insufficient_data"
    assert report["byLine"]["R1"]["counts"]["trainingServices"]==6
    assert len(report["byLine"]["R1"]["exploratoryWalkForward"]["folds"])==3
    assert report["publicPredictorChanged"] is False


def test_runner_isolates_assignment_failure(tmp_path,monkeypatch):
    (tmp_path/"assignment-report.json").write_text('{"previous":true}')
    def execute(command,**kwargs):
        if command[2]=="ml.assignment_evaluation": return SimpleNamespace(returncode=1,stderr="broken assignment")
        Path(command[command.index("--output")+1]).write_text(json.dumps({"status":"evaluated","counts":{}}))
        return SimpleNamespace(returncode=0,stderr="")
    monkeypatch.setattr(runner.subprocess,"run",execute)
    assert runner.run_once(tmp_path/"source.sqlite",tmp_path)==1
    status=json.loads((tmp_path/"status.json").read_text())
    assert status["state"]=="partial_error"
    assert status["assignmentEvaluation"]["state"]=="error"
    assert json.loads((tmp_path/"assignment-report.json").read_text())=={"previous":True}
    assert (tmp_path/"report.json").exists()


def test_river_learns_only_closed_windows_from_earlier_dates():
    from dataclasses import replace
    class Spy:
        def __init__(self): self.learned=[]
        def learn_one(self,features,label): self.learned.append(label)
        def predict_proba_one(self,features): return {"1":0.9,"2":0.1}
    first=AssignmentAttempt("2026-09-20","first","72305","R1","Mataro",stamp(20)-600000,
        stamp(20),stamp(20),outcome_platform="1",outcome_at=stamp(20),resolved_at=stamp(20)+7200000)
    second=replace(first,trip_id="second",outcome_platform="2")
    current=AssignmentAttempt("2026-09-21","current","72305","R1","Mataro",stamp(21)-600000,
        stamp(21),stamp(21))
    spy=Spy()
    predictions=river_predictions([first,second,current],[current],Settings(1,2,1),stamp(22),model=spy)
    assert spy.learned==["1","2"]
    assert predictions[0]["trainedServices"]==2
    assert predictions[0]["platform"]=="1"
    late=replace(second,resolved_at=current.evaluated_at)
    spy=Spy()
    predictions=river_predictions([first,late,current],[current],Settings(1,2,1),stamp(22),model=spy)
    assert spy.learned==["1"]
    assert predictions[0]["platform"] is None


def test_missing_tables_report_is_explicit(database):
    with sqlite3.connect(database) as db: db.execute("DROP TABLE assignment_events")
    rows,source=load_assignments(database,"72305",stamp(21))
    report=evaluate_assignments(rows,source,Settings(),stamp(21))
    assert report["status"]=="assignment_tables_missing"


def test_context_terminal_not_counted_as_broken_data(database):
    context(database)
    with sqlite3.connect(database) as db: db.execute("UPDATE assignment_service_context SET terminal=1")
    rows,source=load_assignments(database,"72305",stamp(21))
    assert not rows
    assert source["counts"]["terminalContextExcluded"]==1
    assert source["counts"].get("invalidContext",0)==0
