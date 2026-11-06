"""The viewer's settings: one data dir (``MILES_MONITOR_DIR``) and an optional ``monitor.toml`` in it.

Everything the monitor reads or writes lives in that dir: ``manifests/`` (one file per launch attempt),
``runs.json``, ``groups.json`` and ``workstreams.json`` (optional), ``auth.txt``, and the files it writes
(``state.json``, ``history/``, ``cache/``). Every key of ``monitor.toml`` is optional; the defaults follow the
launcher's own names (``MILES_APP_NAME``, ``MILES_RESULTS_VOLUME``, ``MILES_DOTENV_DIR``), so they are not
stored twice. README.md lists the keys.
"""

import os
import shutil
from pathlib import Path

DIR = Path(os.environ.get("MILES_MONITOR_DIR") or "~/.miles-monitor").expanduser().resolve()


def _defaults() -> dict:
    dotenv = os.environ.get("MILES_DOTENV_DIR")
    return {
        "title": "Miles run monitor",
        "port": 8787,
        "modal_cli": shutil.which("modal") or "modal",
        "modal_workspace": None,  # None: the active Modal profile's workspace
        "modal_environments": [os.environ.get("MODAL_ENVIRONMENT") or "main"],
        "app_prefixes": ["miles-"],  # only Modal and Sail apps with these name prefixes are shown
        "launcher_apps": [os.environ.get("MILES_APP_NAME") or "miles-fork"],
        "results_volumes": [os.environ.get("MILES_RESULTS_VOLUME") or "miles-fork-results"],
        "sandbox_app_prefix": "miles-mobius-",  # the launcher's default sandbox.app_prefix
        "wandb_entity": None,  # None: the W&B API key's default entity
        "wandb_project_prefix": "",
        "dotenv": str(Path(dotenv) / ".env") if dotenv else None,  # its secret values are redacted from the page
        "host_root": None,  # a dir whose files the Notes tab lists (doc_globs) and log paths are shown relative to
        "doc_globs": [],
        "extra_manifest_dirs": [],
        "providers": ["modal", "sail"],  # which provider sources run; [] needs no provider at all
        "results_dirs": {},  # name -> a mounted results dir, read like a volume of that name
        "ingest_token": os.environ.get("MILES_UI_TOKEN"),  # nodes' MILES_STATE_TOKEN; None: /ingest is off
    }


def load(path: Path | None = None) -> dict:
    path = path or DIR / "monitor.toml"
    cfg = _defaults()
    if path.exists():
        import tomllib  # Python 3.11+; the launcher imports this module's DIR on older Pythons

        user = tomllib.loads(path.read_text())
        unknown = set(user) - set(cfg)
        if unknown:
            raise ValueError(f"{path}: unknown keys {sorted(unknown)}")
        cfg |= user
    return cfg
