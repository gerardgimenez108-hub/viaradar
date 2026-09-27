"""Date-blocked batch evaluation and label-delayed online replay."""

from dataclasses import asdict, dataclass
from importlib.metadata import version
import math

from catboost import CatBoostClassifier
from river import compose, linear_model, multiclass, preprocessing
from sklearn.metrics import accuracy_score, confusion_matrix

from .data import Attempt, BASELINE, CATEGORICAL, FEATURES, dataset_hash


@dataclass(frozen=True)
class Settings:
    holdout_days: int = 2
    min_train_samples: int = 50
    min_train_days: int = 3
    threshold: float = 0.8
    iterations: int = 100
    seed: int = 42

    def __post_init__(self):
        if self.holdout_days < 1 or self.min_train_samples < 2 or self.min_train_days < 1:
            raise ValueError("Require positive holdout/days and at least two training services")
        if not math.isfinite(self.threshold) or not 0.5 <= self.threshold <= 1:
            raise ValueError("Threshold must be finite and between 0.5 and 1")
        if self.iterations < 1:
            raise ValueError("Iterations must be positive")


def eligibility(rows: list[Attempt], settings: Settings) -> str | None:
    if len(rows) < settings.min_train_samples:
        return "insufficient_training_services"
    if len({r.service_date for r in rows}) < settings.min_train_days:
        return "insufficient_training_dates"
    if len({r.outcome_platform for r in rows}) < 2:
        return "single_training_class"
    return None


def decision(probabilities: dict, settings: Settings, reason: str | None = None) -> dict:
    if reason:
        return {"platform": None, "score": None, "reason": reason}
    if not probabilities:
        return {"platform": None, "score": None, "reason": "no_probabilities"}
    cleaned = {str(key): float(value) for key, value in probabilities.items()}
    if any(not math.isfinite(value) or not 0 <= value <= 1 for value in cleaned.values()):
        return {"platform": None, "score": None, "reason": "invalid_probabilities"}
    winner, score = sorted(cleaned.items(), key=lambda item: (-item[1], item[0]))[0]
    return {
        "platform": winner if score >= settings.threshold else None,
        "score": score,
        "reason": "model_score" if score >= settings.threshold else "below_threshold",
    }


def temporal_split(rows: list[Attempt], settings: Settings, as_of: int):
    dates = sorted({row.service_date for row in rows})
    if len(dates) <= settings.holdout_days:
        return [], [], None
    first_test_date = dates[-settings.holdout_days]
    test = [row for row in rows if row.service_date >= first_test_date]
    cutoff = min(row.evaluated_at for row in test)
    train = [row for row in rows if row.service_date < first_test_date
             and row.label_available(min(cutoff - 1, as_of))]
    return train, test, cutoff


def catboost_predictions(train: list[Attempt], test: list[Attempt], settings: Settings):
    reason = eligibility(train, settings)
    if reason is None and len({tuple(row.features().values()) for row in train}) < 2:
        reason = "constant_training_features"
    if reason:
        return [decision({}, settings, reason) for _ in test], reason
    model = CatBoostClassifier(
        iterations=settings.iterations, depth=4, learning_rate=0.05,
        loss_function="MultiClass", random_seed=settings.seed, thread_count=1,
        verbose=False, allow_writing_files=False,
    )
    model.fit(
        [[row.features()[feature] for feature in FEATURES] for row in train],
        [row.outcome_platform for row in train],
        cat_features=[FEATURES.index(feature) for feature in CATEGORICAL],
    )
    known = {row.context for row in train}
    predictions = []
    for row in test:
        if row.context not in known:
            predictions.append(decision({}, settings, "unseen_context"))
            continue
        probabilities = model.predict_proba([[row.features()[feature] for feature in FEATURES]])[0]
        predictions.append(decision(dict(zip(model.classes_, probabilities)), settings))
    return predictions, "fitted"


def make_river_model():
    categorical = compose.Select(*CATEGORICAL) | preprocessing.OneHotEncoder()
    numeric = compose.Select(*(feature for feature in FEATURES if feature not in CATEGORICAL))
    numeric |= preprocessing.StandardScaler()
    return (categorical + numeric) | multiclass.OneVsRestClassifier(linear_model.LogisticRegression())


def river_predictions(rows: list[Attempt], test: list[Attempt], settings: Settings, as_of: int,
                      model=None):
    """Replay every checkpoint; learn only later-resolved labels from earlier service dates.

    Label events at the exact prediction timestamp are intentionally processed after
    that prediction. Replaying starts fresh each run, without unsafe pickle state.
    """
    model = make_river_model() if model is None else model
    events = sorted((row for row in rows if row.label_available(as_of)),
                    key=lambda row: (row.resolved_at, row.identity))
    test_ids = {row.identity for row in test}
    cursor = 0
    waiting: list[Attempt] = []
    learned: list[Attempt] = []
    results = {}
    for current in sorted(rows, key=lambda row: (row.evaluated_at, row.identity)):
        while cursor < len(events) and events[cursor].resolved_at < current.evaluated_at:
            waiting.append(events[cursor])
            cursor += 1
        remaining = []
        for labelled in waiting:
            if labelled.service_date < current.service_date:
                model.learn_one(labelled.features(), labelled.outcome_platform)
                learned.append(labelled)
            else:
                remaining.append(labelled)
        waiting = remaining
        if current.identity not in test_ids:
            continue
        reason = eligibility(learned, settings)
        if any(row.service_date >= current.service_date for row in learned):
            reason = "nonmonotonic_service_date"
        if reason is None and current.context not in {row.context for row in learned}:
            reason = "unseen_context"
        probabilities = {} if reason else model.predict_proba_one(current.features())
        prediction = decision(probabilities, settings, reason)
        prediction.update({
            "trainedServices": len(learned),
            "latestTrainingResolutionAt": max((r.resolved_at for r in learned), default=None),
            "latestTrainingServiceDate": max((r.service_date for r in learned), default=None),
        })
        results[current.identity] = prediction
    return [results[row.identity] for row in test]


def metrics(rows: list[Attempt], predictions: list[dict], as_of: int) -> dict:
    labelled = [(row, p) for row, p in zip(rows, predictions) if row.label_available(as_of)]
    evaluated = [(row, p) for row, p in labelled if p["platform"] is not None]
    predicted = sum(p["platform"] is not None for p in predictions)
    truth = [row.outcome_platform for row, _ in evaluated]
    guesses = [p["platform"] for _, p in evaluated]
    labels = sorted(set(truth + guesses))
    reasons = {}
    for p in predictions:
        reasons[p["reason"]] = reasons.get(p["reason"], 0) + 1
    return {
        "attempts": len(rows), "predicted": predicted, "abstained": len(rows) - predicted,
        "labelled": len(labelled), "evaluatedPredictions": len(evaluated),
        "unlabelled": len(rows) - len(labelled),
        "correct": sum(actual == guessed for actual, guessed in zip(truth, guesses)),
        "coverage": predicted / len(rows) if rows else None,
        "publishedPlatformAgreement": float(accuracy_score(truth, guesses)) if truth else None,
        "confusionLabels": labels,
        "confusionMatrix": confusion_matrix(truth, guesses, labels=labels).tolist() if labels else [],
        "reasons": reasons,
    }


def paired_comparison(rows, baseline, challenger, as_of):
    pairs = [(row, base["platform"], other["platform"])
             for row, base, other in zip(rows, baseline, challenger)
             if row.label_available(as_of) and base["platform"] is not None and other["platform"] is not None]
    return {
        "bothPredictedAndLabelled": len(pairs),
        "baselineCorrect": sum(base == row.outcome_platform for row, base, _ in pairs),
        "challengerCorrect": sum(other == row.outcome_platform for row, _, other in pairs),
    }


def evaluate(rows: list[Attempt], settings: Settings, as_of: int) -> dict:
    rows = sorted((row for row in rows if row.evaluated_at <= as_of),
                  key=lambda row: (row.evaluated_at, row.identity))
    if len({row.identity for row in rows}) != len(rows):
        raise ValueError("Duplicate independent services; use the read-only loader")
    train, test, cutoff = temporal_split(rows, settings, as_of)
    cat, cat_status = catboost_predictions(train, test, settings)
    river = river_predictions(rows, test, settings, as_of)
    baseline = [{"platform": row.predicted_platform, "score": None,
                 "reason": "recorded_prediction" if row.predicted_platform is not None else "recorded_abstention"}
                for row in test]
    engines = {BASELINE: baseline, "catboost-experimental-v1": cat, "river-experimental-v1": river}
    status = "insufficient_data" if not test or cat_status != "fitted" else (
        "evaluated" if any(row.label_available(as_of) for row in test) else "no_evaluable_labels"
    )
    return {
        "schemaVersion": 1,
        "mode": "offline_replay_not_production",
        "status": status,
        "asOf": as_of,
        "dataSha256": dataset_hash(rows),
        "settings": asdict(settings),
        "versions": {package: version(package) for package in ("scikit-learn", "catboost", "river")},
        "featureSchema": list(FEATURES), "featureTimezone": "Europe/Madrid",
        "scoreMeaning": "Uncalibrated model score, not guaranteed probability",
        "outcomePolicy": "first-later-fresh-stopped-at-publication",
        "trainingPolicy": "Earlier service dates; label resolved strictly before prediction/cutoff",
        "riverPolicy": "Fresh delayed-label replay; can learn earlier holdout-day labels on subsequent service dates",
        "counts": {"services": len(rows), "serviceDates": len({r.service_date for r in rows}),
                   "labelledAsOf": sum(r.label_available(as_of) for r in rows),
                   "batchTrainingServices": len(train), "holdoutServices": len(test)},
        "split": {"trainingCutoffAt": cutoff, "holdoutDates": sorted({r.service_date for r in test}),
                  "trainingDates": sorted({r.service_date for r in train})},
        "catboostStatus": cat_status,
        "engines": {name: metrics(test, predictions, as_of) for name, predictions in engines.items()},
        "pairedWithBaseline": {name: paired_comparison(test, baseline, predictions, as_of)
                               for name, predictions in engines.items() if name != BASELINE},
        "predictions": [{
            "serviceDate": row.service_date, "tripId": row.trip_id, "stationId": row.station_id,
            "evaluatedAt": row.evaluated_at,
            "publishedOutcome": row.outcome_platform if row.label_available(as_of) else None,
            "engines": {name: predictions[index] for name, predictions in engines.items()},
        } for index, row in enumerate(test)],
        "limitations": [
            "Agreement is with a Renfe publication, not verified physical departure.",
            "Coverage differs by model; compare paired results and labelled counts, not accuracy alone.",
            "Scores and minimum training counts are experimental, not calibrated safety guarantees.",
            "Retained first-checkpoint cohort is selective; missing labels and downtime can bias results.",
            "Do not tune settings on this holdout then claim it as an untouched final test.",
            "No model is promoted or used by the passenger app by this command.",
        ],
    }
