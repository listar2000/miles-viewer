"""Launch manifests for the run monitor: one file per launch (attempt), <data dir>/manifests/<app_id>.json.
The monitor reads only these (plus runs.json history), so nothing is edited per run.

A launcher writes one itself when MILES_MONITOR_DIR is set (`miles_ext.launch.manifest` in the fork, for its stand-in
caller); other launchers call `write_manifest`, and `register.py` adds one by hand after the fact.

Known fields (all optional except the two ids): title, kind, campaign, gpu, gpu_app_name, sandbox {provider, app},
wandb {project}, expected_steps, expected_trials, batch_size, n_samples, group_filter, stale_secs, limits
{agent_secs, trial_secs, verifier_secs, turns, context, hard_stop_h}, launcher, recipe, docs, notes. kind is
"train" for RL (the recipe's), "sft" for a trainer-only SFT run; an eval of a training run's checkpoint adds
evaluates {run, step, label} (step = optimizer steps trained, 0 = the base model). `log_path`
(the launcher's own stdout, when it is redirected to a file) is filled in here: the monitor tails that file for
live stage, engine and trial-outcome events.
"""

import json
import os
import time
from pathlib import Path

from . import config


def _stdout_file() -> str | None:
    try:
        p = os.readlink("/proc/self/fd/1")
    except OSError:
        return None
    return p if p.startswith("/") and os.path.isfile(p) else None


def write_manifest(app_id: str, run_id: str, overwrite: bool = True, **fields) -> Path:
    """Write (or add to) one attempt's manifest. Fields already in the file are replaced by the given ones, or
    kept with overwrite=False (the launcher's own record never replaces what register.py wrote)."""
    path = config.DIR / "manifests" / f"{app_id}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    m = json.loads(path.read_text()) if path.exists() else {}
    m.setdefault("started_at", time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
    if "log_path" not in m and _stdout_file():
        m["log_path"] = _stdout_file()
    m = (m | fields) if overwrite else (fields | m)
    m |= {"run_id": run_id, "app_id": app_id}
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(m, indent=1))
    tmp.replace(path)
    return path


def fields_from_recipe(recipe: dict, run_id: str) -> dict:
    """What a training run's manifest says about it, from its recipe: shape, limits, sandbox app, W&B project."""
    cl, al, ag, sb = (recipe.get(k) or {} for k in ("cluster", "algorithm", "agent", "sandbox"))
    steps, batch, n = al.get("num_rollout"), al.get("rollout_batch_size"), al.get("n_samples")
    project = (recipe.get("tracking") or {}).get("wandb_project")
    limits = {
        "agent_secs": ag.get("timeout"),
        "trial_secs": ag.get("trial_timeout"),
        "verifier_secs": ag.get("verifier_timeout"),
        "turns": ag.get("max_steps"),
        "context": (recipe.get("rollout") or {}).get("context_length"),
        "hard_stop_h": cl.get("timeout_hours"),
    }
    return {
        "title": f"{recipe.get('name')}: {steps} steps x {batch} tasks x {n} samples",
        "kind": "train",
        "campaign": (project or "").removeprefix("miles-") or None,
        "gpu": f"{cl.get('nodes', 1)}x {cl.get('gpu')}:8",
        "expected_steps": steps,
        "expected_trials": steps * batch * n if steps and batch and n else None,
        "batch_size": batch,
        "n_samples": n,
        "group_filter": al.get("group_filter"),  # the page's batch-fill estimate
        "stale_secs": (ag.get("trial_timeout") or 10800) + 1800,
        "sandbox": {"provider": sb.get("provider"), "app": f"{sb.get('app_prefix') or 'miles-mobius-'}{run_id}"},
        "wandb": {"project": project},
        "limits": {k: v for k, v in limits.items() if v},
        "launcher": "miles_ext/launch/modal_app.py",
    }


def register_launch(app_id: str, app_name: str, recipe: dict, run_id: str) -> Path | None:
    """The launcher's call: write this attempt's manifest when MILES_MONITOR_DIR is set; never fail a launch."""
    if not os.environ.get("MILES_MONITOR_DIR"):
        return None
    try:
        path = write_manifest(
            app_id, run_id, overwrite=False, gpu_app_name=app_name, **fields_from_recipe(recipe, run_id)
        )
        print(f"monitor: registered {run_id} attempt {app_id} in {path}", flush=True)
        return path
    except Exception as e:
        print(f"monitor: could not register {run_id}: {type(e).__name__}: {e}", flush=True)
        return None
