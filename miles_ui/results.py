"""Run records on storage the viewer can read, and run state nodes push to it (MILES_STATE=http).

The image writes ``<results>/<run_id>/``: ``recipe-*.json``, ``exit.json``, ``state/*.json``, ``logs/<role>.log``,
``checkpoints/events/*.jsonl`` and ``trials/``. Nothing here needs a provider.
"""

import json
import re
import time
import urllib.parse
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from .manifest import fields_from_recipe

RUN_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*")
STATE_KEY = re.compile(r"[a-z]+:[A-Za-z0-9._-]+")
PUSHED = "pushed"  # the "volume" of a run the viewer only knows from pushes


@dataclass(frozen=True)
class Entry:
    path: str
    mtime: float
    size: int


class LocalVolume:
    """A results dir with the two calls the collectors make on a Modal volume."""

    def __init__(self, root: str | Path):
        self.root = Path(root).expanduser()

    def _path(self, rel: str) -> Path:
        path = (self.root / rel.lstrip("/")).resolve()
        if not path.is_relative_to(self.root.resolve()):
            raise ValueError(f"{rel!r} is outside {self.root}")
        return path

    def listdir(self, rel: str) -> list[Entry]:
        out = []
        for p in self._path(rel).iterdir():
            st = p.stat()
            out.append(Entry(str(p.relative_to(self.root.resolve())), st.st_mtime, st.st_size))
        return out

    def read_file(self, rel: str):
        yield self._path(rel).read_bytes()


class Pushes:
    """What nodes put here: ``<dir>/<run_id>/<quoted key>.json``, kept across restarts."""

    def __init__(self, root: Path):
        self.root = root

    def _path(self, run_id: str, key: str) -> Path:
        if not RUN_ID.fullmatch(run_id) or not STATE_KEY.fullmatch(key):
            raise ValueError(f"bad run id or key: {run_id!r} {key!r}")
        return self.root / run_id / f"{urllib.parse.quote(key, safe='')}.json"

    def put(self, run_id: str, key: str, body: bytes) -> None:
        json.loads(body)  # refuse what is not JSON before it is stored
        path = self._path(run_id, key)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_bytes(body)
        tmp.replace(path)

    def get(self, run_id: str, key: str) -> bytes | None:
        try:
            return self._path(run_id, key).read_bytes()
        except FileNotFoundError:
            return None

    def delete(self, run_id: str, key: str) -> None:
        self._path(run_id, key).unlink(missing_ok=True)

    def runs(self) -> list[str]:
        return sorted(p.name for p in self.root.glob("*") if p.is_dir()) if self.root.exists() else []


def _read_json(path: Path):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return None


def node_state(run_id: str, pushes: Pushes, run_dir: Path | None) -> dict:
    """``{run, exit, pool}``: what the nodes reported, pushed or on storage, whichever is newer."""
    out = {}
    for name in ("run", "exit", "pool"):
        key = f"{name}:{run_id}"
        found = [_read_json(pushes._path(run_id, key))]
        if run_dir:
            found.append(_read_json(run_dir / "state" / f"{urllib.parse.quote(key, safe='')}.json"))
        found = [f for f in found if f]
        if found:
            out[name] = max(found, key=lambda f: f.get("heartbeat_at") or f.get("ended_at") or f.get("at") or 0)
    if "exit" not in out and run_dir:
        if record := _read_json(run_dir / "exit.json"):
            out["exit"] = record
    return out


def status_of(state: dict, now: float | None = None, stale_secs: float = 300) -> tuple[str, str] | None:
    """The page's status and tone from a run's reported state, or None when nothing was reported."""
    now = now or time.time()
    run, record = state.get("run"), state.get("exit")
    if run and run.get("phase") != "ended" and now - (run.get("heartbeat_at") or 0) < stale_secs:
        return run.get("phase") or "running", "run"
    if record and (not run or (record.get("ended_at") or 0) >= (run.get("started_at") or 0)):
        reason = record.get("reason")
        if reason == "success":
            return "finished", "good"
        if reason in ("segment_end", "lease_expired"):
            return f"saved and stopped ({reason})", "idle"
        if reason == "stopped":
            return "stopped", "idle"
        return f"failed ({reason})", "bad"
    if run:
        return "no heartbeat", "warn"
    return None


def _iso(t: float) -> str:
    return datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def node_attempt(run_id: str, volume: str, run_dir: Path | None, pushes: Pushes) -> dict | None:
    """A run with no launcher manifest, as one attempt the page can show: from its recipe record, log and state."""
    recipes = sorted(run_dir.glob("recipe-*.json")) if run_dir and run_dir.is_dir() else []
    pushed = pushes.root / run_id
    if not recipes and not pushed.is_dir():
        return None
    first = recipes[0] if recipes else pushed
    m = {
        "app_id": f"node-{run_id}",
        "run_id": run_id,
        "started_at": _iso(first.stat().st_mtime),
        "launcher": "node",
        "results_volume": volume,
    }
    if recipes and (record := _read_json(recipes[-1])) and record.get("recipe"):
        m |= {**fields_from_recipe(record["recipe"], run_id), "launcher": "node"}
    log = run_dir / "logs" / "trainer-0.log" if run_dir else None
    if log and log.exists():
        m["log_path"] = str(log)
    return m
