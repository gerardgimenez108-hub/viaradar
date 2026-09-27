"""Synthetic fixtures are confined to pytest temporary databases, never production."""

from dataclasses import replace
from datetime import datetime, timezone
import json
from pathlib import Path
import sqlite3

import pytest

from ml.__main__ import main, parse_as_of
from ml.data import Attempt, BASELINE, FEATURES, load_attempts
from ml.evaluation import Settings, evaluate, metrics, river_predictions, temporal_split


def millis(value):
    return int(datetime.fromisoformat(value).replace(tzinfo=timezone.utc).timestamp() * 1000)


@pytest.fixture
def attempt():
    at = millis("2026-09-01T08:00:00")
    return Attempt("2026-09-01", "trip-0", "72305", "R1", "Maçanet", at,
                   at + 600000, at + 660000, "2", "2", at + 720000, at + 730000)


@pytest.fixture
def write_db(tmp_path):
    def write(rows, filename="fixture.sqlite"):
        path = tmp_path / filename
        with sqlite3.connect(path) as db:
            fields = list(Attempt.__dataclass_fields__)
            db.execute("CREATE TABLE prediction_attempts (engine_id TEXT," + ",".join(fields) + ")")
            for row in rows:
                values = [BASELINE] + [getattr(row, key) for key in fields]
                db.execute("INSERT INTO prediction_attempts VALUES(" + ",".join("?" for _ in values) + ")", values)
        return path
    return write


def fixture_days(attempt, days=6, per_day=12):
    result = []
    for day in range(days):
        for number in range(per_day):
            shift = day * 86400000 + number * 60000
            result.append(replace(
                attempt, service_date=f"2026-09-{day + 1:02d}", trip_id=f"trip-{number}",
                line="R1" if number % 2 else "R4", destination="Maçanet" if number % 2 else "Manresa",
                evaluated_at=attempt.evaluated_at + shift,
                scheduled_at=attempt.scheduled_at + shift, expected_at=attempt.expected_at + shift,
                outcome_at=attempt.outcome_at + shift, resolved_at=attempt.resolved_at + shift,
                outcome_platform="2" if number % 2 else "4", predicted_platform="2" if number % 2 else None,
            ))
    return result


def test_loader_accepts_label_and_deduplicates_without_writing(attempt, write_db):
    path = write_db([attempt, attempt])
    before = path.read_bytes()
    rows, info = load_attempts(path, "72305", attempt.resolved_at)
    assert rows == [attempt]
    assert info == {"status": "ok", "invalidRows": 0, "duplicates": 1}
    assert path.read_bytes() == before


def test_loader_normalizes_real_gtfs_compact_service_dates(attempt, write_db):
    path = write_db([replace(attempt, service_date="20260901"), attempt])
    rows, info = load_attempts(path, "72305", attempt.resolved_at)
    assert rows == [attempt]
    assert info["duplicates"] == 1
    assert info["invalidRows"] == 0


@pytest.mark.parametrize("changes", [
    {"outcome_at": 0}, {"resolved_at": "broken"}, {"resolved_at": 1.5}, {"scheduled_at": 0},
    {"service_date": "invalid"}, {"outcome_platform": ""}, {"line": None},
])
def test_loader_rejects_invalid_evidence(attempt, write_db, changes):
    path = write_db([replace(attempt, **changes)])
    rows, info = load_attempts(path, "72305", attempt.resolved_at)
    assert rows == []
    assert info["invalidRows"] == 1


def test_missing_database_does_not_get_created(tmp_path):
    path = tmp_path / "missing.sqlite"
    with pytest.raises(FileNotFoundError):
        load_attempts(path, "72305", 100)
    assert not path.exists()


def test_missing_measurement_table_is_explicit(tmp_path):
    path = tmp_path / "old.sqlite"
    sqlite3.connect(path).close()
    rows, info = load_attempts(path, "72305", 100)
    assert not rows
    assert info["status"] == "measurement_table_missing"


def test_features_exclude_identity_labels_and_use_service_weekday(attempt):
    features = attempt.features()
    assert tuple(features) == FEATURES
    assert features["scheduled_minute"] == 610  # 08:10 UTC = 10:10 Madrid in September.
    assert features["weekday"] == 1
    assert features["delay_minutes"] == 1
    assert features == replace(attempt, trip_id="other", outcome_platform="99", resolved_at=1).features()


def test_temporal_split_blocks_labels_resolved_at_or_after_cutoff(attempt):
    rows = fixture_days(attempt, days=4, per_day=2)
    settings = Settings(holdout_days=1, min_train_samples=2, min_train_days=1)
    cutoff = rows[-2].evaluated_at
    rows[0] = replace(rows[0], resolved_at=cutoff)
    rows[1] = replace(rows[1], resolved_at=cutoff + 1)
    train, test, actual_cutoff = temporal_split(rows, settings, cutoff + 86400000)
    assert actual_cutoff == cutoff
    assert rows[0] not in train and rows[1] not in train
    assert all(row.service_date < test[0].service_date for row in train)
    assert {row.service_date for row in test} == {"2026-09-04"}


def test_zero_rows_and_one_day_never_fabricate_accuracy(attempt):
    for rows in ([], [attempt]):
        report = evaluate(rows, Settings(), attempt.resolved_at)
        assert report["status"] == "insufficient_data"
        assert report["counts"]["holdoutServices"] == 0
        assert all(result["publishedPlatformAgreement"] is None for result in report["engines"].values())


def test_single_class_abstains(attempt):
    rows = [replace(row, outcome_platform="2") for row in fixture_days(attempt)]
    report = evaluate(rows, Settings(holdout_days=1, min_train_samples=2, min_train_days=1), rows[-1].resolved_at)
    assert report["catboostStatus"] == "single_training_class"
    assert report["engines"]["catboost-experimental-v1"]["predicted"] == 0
    assert report["engines"]["river-experimental-v1"]["predicted"] == 0


def test_actual_libraries_fit_and_replay_deterministically(attempt):
    rows = fixture_days(attempt)
    settings = Settings(holdout_days=2, min_train_samples=12, min_train_days=2,
                        threshold=0.5, iterations=20)
    report = evaluate(rows, settings, rows[-1].resolved_at)
    repeated = evaluate(rows, settings, rows[-1].resolved_at)
    assert report == repeated
    assert report["status"] == "evaluated"
    assert report["counts"]["holdoutServices"] == 24
    assert report["catboostStatus"] == "fitted"
    for name in ("catboost-experimental-v1", "river-experimental-v1"):
        assert report["engines"][name]["predicted"] > 0
        assert report["engines"][name]["attempts"] == 24
    for prediction in report["predictions"]:
        river = prediction["engines"]["river-experimental-v1"]
        assert river["latestTrainingResolutionAt"] < prediction["evaluatedAt"]
        assert river["latestTrainingServiceDate"] < prediction["serviceDate"]


def test_river_predict_before_learning_equal_time_and_same_date(attempt):
    class Recorder:
        def __init__(self):
            self.learned = []
            self.prediction_sizes = []

        def learn_one(self, features, label):
            self.learned.append(label)

        def predict_proba_one(self, features):
            self.prediction_sizes.append(len(self.learned))
            return {"2": 0.9, "4": 0.1}

    rows = fixture_days(attempt, days=3, per_day=2)
    first_holdout = rows[4]
    rows[2] = replace(rows[2], resolved_at=first_holdout.evaluated_at)
    rows[3] = replace(rows[3], resolved_at=first_holdout.evaluated_at + 1)
    # Both holdout rows resolve before a third checkpoint on that same service date.
    last = replace(rows[5], trip_id="late", evaluated_at=rows[5].resolved_at + 1,
                   scheduled_at=rows[5].resolved_at + 50000, expected_at=rows[5].resolved_at + 50000,
                   outcome_at=None, resolved_at=None, outcome_platform=None)
    rows.append(last)
    model = Recorder()
    result = river_predictions(rows, rows[4:], Settings(1, 2, 1), last.evaluated_at, model)
    assert [p["trainedServices"] for p in result] == [2, 4, 4]
    assert model.prediction_sizes == [2, 4, 4]
    assert len(model.learned) == 4  # No per-snapshot or same-service-date repeated learning.


def test_future_label_does_not_score_or_train(attempt):
    as_of = attempt.evaluated_at + 1
    result = metrics([attempt], [{"platform": "2", "reason": "test"}], as_of)
    assert result["labelled"] == 0
    assert result["publishedPlatformAgreement"] is None
    replay = river_predictions([attempt], [attempt], Settings(1, 2, 1), as_of)
    assert replay[0]["trainedServices"] == 0


def test_river_abstains_on_nonmonotonic_service_dates(attempt):
    rows = fixture_days(attempt, days=4, per_day=2)
    late_previous_day = replace(rows[-1], trip_id="overnight", service_date="2026-09-02",
                                evaluated_at=rows[-1].evaluated_at + 1)
    rows.append(late_previous_day)
    result = river_predictions(rows, [late_previous_day], Settings(1, 2, 1), rows[-2].resolved_at)
    assert result[0]["reason"] == "nonmonotonic_service_date"
    assert result[0]["platform"] is None


def test_catboost_constant_features_abstain(attempt):
    # Distinct services, identical permitted features, two contradictory labels.
    rows = [replace(attempt, trip_id=f"same-{i}", outcome_platform="2" if i % 2 else "4")
            for i in range(4)]
    from ml.evaluation import catboost_predictions
    predictions, status = catboost_predictions(rows, [attempt], Settings(1, 2, 1))
    assert status == "constant_training_features"
    assert predictions[0]["platform"] is None


def test_unlabelled_holdout_does_not_claim_evaluation(attempt):
    rows = fixture_days(attempt)
    rows = [replace(row, outcome_platform=None, outcome_at=None, resolved_at=None)
            if row.service_date == "2026-09-06" else row for row in rows]
    report = evaluate(rows, Settings(1, 2, 1, 0.5, 10), rows[-1].expected_at + 86400000)
    assert report["status"] == "no_evaluable_labels"
    assert all(result["publishedPlatformAgreement"] is None for result in report["engines"].values())


def test_unseen_context_abstains(attempt):
    rows = fixture_days(attempt)
    rows[-1] = replace(rows[-1], destination="Unseen destination")
    report = evaluate(rows, Settings(1, 2, 1, 0.5, 10), rows[-1].resolved_at)
    last = report["predictions"][-1]["engines"]
    assert last["catboost-experimental-v1"]["reason"] == "unseen_context"
    assert last["river-experimental-v1"]["reason"] == "unseen_context"


def test_cli_writes_real_report_and_protects_input(attempt, write_db, tmp_path):
    db = write_db([attempt])
    output = tmp_path / "report.json"
    before = db.read_bytes()
    assert main(["--db", str(db), "--output", str(output)]) == 0
    report = json.loads(output.read_text(encoding="utf-8"))
    assert report["counts"]["labelledAsOf"] == 1
    assert report["status"] == "insufficient_data"
    assert main(["--db", str(db), "--output", str(db)]) == 1
    assert db.read_bytes() == before


def test_duplicate_services_rejected_by_evaluator(attempt):
    with pytest.raises(ValueError, match="Duplicate"):
        evaluate([attempt, attempt], Settings(), attempt.resolved_at)


@pytest.mark.parametrize("threshold", [float("nan"), float("inf"), 0.1, 1.1])
def test_invalid_threshold_is_rejected(threshold):
    with pytest.raises(ValueError):
        Settings(threshold=threshold)


def test_as_of_requires_explicit_timezone():
    with pytest.raises(ValueError, match="timezone"):
        parse_as_of("2026-09-01T12:00:00")
