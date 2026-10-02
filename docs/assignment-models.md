# Evaluate R1 published assignments separately

The hourly ML worker now evaluates the assignment history that the original stopped-platform experiment could not use. This is a **shadow evaluation, not a new public predictor**. A published assignment is not independent proof of a physical departure.

## Run and inspect

From the repository root, using the existing isolated environment:

```powershell
.\.venv-ml\Scripts\python.exe -m ml.runner
Get-Content data/ml/status.json
Get-Content data/ml/assignment-report.json
```

The existing Windows task runs this same worker hourly while the PC is awake and the user is signed in. No new task, API restart, or frontend deployment is required. The existing stopped-platform experiment keeps its original `report.json`; the new target has a separate `assignment-report.json` and nested `assignmentEvaluation` status. On failure the prior successful report is retained, status records the error, and the worker exits unsuccessfully. Always check report timestamps. The additional evaluation has a 60-second limit after the original 18-minute limit, within the task's 20-minute execution budget.

## What qualifies as an example

| Boundary | Policy |
| --- | --- |
| Independent service | One station, service date and trip; never one example per 20-second snapshot. |
| Inputs | First immutable live schedule context: station, line, destination, weekday and local scheduled minute. No reconstructed old timetable or invented historical delay. |
| Prediction point | Ten minutes before scheduled departure; the context must already have been captured and no platform publication received. |
| Outcome | Last fresh outbound platform publication received after the checkpoint and by scheduled departure plus two hours. |
| Learning time | Only after that entire outcome window closes; a later change inside the window must not leak into an earlier prediction. |
| Ambiguity | Conflicting identities, contradictory latest publications or invalid timing cannot become labels. No publication means unevaluable, not an error or an invented platform. |
| Temporal evaluation | Earlier service dates train; the last two service dates are held out. River learns only resolved labels from earlier dates. |

The first immutable contexts were collected on 29 September. Older assignment events cannot safely be given schedules from a newer GTFS file. A label is the last **observed publication within the fixed window**, not a guarantee that nothing changed during collection gaps or after the window.

## Models and decision gates

- **CatBoost** compares contextual patterns separately for each line.
- **River** replays delayed learning from scratch each run; it does not persist an unvalidated model into the app.
- **Destination frequency** is a reference trained on this same assignment target, not the app's recorded historical predictions.
- **scikit-learn** supplies evaluation metrics, not an additional prediction engine.

The main experiment retains the existing minimum of 50 training services over three training dates, with two held-out dates and a 0.8 model-score threshold. Scores are uncalibrated: 0.8 is not proof of 80% real-world accuracy. Exploratory walk-forward folds allow smaller training sets for diagnosis only; they cannot authorize deployment. Compare coverage, labelled counts, per-line results and same-case outcomes, not a pooled accuracy figure.

## Next decision

### First real run — 2 October 2026, 21:51 CEST

Both evaluations completed successfully through the protected hourly runner. The assignment cohort contained 163 eligible checkpoints and 75 closed, labelled outcomes across both lines. R1 contributed **149 checkpoints and 73 labelled outcomes**; R4 contributed 14 and 2. This is a different target from the 13 strict R1 observations used by the public predictor, not a sixfold improvement in accuracy.

For R1, keeping 1–2 October held out left only **19 training examples from 30 September**, so the main experiment correctly reported `insufficient_data`. Exploratory CatBoost fits were possible: training on 19 examples for 1 October gave a maximum score of 0.238; training on 54 for 2 October gave 0.348. Both were below 0.8 for every case. These uncalibrated scores are **not measured success rates**. Neither a reliable R1 model nor a delivery date is established.

The original stopped-platform experiment also continues hourly. Its 21:22 audit had 5 R1 training labels versus 324 R4 labels and no R1 predictions. On the same 239 evaluable R4 cases, CatBoost and the recorded baseline each matched 235 publications; this does not demonstrate an improvement or establish R1 accuracy.

Continue collecting immutable contexts and evaluate new dates automatically. Inspect the per-line exclusion counts to distinguish missing publications from late context capture. Only consider a separately approved passenger rollout after sufficiently broad future-day validation demonstrates useful coverage and reliable agreement against the same-target reference. More days alone do not guarantee this: destination and time may not contain enough information about operational platform choices.

Rollback boundary: remove the assignment subprocess from `ml/runner.py` and the new assignment modules/tests. Leave existing observations, assignment capture, original reports and the public predictor untouched. All generated reports and databases stay ignored by Git.
