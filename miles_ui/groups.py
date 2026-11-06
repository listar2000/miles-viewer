"""Which group and type a run belongs to: the one owner of that decision (rules in groups.json).

type: train | sft | eval | bench | smoke | other. Unregistered volume dirs with no data are "other"."""

import json
import re

from . import config

RULES_FILE = config.DIR / "groups.json"
_cache = {"mtime": None, "rules": []}


def _rules():
    try:
        m = RULES_FILE.stat().st_mtime
        if m != _cache["mtime"]:
            _cache["rules"] = [
                (re.compile(rx), label, kind) for rx, label, kind in json.loads(RULES_FILE.read_text())["rules"]
            ]
            _cache["mtime"] = m
    except (OSError, ValueError, KeyError):
        pass
    return _cache["rules"]


def classify(run: dict) -> tuple[str, str]:
    """(group label, type) for one run of the runs view."""
    rid = run["run_id"]
    for rx, label, kind in _rules():
        if rx.search(rid):
            return label, kind
    reg = run.get("registry") or {}
    if not reg and not run.get("trials") and not run.get("train"):
        return "Folders without a launch record", "other"
    prefix = re.split(r"-\d{4}(?:-|$)|-v\d|-\d+$", rid)[0]
    if reg.get("kind") == "sft":  # the launcher says so; a trainer-only run is not RL
        return prefix, "sft"
    kind = "train" if run.get("train") else "eval" if reg.get("kind") in ("eval",) or run.get("trials") else "smoke"
    return prefix, kind
