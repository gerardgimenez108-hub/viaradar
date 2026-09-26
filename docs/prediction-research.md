# Reusable prediction tools — GitHub research

Research snapshot: **27 September 2026**. Documentary review only; no package installed, trained or benchmarked on ViaRadar data. In this bounded search, no ready-made, validated Renfe/L'Hospitalet platform predictor was found. Delay prediction or railway simulation projects are not evidence of platform-allocation accuracy.

## Shortlist

| Project | Why it may help | Verified licence/activity | Integration tradeoff |
| --- | --- | --- | --- |
| [scikit-learn](https://github.com/scikit-learn/scikit-learn) | Offline baselines, evaluation, metrics and probability calibration | BSD-3-Clause; [1.9.1 release](https://github.com/scikit-learn/scikit-learn/releases/tag/1.9.1), 11 September 2026; repository not archived at research time | Separate Python experiment environment; no need to replace the Node API. Does not correct biased/missing labels |
| [CatBoost](https://github.com/catboost/catboost) | Candidate challenger for categorical inputs such as line/destination plus time bands and service-day features | Apache-2.0; [1.2.10 release](https://github.com/catboost/catboost/releases/tag/v1.2.10), 19 February 2026; repository not archived at research time | Train offline with Python/CLI. Official [Node package](https://github.com/catboost/catboost/blob/master/catboost/node-package/README.md) applies trained models using native binaries; it does not train. Windows compatibility has not been tested here |
| [River](https://github.com/online-ml/river) | Later option for incremental learning and delayed-label evaluation if operating patterns demonstrably drift | BSD-3-Clause; [0.26.1 release](https://github.com/online-ml/river/releases/tag/0.26.1), 21 August 2026; repository not archived at research time | Stateful Python model/process adds deployment and recovery work. Update once per labelled service, not every 20-second snapshot |

Recheck releases, licences and dependencies before installation or redistribution. Activity is not a guarantee of model suitability or maintenance support.

## Recommendation

Use the current [measurement phase](predictions.md) first. **scikit-learn for an isolated evaluation workspace and a small CatBoost model as the first challenger** is a reasonable experiment, not an adoption decision or a claim of improvement. River is deferred until there is evidence that incremental adaptation is needed.

CatBoost's [categorical feature support](https://catboost.ai/docs/en/features/categorical-features) matches the shape of potential inputs. Whether it beats the existing modal-frequency engine is unknown. With little representative data, the simpler baseline may be better.

### First experiment, when data permits

1. Export a versioned dataset of independent service checkpoints with their frozen point-in-time context and later published labels. Do not reconstruct old features from a newer timetable or use fields learned after the checkpoint.
2. Split into explicit **service-date blocks**. Train/tune on older days and evaluate on untouched later days; all snapshots/checkpoints of one service remain in one partition. Generic random splits would leak related examples.
3. Compare the unchanged baseline and a small candidate on identical eligible checkpoints. Report published-platform agreement, coverage, unlabelled fraction and lead time, broken down by line/destination and date where samples permit.
4. Keep new predictions in shadow mode until they show a useful improvement. Do not select a threshold and claim its performance on the same examples used to tune it.

There is no universal sufficient row count: diversity of days, services, platform outcomes and conditions matters. Thousands of copies of one train do not replace independent examples.

## Evaluation references and caveats

- [scikit-learn TimeSeriesSplit](https://scikit-learn.org/stable/modules/generated/sklearn.model_selection.TimeSeriesSplit.html): future data must not train a model evaluated in the past. Equally spaced samples are needed for comparable fold durations; train services are irregular, so explicit service-day blocks are preferable here.
- [scikit-learn probability calibration](https://scikit-learn.org/stable/modules/calibration.html): calibration data must be separate from fitting data; isotonic calibration can overfit with small samples. Historical share is not automatically calibrated confidence.
- [River delayed progressive evaluation](https://riverml.xyz/latest/api/evaluate/progressive-val-score/): models can be evaluated with labels revealed later, matching the structure of publication delays. It does not make those labels proof of a physical departure.

No model can guarantee every platform decision, particularly when the operator changes it after prediction or never publishes usable evidence. Preserve abstention and prioritize validated publications over guesses.
