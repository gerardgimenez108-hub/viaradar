# Run prediction experiments without changing the app

The `ml/` workspace compares the recorded historical baseline with **CatBoost** and **River**, using **scikit-learn** metrics. It reads prospective checkpoints from SQLite in read-only mode. It does not change the collector, serve predictions to passengers, or promote a model automatically.

## Quick start — Windows

Use a separate Python 3.11 environment from the repository root. Do not install into the Node server or another application's Python environment.

```powershell
py -3.11 -m venv .venv-ml
.\.venv-ml\Scripts\python.exe -m pip install -r ml/requirements.txt
.\.venv-ml\Scripts\python.exe -m pytest ml/tests -q
.\.venv-ml\Scripts\python.exe -m ml --db data/viaradar.sqlite --output data/ml/report.json
```

If `py -3.11` is not registered, use the absolute path of an installed Python 3.11 executable for the first command. The configured host already has `.venv-ml`; subsequent runs need only the final command. Dependencies are pinned to the tested environment. Generated reports stay under ignored `data/`; the virtual environment is ignored too.

## Automatic evaluation on the Windows host

After installing the Python environment, register the independent worker:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-ml-autostart.ps1 -RunNow
```

The task runs at Windows sign-in and hourly while the user is signed in and the PC is awake. It does not replace the existing 20-second collector. Each run reads the newly accumulated checkpoints, trains/evaluates when the minimum data guards are met, and rebuilds River's delayed-label replay. There is no automatic promotion to passenger predictions.

- `data/ml/report.json`: latest successful report, replaced atomically.
- `data/ml/status.json`: latest run status/error, last success and counts.
- `data/ml/history/`: dated successful reports, retained for at most 30 days and 720 reports.

An `insufficient_data` report means the task worked but the dataset cannot support the configured evaluation yet. Errors preserve the last successful report; check the status timestamp rather than assuming an old report is current. Overlapping task runs are prevented. A separate OS lock also protects manual runner launches. The Node API is not restarted by this worker.

To run one protected evaluation manually:

```powershell
.\.venv-ml\Scripts\python.exe -m ml.runner
```

Inspect or disable only this worker (not the live server):

```powershell
Get-ScheduledTaskInfo -TaskName 'ViaRadar ML Experiments'
Get-Content data/ml/status.json
Disable-ScheduledTask -TaskName 'ViaRadar ML Experiments'
```

Disabling prevents future triggers; it does not stop an already-running evaluation. Task runs are bounded to 20 minutes, with at most two retries five minutes apart after failure. The worker is separate from `ViaRadar Local Server`.

## What the experiment measures

- Inputs are frozen first-eligible checkpoints from `prediction_attempts`, not repeated 20-second snapshots or reconstructed historical schedules.
- Features use station, line, destination, service weekday, scheduled local time in Europe/Madrid and expected delay at the checkpoint. Trip identifiers identify independent services; they are not predictive features.
- Labels are later published stopped-at platforms. They are **not proof of the physical departure platform**. Missing labels cannot count as successes or errors.
- The baseline uses its originally recorded prediction or abstention. Candidate results are offline replay, not evidence that they ran live at the time.
- Coverage and agreement must be read together: a model can look accurate by making very few predictions. Model scores are not calibrated success probabilities.

## Fixed experiment settings

The CLI defaults to the last **2 service dates** for holdout and requires at least **50 eligible training labels across 3 earlier dates**, with at least two platform classes. These are conservative experiment guards, not a claim that five days prove quality. The default abstention threshold is **0.8**, with **100 CatBoost iterations**. Run `python -m ml --help` for reproducible overrides; record them rather than adjusting them until a holdout score looks good.

Training labels must have become available before the prediction being evaluated. Their availability is `resolved_at`, not the earlier source publication timestamp. Service-date blocks prevent a train's repeated history from crossing the split. An insufficient-data report is a valid result; do not lower guards just to manufacture an accuracy number.

CatBoost is fitted once using earlier service dates with labels known strictly before the first holdout checkpoint. River replays checkpoints chronologically and may learn a label from an earlier holdout day before predicting on a later day, but never before the label was resolved. This is a comparison of a fixed batch model and a progressively updated policy, not two frozen models. The report includes each River prediction's training count and latest training timestamps for inspection.

Reports contain the settings, dependency versions, feature schema and dataset hash, plus predictions and paired comparisons with the baseline. The hash identifies the loaded dataset; it is not a dataset backup. The collector retains only 90 days of attempts, so archive consistent database snapshots separately when experiments need long-term reproducibility.

## Safe boundaries

The experiment never imports the Node store or writes to the live database. It does not train on legacy `observations`: those records lack frozen checkpoint context and cannot establish prospective performance. The optional Windows scheduled task is independent of the API. It adds no cloud service or model download service. Deploying the Firebase frontend does not activate this worker.

River's state is rebuilt by replaying eligible checkpoints on each run. This demonstrates incremental `learn_one` updates with delayed labels; it is not an always-running adaptive production model. Persistent state, recovery, drift monitoring and production fallback require a separate design before activation.

## Before promoting a candidate

The separate [assignment capture](assignment-evidence.md) preserves previously discarded R1 assignments. The current ML loader intentionally still reads `prediction_attempts`, not `assignment_events`: recovered assignments are not automatically new scored predictions or stopped-platform outcomes. An assignment-target experiment needs its own versioned evidence/evaluation policy before adoption.

Collect multiple representative days, inspect label availability and errors by line/destination, fix parameters on development data, then evaluate untouched later days. Repeatedly tuning against the same report makes that report development evidence, not a final test. Minimum sample guards are execution safeguards, never a statistical guarantee. Keep `historical-frequency-v1` serving passengers until a separate rollout is justified and approved.

See [measurement contracts](predictions.md), [research and licences](prediction-research.md) and [executed checks](verification.md).
