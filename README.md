# miles-viewer: the run viewer

The run monitor that was `miles_ext/monitor/` in the Miles fork, now on the launcher side. It stands in for where the
launcher will live. The fork's image only reports: this reads those reports, and it has no code in the image.

**With no provider.** Set `providers = []` in `monitor.toml`, and it needs no Modal or Sail. It gets runs from:

- **Pushes:** set `MILES_UI_TOKEN` (or `ingest_token`) here, and on each node `MILES_STATE=http`,
  `MILES_STATE_URL=<viewer>/ingest` and `MILES_STATE_TOKEN=<the same token>`. Nodes put heartbeat, exit and pool load there.
- **Shared storage:** `results_dirs = {name = "/mnt/results"}` reads `<dir>/<run_id>/`: `recipe-*.json`, `exit.json`,
  `state/`, `logs/trainer-0.log` and `trials/`, the same as it reads a Modal volume.

With Modal or Sail in `providers`, everything below still works as it did.


A read-only web page over your runs: what is live now, what happened, every run and attempt, trial progress from
the results volumes, Modal apps and their cost, Sail apps and W&B runs. It never starts, stops or deletes
anything, so it is safe to share. A stdlib Python server (`server.py`) and a plain JS page, no build step.

First run, in order: install, pick a data dir, start the page, then launch with the same data dir set.

```bash
pip install modal wandb pyyaml                   # Python 3.11+; plus the Sail SDK if you use Sail sandboxes
                                                 # --tunnel also needs cloudflared on PATH
export MILES_MONITOR_DIR=~/miles-monitor          # data dir (default ~/.miles-monitor)
export MILES_DOTENV_DIR=<dir with .env>           # optional: Modal, W&B and Sail keys, as for the launcher
./start.sh                        # http://127.0.0.1:8787, detached; stop.sh stops it
./start.sh --tunnel               # adds a cloudflared quick tunnel behind basic auth; prints the URL
```

With `MILES_MONITOR_DIR` set when you launch, `modal run -m miles_ext.launch.modal_app` registers each launch
itself, and the run shows up within seconds. Redirect the launch output to a file
(`modal run --detach ... > <run_id>.log 2>&1`) so the page can also tail the log: startup stages, per-step
training numbers and error signals all come from it.

- **Access.** The server binds to 127.0.0.1 only. `--tunnel` starts a [cloudflared](https://github.com/cloudflare/cloudflared)
  quick tunnel (a random `trycloudflare.com` URL, kept across server restarts, saved in `url.txt`) and turns on
  basic auth with `auth.txt` (`user:password`, made on first use). `--tunnel --no-auth` makes a public page:
  read-only and redacted, but anyone with the URL can read it. Logs: `server.log`, `tunnel.log`.
- **Data dir** (`MILES_MONITOR_DIR`): `manifests/` (one file per launch attempt), the optional files below,
  and what the server writes: `state.json` (last state, so a restart serves at once), `history/` (events,
  curves, GPU samples, JSONL) and `cache/` (finished trials, eval summaries). Plain files, no database.
- **Credentials.** `MODAL_TOKEN_ID`/`MODAL_TOKEN_SECRET` (or a Modal profile), `WANDB_API_KEY`, `SAIL_API_KEY`;
  any that is missing turns off that source only. `.env` values and token-shaped strings never reach the page.

## Config: `<data dir>/monitor.toml`

Every key is optional; `config.py` owns the defaults, which follow the launcher's own names.

| Key | Default | What |
| --- | --- | --- |
| `title` | `Miles run monitor` | page title |
| `port` | `8787` | local port (`MONITOR_PORT` overrides) |
| `modal_cli` | `modal` on `PATH` | the Modal CLI the server calls |
| `modal_workspace`, `modal_environments` | active profile's workspace, `["main"]` | where apps are listed |
| `app_prefixes` | `["miles-"]` | only Modal and Sail apps with these name prefixes are shown (in a shared workspace, your names) |
| `launcher_apps` | `[$MILES_APP_NAME or "miles-fork"]` | the launcher's app names: one holding GPUs with no manifest is flagged |
| `results_volumes` | `[$MILES_RESULTS_VOLUME or "miles-fork-results"]` | every top-level dir is a run; trials are read from here |
| `sandbox_app_prefix` | `miles-mobius-` | sandbox app of a run without one in its manifest |
| `wandb_entity`, `wandb_project_prefix` | the API key's default entity, `""` | W&B runs listed (last 21 days) |
| `dotenv` | `$MILES_DOTENV_DIR/.env` | its secret values are redacted |
| `host_root`, `doc_globs` | none | a dir whose matching files the Notes tab lists; log paths show relative to it |
| `extra_manifest_dirs` | `[]` | more manifest dirs to read |
| `providers` | `["modal", "sail"]` | which provider sources run |
| `results_dirs` | `{}` | name to a mounted results dir, read like a volume |
| `ingest_token` | `$MILES_UI_TOKEN` | the token nodes push with; unset turns `/ingest` off |

Optional files in the data dir, re-read while running: `runs.json` (`{"runs": [{"run_id", "title", "notes", ...}]}`,
titles for runs with no manifest), `groups.json` (run groups, below) and `workstreams.json` (GPUs tab).

## How a run gets here: launch manifests

A launch writes `manifests/<app_id>.json` before any GPU work: one file per attempt (run id, attempt = Modal app
id, start time, expected steps and trials, limits, sandbox app, W&B project, from the recipe) plus `log_path`,
filled in when the launcher's stdout is redirected to a file (`modal run --detach ... > launch.log`). It
is found through `/proc/self/fd/1`, so on Linux only; elsewhere attach the log with `register.py` (below). The
monitor picks a new manifest up within 2 s.

- `miles_ext.launch.modal_app` writes it itself when `MILES_MONITOR_DIR` is set (`manifest.register_launch`).
  Other launchers call `manifest.write_manifest(app_id, run_id, **fields)`.
- `python -m miles_ui.register <run_id> <launch log> <recipe yaml> [--title ...] [--notes ...]`
  registers a run by hand (a launch without `MILES_MONITOR_DIR`, a backfill) or adds a title and notes; it waits
  for the app URL in the log. Any launcher app that holds GPUs for 15 min with no manifest shows in the feed as
  "isn't registered with the monitor".
- The newest attempt of a run decides its GPU app (by id, so a second app with the same name never
  confuses it), which trial dirs count (those started after it) and its limits. Earlier attempts stay as
  records with their own window of trial dirs, state and outcome. Every results-volume dir shows up as a run
  without a manifest; manifests with `"backfilled": true` were written after the fact.

## Live updates

The page long-polls `/api/poll?since=<version>`; the server answers the moment a topic changes (only the
changed topics) or after 25 s. Long-poll rather than an event stream because the Cloudflare quick tunnel
holds back streamed responses for tens of seconds.

Where changes come from, fastest first:
- **Launch logs** (`log_path`), tailed every second: startup stages, SGLang decode/prefill lines (engine
  curves), Harbor trial outcomes and setup failures, error signatures. A trial-outcome line triggers a trial
  scan at once, so its result shows within seconds instead of at the next scan.
- **Manifests**, checked every 2 s.
- **Results volume** trial scans: every 12 s while a watched run has trials in flight, 45 s otherwise.
  A trial's phase only moves forward, so a scan re-reads only what could have changed (1 to 2 Volume calls per
  live trial). Finished trials are cached in `cache/`.
- Modal app list 30 s, Sail 45 s, W&B 2 min, watchdog status 15 s.
- **Cost**: `modal billing report` (hourly, by resource, last 7 days, the most an hourly report spans), every
  5 min. Shown per run (its attempts' GPU apps plus a Modal sandbox app), per attempt and per app. It is
  Modal's own bill, about an hour behind; run pages add a labelled estimate for the time since (below). Sail has
  no cost API, so Sail sandboxes are not priced.

`state.json` keeps the last state, so a restart serves the page at once. `history/events.jsonl` is the
"What happened" feed; `history/<run>.jsonl` the curves.

## Training runs

A training run's manifest carries `"kind": "train"` and `"expected_steps"` (= `num_rollout`). The launch log
then also yields, from Miles' own per-step lines (`rollout N: {...}`, `step N: {...}`, `perf N: {...}`), each
step's reward, group stats, truncation, staleness, grad norm, train/rollout log-prob gap, step and weight-sync
time; checkpoint saves ("successfully saved checkpoint from iteration N"); weight syncs (start, end, failures);
and the launcher's exit record. The run page shows a Training panel (tiles plus every step), "Per task over
steps" (mean reward of the trials that finished during each step; trials don't record their step, so this bins
by finish time) and a Training group of curves. Engine curves sum over all engines that log.

## SFT runs

An SFT run (no engines, no trials) registers with `"kind": "sft"` and `"expected_steps"`. Its own Modal app writes
the manifest with `manifest.write_manifest(app_id, run_id, kind="sft", expected_steps=..., gpu=..., wandb={...})`,
or by hand once the log names the app:

```bash
python -m miles_ui.register <run_id> <launch log> --kind sft --expected-steps 1000 \
    --gpu "1x H200:8" --wandb-project miles-sft --hard-stop-h 24 --title "..."
```

From the launch log: Miles' `step N:` lines (train loss, grad norm, `lr-pg_0`), `perf N:` lines (trainer tokens/s, MFU),
`validation at step N: {'val/nll': ...}` (`miles_ext.sft` validation; N = optimizer steps done, 0 = before training),
checkpoint saves and HF exports ("Successfully saved HuggingFace model to ..."). Step time is the wall time between
step lines when the run logs none. The run is type `sft` (its own tab), its row shows the loss sparkline and the last
validation NLL, and its page has an SFT panel and loss, validation NLL, LR and tokens/s curves on the step axis. Signals:
a non-finite train/loss, no step for the greater of 3 median steps and 45 min (60 min after Ray is up before the first
step), step pace against `hard_stop_h`. It reads "finished" once every expected step is logged. A run registered as `train` and edited to `sft` takes the new
kind at once; restart the monitor to rebuild its loss curve from the log.

**Evals of its checkpoints.** An eval run says what it evaluates; the SFT run's page lists every such eval with pass@k
(unbiased, over tasks with at least k finished trials; k = the eval's `n_samples`) and pass@1. Both count each
task's first k trials by start: when Miles refills aborted groups by re-sampling the whole batch, the later trials are
marked refill extras (faded on the eval page) and left out; the page also shows the numbers with them. In the eval's manifest or
`runs.json` entry: `"evaluates": {"run": "<sft run id>", "step": <steps trained, 0 = base model>, "label": "..."}`, or
`register.py <eval run id> <eval log> <eval recipe> --evaluates <sft run id>@<step>`. Eval rows with k > 1 show pass@k.

## GPUs tab

Every GPU the shown Modal apps (`app_prefixes`, first of `modal_environments`) hold right now, what it is for, and the last 24 hours.

- Source: `gpus_probe.py`, run every 30 s in a subprocess, asks the internal API the Modal CLI uses: the
  container list (running and queued containers, each with its GPU type) and, once per app, each function's GPU
  type and count. So every app shows, with or without a launch manifest; a manifest only adds run id and title.
  A container's GPU count is its function's count; when one app has two functions of one GPU type with
  different counts (or it is a sandbox), the count shows as "?" and stays out of the total.
- What an app is for: `workstreams.json` (optional; first match wins), e.g.
  `{"workstreams": [{"match": "^miles-me-", "name": "My runs", "role": "train", "owner": "me", "purpose": "..."}]}`. Add a line when a new app prefix appears; it is re-read on every pass.
- Cost: Modal's billing report only. "Billed, last full hour" is the newest whole billed hour of each live app
  (an app's first hour and the newest bucket can be partial); apps younger than that say so.
- Timeline: `history/gpus.jsonl` (a sample per change and every 5 min) for GPUs in use and per-app lanes, plus
  Modal's hourly GPU charges per workstream.

## Signals

On live runs, from the manifest limits:
slow to serve, ready but no model calls, no decode line or outcome while trials run, share of failed outcomes
in the last 10 min, most finished trials ending in exceptions, trials past 80% of the trial cap, fewer live
sandboxes than trials in flight, and whether the current pace finishes before the hard stop. Training runs add: no
step for 3x the median step time (before the first step: the trial cap plus 30 min), a weight sync running
over 15 min, failed weight syncs, a trainer exit other than success, and step pace against the hard stop.

## API (read-only)

`/api/state` (full snapshot; scripts that watch a run read `runs[].run_id`, `runs[].registry.sandbox.app`,
`runs[].trials.{dirs,phases,finished,solved,exceptions}`, `startup[<run>].stage`, `sail[<app>].live`; keep these),
`/api/poll`, `/api/series?run=&max=`, `/api/events?run=`, `/api/loglines?app=&after=`, `/api/logs?app=`
(Modal log tail), `/api/docs`, `/api/doc?f=`, `/api/wandb/keys|series`, `/api/detail?run=<key>` (one run's detail,
for the compare page), `/api/eval?run=` (a script eval's or bench's `summary.json`), `/api/evaltries?run=&level=&kind=`
(a few sampled answers of an OOD-task eval).

Never rendered: `.env` values and anything token-shaped (HF, Modal, Sail, Docker, GitHub, AWS, Slack, JWT,
URL passwords, `api_key=`/`token:` values) are scrubbed from every response.

## Groups, run types, compare, eval pages

- **Groups and types.** `groups.json` in the data dir (optional) is the one place that says which group a run belongs to and its type: `train`
  (RL training), `eval` (quality eval), `bench` (inference speed/correctness), `smoke` (smokes, probes, profiles) or
  `other` (result dirs with no launch record, hidden by default), plus `sft` (manifest kind `sft`). The first regex matching the run id wins; an
  unmatched run is grouped by its id prefix. Format: `{"rules": [["^smoke-", "Smokes", "smoke"], ["^grpo-math-", "GRPO math", "train"]]}`
  (regex, group label, type). `groups.py` applies it and the server adds `group` and `type` to every
  run. New campaign: add one rule. The registry's `kind` is not used for this (most benches were registered `train`), except `sft`.
- **Runs tab.** Groups, newest first; a group with a run in the last 3 days opens by default. Tabs filter by type.
  Each row shows what the run produced: the reward over steps (sparkline, last value), the trial mean reward, or the
  eval/bench headline from its `summary.json` (pass@1, best decode tok/s, checks passed).
- **Compare.** Tick two runs of one group (or "Compare with…" on a run page): `#tab=compare&a=<key>&b=<key>`. Facts
  side by side with B's change, per-step training curves overlaid, engine/GPU/trial curves per step or by time since
  start, and per-level, per-arm or per-task tables for evals.
- **Trial evals** (type `eval` with trial dirs, e.g. a training launch with `--debug-rollout-only`): the headline is
  pass@k, pass@1 and tasks solved; the page has no training panel or trainer lane, and its phases chart shows engine
  startup and trials in flight only.
- **Eval and bench pages.** Result first: the levels table with answer kinds and sampled answers (OOD tasks), the arms
  × concurrency throughput table (ITP/ITR benches), or the checks table (SC checks). Read from
  `<oodtask|inference-throughput|sc058>/<run_id>/summary.json` on the first results volume; cached in `cache/eval/` once the
  run has ended. New eval dir: add it to `EVAL_DIRS` in server.py.
- **Curves.** "x: step" puts engine, GPU and trial charts on the training-step axis: each point is the mean of the
  samples in that step's window (previous step's end, this step's end], from the `step N` log lines. Each group shows
  its key charts; "show N more" opens the rest.
- **Phases over time.** Hover reads out every lane at that moment (engine stage, trainer phase with that step's
  reward, trials in flight); drag to zoom, click a step to zoom to it, double-click to reset.
- **Status.** A run that ended without finished trials reads "stopped" (its app was stopped) or "ended", not "idle".

## Training-run phases, per-node GPUs, live cost
- **Phases over time** (run page, training runs): engine startup, the trainer's phases from rank 0's Megatron timers
  (`Timer train_wait|update_weights|train start/end`: waiting for a batch, weight sync, step N) and trials in flight,
  on one PT axis. The "training" stage now starts at the first `Timer train start`, not at the end of step 0.
  The headline says "Rollout only: filling batch k" until a step really trains, with an estimate of usable groups
  (needs `batch_size`, `n_samples`, `group_filter` in the manifest; register.py writes them) and the groups the
  nonzero_std filter dropped.
- **GPU curves per node**: W&B system keys labelled `/l:<role>-node<k>` (ext-015) become series `<name>@<label>`;
  one line per node, trainer blue, rollout orange. Unlabelled runs keep one line.
- **Curve zoom**: each time chart spans its own first to last point. Drag across a chart to zoom that chart only
  (W&B style, kept across refreshes); double-click resets it; a plain click enlarges it.
- **Cost**: Modal bills an hour after it ends. The page adds `unbilled` (est.) since the newest billed hour at that
  hour's cost per GPU-second (GPUs tab history), shown as "~$X". The billing report runs every 5 min.
- The run page's "What happened" is a full-width fold above the curves; curves have a charts-per-row toggle.
