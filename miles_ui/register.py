"""Register a launched run or update its monitor manifest; usage is in README.md."""

import argparse
import json
import re
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import yaml

from . import config
from .manifest import fields_from_recipe, write_manifest

APP_URL = re.compile(r"modal\.com/apps/[\w-]+/[\w-]+/(ap-[A-Za-z0-9]+)")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("run_id")
    ap.add_argument("log")
    ap.add_argument("recipe", nargs="?", help="the fork recipe; leave out for a run without one (give --kind)")
    ap.add_argument("--title")
    ap.add_argument("--notes")
    ap.add_argument("--kind", help="train (RL, the recipe's default), sft, eval, ...")
    ap.add_argument("--expected-steps", type=int)
    ap.add_argument("--gpu", help='e.g. "1x H200:8"')
    ap.add_argument("--wandb-project")
    ap.add_argument("--hard-stop-h", type=float)
    ap.add_argument("--n-samples", type=int, help="trials per task of an eval (pass@k uses it as k)")
    ap.add_argument("--evaluates", help="<run_id>[@<step>]: the training run (and checkpoint step) this run evaluates")
    ap.add_argument("--label", help="with --evaluates: a name for the checkpoint, e.g. base")
    ap.add_argument("--wait", type=int, default=300, help="seconds to wait for the app id to show up in the log")
    a = ap.parse_args()
    log = Path(a.log).resolve()
    deadline = time.time() + a.wait
    app_id = None
    while not app_id:
        m = APP_URL.findall(log.read_text(errors="replace")) if log.exists() else []
        app_id = m[-1] if m else None
        if not app_id:
            if time.time() > deadline:
                sys.exit(f"no Modal app URL in {log} after {a.wait}s")
            time.sleep(5)
    apps = json.loads(
        subprocess.run(
            [config.load()["modal_cli"], "app", "list", "--json"], capture_output=True, text=True, timeout=60
        ).stdout
        or "[]"
    )
    app = next((x for x in apps if x.get("app_id") == app_id), {})
    created = app.get("created_at")  # "2026-10-16 15:21:56+00:00"
    started = (
        datetime.fromisoformat(created).astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ") if created else None
    )

    if not a.recipe and not a.kind:
        sys.exit("give the run's recipe, or --kind (and its shape as flags) for a run without one")
    fields = fields_from_recipe(yaml.safe_load(Path(a.recipe).read_text()), a.run_id) if a.recipe else {}
    fields |= {"gpu_app_name": app.get("description"), "log_path": str(log)}
    if a.recipe:
        fields["recipe"] = str(Path(a.recipe))
    fields |= {
        k: v
        for k, v in {
            "kind": a.kind,
            "expected_steps": a.expected_steps,
            "gpu": a.gpu,
            "n_samples": a.n_samples,
            "wandb": {"project": a.wandb_project} if a.wandb_project else None,
        }.items()
        if v is not None
    }
    if a.hard_stop_h:
        fields["limits"] = (fields.get("limits") or {}) | {"hard_stop_h": a.hard_stop_h}
    if a.evaluates:
        run, _, step = a.evaluates.partition("@")
        fields["evaluates"] = {"run": run, "step": int(step) if step else None} | (
            {"label": a.label} if a.label else {}
        )
    fields |= {
        k: v for k, v in {"title": a.title, "notes": a.notes, "started_at": started}.items() if v
    }  # the app's own start
    path = write_manifest(app_id, a.run_id, **fields)
    print(f"registered {a.run_id} attempt {app_id} -> {path}")


if __name__ == "__main__":
    main()
