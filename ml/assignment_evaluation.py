"""Separate shadow evaluation of published assignments, not confirmed train departures."""

import argparse
from collections import Counter
from dataclasses import asdict
from datetime import datetime, timezone
from importlib.metadata import version
import json
from pathlib import Path
import sys

from catboost import CatBoostClassifier
from river import compose, linear_model, multiclass, preprocessing

from .assignment_data import CATEGORICAL, FEATURES, load_assignments
from .data import dataset_hash
from .evaluation import Settings, decision, eligibility, metrics, river_predictions, temporal_split


def catboost_predictions(train, test, settings):
    reason = eligibility(train, settings)
    if not reason and len({tuple(r.features().values()) for r in train}) < 2:
        reason = "constant_training_features"
    if reason:
        return [decision({}, settings, reason) for _ in test], reason
    model = CatBoostClassifier(iterations=settings.iterations, depth=4, learning_rate=0.05,
        loss_function="MultiClass", random_seed=settings.seed, thread_count=1,
        verbose=False, allow_writing_files=False)
    model.fit([[r.features()[f] for f in FEATURES] for r in train],
              [r.outcome_platform for r in train],
              cat_features=[FEATURES.index(f) for f in CATEGORICAL])
    known = {r.context for r in train}
    predictions = []
    for row in test:
        if row.context not in known:
            predictions.append(decision({}, settings, "unseen_context"))
        else:
            probabilities = model.predict_proba([[row.features()[f] for f in FEATURES]])[0]
            predictions.append(decision(dict(zip(model.classes_, probabilities)), settings))
    return predictions, "fitted"


def frequency_predictions(train, test, settings):
    result = []
    for row in test:
        same = [r for r in train if r.context == row.context]
        reason = ("insufficient_context_services" if len(same) < settings.min_train_samples else
                  "insufficient_context_dates" if len({r.service_date for r in same}) < settings.min_train_days else None)
        counts = Counter(r.outcome_platform for r in same)
        result.append(decision({key: n / len(same) for key, n in counts.items()}, settings, reason))
    return result


def make_model():
    categorical = compose.Select(*CATEGORICAL) | preprocessing.OneHotEncoder()
    numeric = compose.Select("weekday", "scheduled_minute") | preprocessing.StandardScaler()
    return (categorical + numeric) | multiclass.OneVsRestClassifier(linear_model.LogisticRegression())


def evaluate_line(rows, settings, as_of):
    train, test, cutoff = temporal_split(rows, settings, as_of)
    cat, status = catboost_predictions(train, test, settings)
    engines = {"destination-frequency": frequency_predictions(train, test, settings),
               "catboost-contextual": cat,
               "river-contextual": river_predictions(rows, test, settings, as_of, model=make_model())}
    # Diagnostic only: earlier completed dates may be informative before a final holdout is possible.
    folds = []
    for day in sorted({r.service_date for r in rows})[1:][-7:]:
        future = [r for r in rows if r.service_date == day]
        before = min(r.evaluated_at for r in future)
        past = [r for r in rows if r.service_date < day and r.label_available(before - 1)]
        exploratory = Settings(1, 2, 1, settings.threshold, settings.iterations, settings.seed)
        predictions, fitted = catboost_predictions(past, future, exploratory)
        scores = [p["score"] for p in predictions if p["score"] is not None]
        folds.append({"serviceDate": day, "trainingServices": len(past), "catboostStatus": fitted,
                      "scoreSummary": {"count": len(scores), "maximum": max(scores, default=None),
                                       "mean": sum(scores)/len(scores) if scores else None},
                      "metrics": metrics(future, predictions, as_of)})
    return {"status": ("insufficient_data" if status != "fitted" or not test else
                       "evaluated" if any(r.label_available(as_of) for r in test) else "no_evaluable_labels"),
        "counts": {"services": len(rows), "labelled": sum(r.label_available(as_of) for r in rows),
                   "trainingServices": len(train), "holdoutServices": len(test)},
        "split": {"trainingDates": sorted({r.service_date for r in train}),
                  "holdoutDates": sorted({r.service_date for r in test}), "cutoffAt": cutoff},
        "catboostStatus": status,
        "engines": {name: metrics(test, predictions, as_of) for name, predictions in engines.items()},
        "predictions": [{"serviceDate": row.service_date, "tripId": row.trip_id,
                         "stationId": row.station_id, "evaluatedAt": row.evaluated_at,
                         "scheduledAt": row.scheduled_at,
                         "publishedOutcome": row.outcome_platform if row.label_available(as_of) else None,
                         "outcomeAvailableAt": row.resolved_at, "unevaluableReason": row.unevaluable_reason,
                         "engines": {name: values[index] for name, values in engines.items()}}
                        for index, row in enumerate(test)],
        "exploratoryWalkForward": {"policy": "Last 7 date folds, diagnostics only; 2 services/1 date minimum, never a promotion gate",
                                   "folds": folds}}


def evaluate_assignments(rows, source, settings, as_of):
    if len({r.identity for r in rows}) != len(rows):
        raise ValueError("Duplicate independent services")
    lines = {line: evaluate_line([r for r in rows if r.line == line], settings, as_of)
             for line in sorted({r.line for r in rows})}
    return {"schemaVersion": 1, "status": (source["status"] if source.get("status") != "ok" else
            "evaluated" if any(x["status"] == "evaluated" for x in lines.values()) else
            "no_evaluable_labels" if any(x["status"] == "no_evaluable_labels" for x in lines.values()) else "insufficient_data"),
        "mode": "assignment_shadow_no_promotion", "asOf": as_of, "dataSha256": dataset_hash(rows),
        "counts": source.get("counts", {}), "source": source, "settings": asdict(settings),
        "featureSchema": list(FEATURES), "featureTimezone": "Europe/Madrid",
        "versions": {package: version(package) for package in ("scikit-learn", "catboost", "river")},
        "checkpointPolicy": "Scheduled departure minus 10 minutes; context already captured and no assignment received",
        "outcomePolicy": "Last fresh publication within checkpoint..scheduled+2h; learn only after window closes",
        "trainingPolicy": "Earlier service dates only; outcome window closed strictly before prediction",
        "byLine": lines, "publicPredictorChanged": False,
        "limitations": ["Target is a published assignment, never physical departure or stopped confirmation.",
            "Missing publications, selective context capture and collector outages can bias coverage and agreement.",
            "Publications after the fixed two-hour window are not this target; very delayed trains may differ.",
            "Model scores are uncalibrated. Exploratory folds are not an untouched final test or deployment evidence.",
            "No model promotion or public predictions are performed by this pipeline."]}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--station", default="72305")
    args = parser.parse_args(argv)
    from .runner import atomic_json
    try:
        source = args.db.resolve(strict=True)
        for protected in (source, Path(str(source) + "-wal"), Path(str(source) + "-shm")):
            if args.output.resolve() == protected or (args.output.exists() and protected.exists() and args.output.samefile(protected)):
                raise ValueError("Output aliases database")
        if args.output.suffix.lower() != ".json":
            raise ValueError("Output must be JSON")
        as_of = int(datetime.now(timezone.utc).timestamp() * 1000)
        rows, diagnostics = load_assignments(source, args.station, as_of)
        report = evaluate_assignments(rows, diagnostics, Settings(), as_of)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        atomic_json(args.output, report)
        print(json.dumps({"status": report["status"], "counts": report["counts"]}))
        return 0
    except Exception as error:
        print(f"Assignment evaluation failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
