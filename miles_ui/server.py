"""Run monitor: one read-only page over Modal apps, results volumes, Sail and W&B.

It only reads. Nothing here stops, starts, creates or deletes anything: Modal through `modal app list` /
`modal app logs` and Volume.listdir/read_file, Sail through App.list and Sailbox.list, W&B through the public
API, launch logs by tailing the files the launchers write. Served on 127.0.0.1; `start.sh --tunnel` adds a
cloudflared quick tunnel and turns basic auth on.

What is a run: every top-level dir of the results volumes, plus every launch manifest (manifests/<app_id>.json,
in the data dir, written by the launcher through manifest.write_manifest). A manifest is one attempt: its own GPU app, start
time, limits and launch log. The newest attempt of a run drives its live view; earlier ones stay as records.

Live, not refresh-every-15-s: the page long-polls /api/poll with the last version it has; the request returns
the moment a topic changes (only the changed topics) or after 25 s. Collectors and log tailers mark topics
dirty and a publisher coalesces them into versions. Sources that can tell us something happened (a launch
log line, a new manifest) wake the collectors that depend on it.

    ./start.sh [--tunnel]   # detached; prints the URL
    ./stop.sh
"""

import base64
import collections
import functools
import gzip
import hmac
import json
import math
import os
import re
import subprocess
import sys
import threading
import time
import traceback
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse
from zoneinfo import ZoneInfo

from . import config, fill, gpus, groups, metrics, results

CFG = config.load()
HERE = Path(__file__).resolve().parent  # code (index.html, curves.js)
DATA = config.DIR  # manifests/, runs.json, auth.txt (read); cache/, history/, state.json (written)
LAUNCH = Path(CFG["host_root"]).expanduser().resolve() if CFG["host_root"] else None
CACHE = DATA / "cache"
MANIFEST_DIRS = [DATA / "manifests"] + [Path(p) for p in CFG["extra_manifest_dirs"]]
MODAL_CLI = CFG["modal_cli"]
PORT = int(os.environ.get("MONITOR_PORT") or CFG["port"])
COLLECT = os.environ.get("MONITOR_COLLECT", "1") == "1"  # 0: serve the saved state only (tests)

MODAL_ENVS = CFG["modal_environments"]
OUR_APP = re.compile("^(" + "|".join(re.escape(p) for p in CFG["app_prefixes"]) + ")")  # nothing else is shown
PROVIDERS = set(CFG["providers"])
RESULTS_DIRS = {k: Path(v).expanduser() for k, v in CFG["results_dirs"].items()}
RESULTS_VOLUMES = [v for v in CFG["results_volumes"] if "modal" in PROVIDERS] + list(RESULTS_DIRS)
PUSHES = results.Pushes(DATA / "pushed")
INGEST_TOKEN = CFG["ingest_token"]
WANDB_PROJECT = re.compile("^" + re.escape(CFG["wandb_project_prefix"]))
WANDB_DAYS = 21
DOC_GLOBS = CFG["doc_globs"] if LAUNCH else []


def _modal_workspace() -> str:
    """The workspace in Modal URLs: the config's, else the active Modal profile's."""
    if CFG["modal_workspace"]:
        return CFG["modal_workspace"]
    try:
        out = subprocess.run([MODAL_CLI, "profile", "list", "--json"], capture_output=True, text=True, timeout=60)
        return next(p["workspace"] for p in json.loads(out.stdout) if p.get("active"))
    except Exception:
        return ""


MODAL_WORKSPACE = _modal_workspace() if COLLECT and "modal" in PROVIDERS else ""
WANDB_ENTITY = CFG["wandb_entity"]  # None until collect_wandb asks W&B for the key's default entity

STALE_SECS = 10 * 3600  # longer than any trial budget (e.g. 8 h agent + 1 h verifier)
# cadences in seconds; a collector also runs at once when something wakes it
APPS_EVERY, SAIL_EVERY, WANDB_EVERY, STARTUP_EVERY = 30, 45, 120, 60
TRIALS_LIVE_EVERY, TRIALS_IDLE_EVERY, TRIALS_FULL_EVERY = (
    12,
    45,
    45,
)  # live runs: new dirs every 12 s, all live dirs every 45 s
# alert thresholds for live runs (the signals on the page)
READY_BY, DECODE_BY, STALL, FAIL_WINDOW, FAIL_MIN, FAIL_SHARE = 50 * 60, 15 * 60, 20 * 60, 10 * 60, 20, 0.8

STATE: dict = {
    "apps": [],
    "runs": {},
    "sail": {},
    "wandb": [],
    "startup": {},
    "errors": {},
    "updated": {},
    "watchdogs": {},
    "cost": {},
    "gpus": {},
}
LOCK = threading.Lock()
STARTED = time.time()


# ---- redaction: nothing secret ever reaches the page ------------------------------------------------


def _env_values() -> list[str]:
    vals = []
    if not CFG["dotenv"]:
        return vals
    try:
        for line in Path(CFG["dotenv"]).expanduser().read_text().splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                k, v = line.split("=", 1)
                v = v.strip().strip("'\"")
                if len(v) >= 6 and re.search(r"TOKEN|SECRET|KEY|PASSWORD", k):  # not entity/user names
                    vals.append(v)
    except OSError:
        pass
    return sorted(vals, key=len, reverse=True)


SECRETS = _env_values()
SECRET_RE = re.compile(
    r"(hf_[A-Za-z0-9]{20,}|\bak-[A-Za-z0-9]{12,}|\bas-[A-Za-z0-9]{12,}|"
    r"dckr_pat_[A-Za-z0-9_-]{10,}|sk-[A-Za-z0-9_-]{16,}|(?<=/)[A-Za-z0-9_-]{32}(?=/\d{4,5}/)|"
    r"gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|\bAKIA[0-9A-Z]{16}\b|xox[abprs]-[A-Za-z0-9-]{10,}|"
    r"eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|"
    r"(?<=://)[^/\s:@]+:[^/\s@]+(?=@))"
)  # user:password@ in URLs
KV_RE = re.compile(
    r"(?i)\b(api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|password|passwd)([\x22\x27]?\s*[:=]\s*[\x22\x27]?)"
    r"([A-Za-z0-9_./+=-]{12,})"
)


def redact(text: str) -> str:
    for v in SECRETS:
        if v in text:
            text = text.replace(v, "***")
    return KV_RE.sub(r"\1\2***", SECRET_RE.sub("***", text))


def scrub(obj):
    if isinstance(obj, str):
        return redact(obj)
    if isinstance(obj, list):
        return [scrub(x) for x in obj]
    if isinstance(obj, dict):
        return {k: scrub(v) for k, v in obj.items()}
    return obj


def note_error(key: str, e: BaseException | None):
    with LOCK:
        if e is None:
            if STATE["errors"].pop(key, None) is not None:
                HUB.poke("errors")
        else:
            STATE["errors"][key] = redact(f"{type(e).__name__}: {e}")[:400]
            HUB.poke("errors")


def stamp(key: str):
    with LOCK:
        STATE["updated"][key] = time.time()


def _ts(s):
    if not s:
        return None
    if isinstance(s, (int, float)):
        return float(s)
    try:
        return (
            datetime.fromisoformat(s.replace("Z", "+00:00").replace(" ", "T", 1)).astimezone(timezone.utc).timestamp()
        )
    except ValueError:
        return None


PACIFIC = ZoneInfo("America/Los_Angeles")


def pt(t) -> str:
    """A time for people to read: US Pacific (the user's rule), e.g. "23:51 PT". API fields stay raw UTC."""
    return datetime.fromtimestamp(t, PACIFIC).strftime("%H:%M PT") if t else "–"


def iso(t) -> str | None:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t)) if t else None


def is_live(state: str) -> bool:
    return state.startswith(("ephemeral", "running", "deployed")) and not state.startswith("stopped")


# ---- push hub: clients, dirty topics, a publisher that sends only what changed -----------------------


class Hub:
    """Topic cache with versions. Pages long-poll /api/poll?since=<v>: the request returns at once when anything
    changed after v, else waits (up to 25 s) until something does."""

    WAIT = 25

    def __init__(self):
        self.lock = threading.Lock()
        self.cond = threading.Condition(self.lock)
        self.dirty: set = set()
        self.wake = threading.Event()
        self.ver = 0
        self.cache: dict = {}  # topic -> json (scrubbed)
        self.tver: dict = {}  # topic -> version it last changed at
        self.watch: dict = {}  # run key -> last time a page asked for its detail
        self.active = 0.0  # last time any page polled
        self.dver: dict = {}  # run key -> detail_version() of the cached detail

    def poke(self, *topics):
        with self.lock:
            self.dirty |= set(topics or ("*",))
        self.wake.set()

    def log_moved(self):
        with self.lock:
            self.cond.notify_all()

    def run(self):
        while True:
            self.wake.wait(timeout=10)
            time.sleep(0.3)  # coalesce a burst of pokes into one version
            self.wake.clear()
            with self.lock:
                dirty, self.dirty = self.dirty, set()
                idle = time.time() - self.active > 90
                watched = [k for k, t in self.watch.items() if time.time() - t < 90]
            if idle:  # nobody looking: let the next poll start from a fresh build
                with self.lock:
                    self.cache.clear()
                    self.dver.clear()
                continue
            try:
                timed_out = not dirty
                built = build_topics(
                    None if "*" in dirty or not self.cache else dirty | ({"runs"} if timed_out else set()), self.cache
                )
                for key in watched:
                    ver = detail_version(key)
                    if self.dver.get(key) != ver or f"detail:{key}" not in self.cache:
                        self.dver[key] = ver
                        built[f"detail:{key}"] = json.dumps(scrub(detail_of(key)), default=str)
            except Exception:
                traceback.print_exc()
                continue
            with self.lock:
                changed = [t for t, js in built.items() if self.cache.get(t) != js]
                if changed:
                    self.ver += 1
                    for t in changed:
                        self.cache[t] = built[t]
                        self.tver[t] = self.ver
                    self.cond.notify_all()

    def poll(self, since: int, run: str | None, log: str | None, log_after: int) -> str:
        tail = TAILS.get(log) if log else None
        with self.lock:
            if since > self.ver:  # a page older than this server process: give it everything
                since = 0
            self.active = time.time()
            if run:
                new_watch = run not in self.watch or time.time() - self.watch[run] > 90
                self.watch[run] = time.time()
            else:
                new_watch = False
        if not self.cache or new_watch:
            self.poke("*" if not self.cache else "runs")
        deadline = time.time() + (0 if since == 0 and self.cache and not new_watch else self.WAIT)
        with self.lock:
            while True:
                has_detail = not run or f"detail:{run}" in self.cache
                if self.cache and has_detail and (self.ver > since or (tail and tail.seq > log_after)):
                    break
                left = deadline - time.time()
                if left <= 0:
                    break
                self.cond.wait(timeout=min(left, 5 if not self.cache else left))
            topics = {
                ("detail" if t.startswith("detail:") else t): js
                for t, js in self.cache.items()
                if self.tver.get(t, 0) > since and (not t.startswith("detail:") or t == f"detail:{run}")
            }
            ver = self.ver
        body = ",".join(f'"{t}":{js}' for t, js in topics.items())
        out = f'{{"v":{ver},"now":{time.time()},"topics":{{{body}}}'
        if tail:
            lines = log_lines(log, log_after, 400 if log_after else 300)["lines"]
            out += ',"log":' + json.dumps({"app": log, "lines": lines, "reset": log_after == 0})
        return out + "}"


HUB = Hub()


# ---- events: what happened, newest last; derived from state changes and log lines -------------------


class Events:
    """An append-only feed with a key per event so a restart (or a second look at the same log) never repeats one."""

    def __init__(self):
        self.path = DATA / "history" / "events.jsonl"
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.lock = threading.Lock()
        self.items: list = []
        self.keys: set = set()
        try:
            for line in self.path.read_text().splitlines():
                e = json.loads(line)
                self.items.append(e)
                self.keys.add(e["key"])
        except (OSError, ValueError):
            pass
        self.items.sort(key=lambda e: e["t"])

    def emit(self, key: str, run_id: str, text: str, level: str = "info", t: float | None = None, **extra):
        with self.lock:
            if key in self.keys:
                return
            app = key.split(":", 1)[0]
            e = {
                "key": key,
                "t": round(t or time.time(), 1),
                "run_id": run_id,
                "level": level,
                "text": redact(text),
                **({"app_id": app} if app.startswith("ap-") else {}),
                **extra,
            }
            self.keys.add(key)
            self.items.append(e)
            if len(self.items) > 1 and self.items[-2]["t"] > e["t"]:
                self.items.sort(key=lambda x: x["t"])
            with open(self.path, "a") as f:
                f.write(json.dumps(e) + "\n")
        HUB.poke("events")

    def recent(self, n=300, run_id=None) -> list:
        with self.lock:
            items = [e for e in self.items if not run_id or e["run_id"] == run_id]
        return items[-n:]


EVENTS = Events()


# ---- registry: runs.json history overlaid by launch manifests (one per attempt) -----------------------

_MANIFEST_CACHE: dict = {}  # path -> (mtime, manifest)


def volume(name: str):
    """A results store by name: a mounted dir from the config, what nodes pushed, or a Modal volume."""
    if name in RESULTS_DIRS:
        return results.LocalVolume(RESULTS_DIRS[name])
    if name == results.PUSHED:
        return results.LocalVolume(PUSHES.root)
    import modal

    return modal.Volume.from_name(name)


def _run_dir(rid: str, vol: str | None) -> Path | None:
    return RESULTS_DIRS[vol] / rid if vol in RESULTS_DIRS else None


def _node_attempts(by_run: dict) -> None:
    """Runs with no launcher manifest: nodes on any provider, known from storage or their pushes."""
    seen = {}
    for name, root in RESULTS_DIRS.items():
        for d in root.expanduser().glob("*") if root.expanduser().exists() else []:
            if d.is_dir():
                seen.setdefault(d.name, name)
    for rid in PUSHES.runs():
        seen.setdefault(rid, results.PUSHED)
    for rid, vol in seen.items():
        if rid not in by_run and (m := results.node_attempt(rid, vol, _run_dir(rid, vol), PUSHES)):
            by_run[rid] = [m]


def manifests() -> dict:
    """run_id -> its attempts, oldest first."""
    by_run: dict = {}
    for d in MANIFEST_DIRS:
        for f in sorted(d.glob("*.json")):
            try:
                mt = f.stat().st_mtime
                hit = _MANIFEST_CACHE.get(f)
                if not hit or hit[0] != mt:
                    _MANIFEST_CACHE[f] = hit = (mt, json.loads(f.read_text()))
                m = hit[1]
                by_run.setdefault(m["run_id"], []).append(m)
                note_error(f"manifest {f.name}", None)
            except Exception as e:
                note_error(f"manifest {f.name}", e)
    _node_attempts(by_run)
    for ms in by_run.values():
        ms.sort(key=lambda m: m.get("started_at") or "")
    return by_run


def attempt_watched(m: dict) -> bool:
    """Polled closely while its GPU app is up, and for 6 h after launch (queueing, a slow start)."""
    if m.get("backfilled"):
        return False
    app = app_by_id(m["app_id"])
    return bool(app and is_live(app["state"])) or time.time() - (_ts(m.get("started_at")) or 0) < 6 * 3600


def registry() -> dict:
    """The newest attempt of a run decides its GPU app (by id), the trial dirs counted (those started after
    it) and its limits; runs.json fills in what the manifest leaves out (titles, notes of older runs)."""
    try:
        f = DATA / "runs.json"
        reg = {r["run_id"]: r for r in json.loads(f.read_text())["runs"]} if f.exists() else {}
        note_error("runs.json", None)
    except Exception as e:  # a bad edit must not take the page down
        note_error("runs.json", e)
        reg = {}
    for rid, ms in manifests().items():
        last = ms[-1]
        entry = {
            **reg.get(rid, {}),
            **{
                k: v for k, v in last.items() if k not in ("app_id", "started_at", "log_path", "backfilled", "outcome")
            },
        }
        entry |= {
            "gpu_app_id": last["app_id"],
            "trials_since": last["started_at"],
            "watch": attempt_watched(last) or reg.get(rid, {}).get("watch", False),
            "attempts": [{"app_id": m["app_id"], "started_at": m["started_at"]} for m in ms],
            "_manifests": ms,
        }
        reg[rid] = entry
    return reg


# ---- Modal apps -------------------------------------------------------------------------------------

LAUNCHER_APPS = set(CFG["launcher_apps"])  # the app name miles_ext.launch.modal_app gives every training and eval run


def collect_apps():
    apps = []
    for env in MODAL_ENVS:
        out = subprocess.run(
            [MODAL_CLI, "app", "list", "--json", "--env", env], capture_output=True, text=True, timeout=120
        )
        if out.returncode:
            raise RuntimeError(out.stderr.strip()[-300:])
        for a in json.loads(out.stdout):
            name = a.get("description") or ""
            if not OUR_APP.match(name):
                continue
            apps.append(
                {
                    "app_id": a["app_id"],
                    "name": name,
                    "state": a["state"],
                    "tasks": int(a.get("tasks") or 0),
                    "created_at": a.get("created_at"),
                    "stopped_at": a.get("stopped_at"),
                    "env": env,
                    "url": f"https://modal.com/apps/{MODAL_WORKSPACE}/{env}/{a['app_id']}",
                }
            )
    apps.sort(key=lambda a: a["created_at"] or "", reverse=True)
    with LOCK:
        before = {a["app_id"]: a["state"] for a in STATE["apps"]}
        STATE["apps"] = apps
    attempt_apps = {m["app_id"]: m for ms in manifests().values() for m in ms}
    for a in apps:
        m = attempt_apps.get(a["app_id"])
        if m and before and before.get(a["app_id"]) != a["state"] and a["state"].startswith("stopped"):
            EVENTS.emit(
                f"{a['app_id']}:stopped",
                m["run_id"],
                f"GPU app {a['app_id']} stopped",
                "warn",
                _ts(a.get("stopped_at")),
            )
    # a launcher app holding GPUs with no manifest: launched without MILES_MONITOR_DIR and never registered
    for a in apps:
        up = time.time() - (_ts(a.get("created_at")) or time.time())
        if (
            a["name"] in LAUNCHER_APPS
            and is_live(a["state"])
            and a["tasks"]
            and up > 15 * 60
            and a["app_id"] not in attempt_apps
        ):
            EVENTS.emit(
                f"{a['app_id']}:unregistered",
                "unregistered",
                f"{a['name']} app {a['app_id']} has run {round(up / 60)} min "
                "and isn't registered with the monitor: if it is a run, register it with miles_ui.register.py",
                "warn",
            )
    HUB.poke("apps")
    STARTUP_WAKE.set()  # app states feed the startup view; don't leave it a minute behind


def app_by_id(app_id: str) -> dict | None:
    with LOCK:
        return next((a for a in STATE["apps"] if a["app_id"] == app_id), None)


# ---- trials on the results volumes --------------------------------------------------------------------


@functools.lru_cache(maxsize=200_000)
def _task(trial: str) -> str:
    """A trial dir is <task>__<YYYYmmdd-HHMMSS>__<id>; task names may hold "__" themselves (SWE-Gym's owner__repo-N)."""
    m = re.match(r"(.+?)__\d{8}-\d{6}__", trial)
    return m.group(1) if m else trial.split("__")[0]


REDACTED = re.compile(r'(?<!")\[REDACTED\](?!")')


def _loads(raw) -> dict:
    """Harbor's secret scrubber rewrites bare values in a finished trial dir as [REDACTED] (invalid JSON)."""
    return json.loads(REDACTED.sub("null", raw.decode() if isinstance(raw, bytes) else raw))


def _name_start(trial: str):
    m = re.search(r"__(\d{8}-\d{6})__", trial)
    if not m:
        return None
    return datetime.strptime(m.group(1), "%Y%m%d-%H%M%S").replace(tzinfo=timezone.utc).timestamp()


def _summarize_result(r: dict) -> dict:
    ex = r.get("exception_info") or {}
    ae = r.get("agent_execution") or {}
    rewards = (r.get("verifier_result") or {}).get("rewards") or {}
    a0, a1 = _ts(ae.get("started_at")), _ts(ae.get("finished_at"))
    t0, t1 = _ts(r.get("started_at")), _ts(r.get("finished_at"))
    return {
        "reward": rewards.get("reward"),
        "exception": ex.get("exception_type"),
        "exception_msg": (ex.get("exception_message") or "")[:300],
        "started": t0,
        "finished": t1,
        "agent_s": round(a1 - a0, 1) if a0 and a1 else None,
        "total_s": round(t1 - t0, 1) if t0 and t1 else None,
        "agent": (r.get("agent_info") or {}).get("name"),
    }


LOG_REREAD = 240
AGENT_CMD = re.compile(r"\| tee /logs/agent/|/logs/agent/[\w.-]+\.trajectory\.json")
PHASE_ORDER = {"setup": 0, "agent": 1, "verifying": 2}


def _volume_store(name: str):
    return volume(name)


class Trials:
    """One run's trials dir. Finished trials (result.json) are immutable and cached on disk; a live trial's
    phase only moves forward, so a scan re-checks only what could have changed since the last one."""

    def __init__(self, volume: str, run_id: str, stale_secs: int = STALE_SECS, base: str | None = None):
        self.stale_secs = stale_secs
        self.volume_name, self.run_id = volume, run_id
        self.base = base or run_id  # the run's dir on the volume: <run_id>, or a manifest's results_path
        self.vol = _volume_store(volume)
        self.cache_dir = CACHE / "trials" / volume / self.base
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.done: dict = {}
        self.phase: dict = {}  # trial -> furthest phase seen
        self.log_seen: dict = {}  # trial -> (trial.log size, time) when last read (setup phase only)
        self.names: list = []
        self.last: dict = {}  # trial -> its row from the last scan
        self.last_full = 0.0
        # trial -> full task name: dir names cut the task part at 32 characters, so two tasks can share a prefix
        self.task_of: dict = {}
        self.fix_tried: set = set()
        for f in self.cache_dir.glob("*.json"):
            try:
                row = json.loads(f.read_text())
            except ValueError:
                continue
            if row.get("task_full"):
                self.task_of[f.stem] = row["task"]
            self.done[f.stem] = row | {"task": self.task_of.get(f.stem) or _task(f.stem)}

    def task(self, trial: str) -> str:
        return self.task_of.get(trial) or _task(trial)

    def _full_task(self, path: str, trial: str, names: dict) -> str | None:
        """The task's own name from lock.json (written when the trial starts); read once per trial."""
        if trial not in self.task_of and "lock.json" in names:
            try:
                name = (_loads(b"".join(self.vol.read_file(f"{path}/lock.json"))).get("task") or {}).get("name")
            except ValueError:
                name = None
            if name:
                self.task_of[trial] = name
        return self.task_of.get(trial)

    def _one(self, trial: str) -> dict:
        path = f"{self.base}/trials/{trial}"
        names = {Path(e.path).name: e for e in self.vol.listdir(path)}
        row = {"trial": trial, "task": self.task(trial), "start": _name_start(trial)}
        try:  # a result.json caught mid-write (truncated, or NUL-padded) waits for the next scan
            r = "result.json" in names and _loads(b"".join(self.vol.read_file(f"{path}/result.json")))
        except ValueError:
            r, names = None, {k: v for k, v in names.items() if k != "result.json"}
        if r and r.get("task_name"):
            self.task_of[trial] = r["task_name"]
        if self._full_task(path, trial, names):
            row |= {"task": self.task_of[trial], "task_full": True}
        if r:
            row |= _summarize_result(r)
            row["phase"] = "error" if row["exception"] else "done"
            (self.cache_dir / f"{trial}.json").write_text(json.dumps(row))
            self.done[trial] = row
            return row
        seen = self.phase.get(trial, "setup")

        # Harbor creates agent/ and verifier/ up front, so the phase comes from what is inside them
        def has(sub, ignore=()):
            return sub in names and any(Path(e.path).name not in ignore for e in self.vol.listdir(f"{path}/{sub}"))

        if seen == "verifying" or has("verifier"):
            phase = "verifying"
        elif seen == "agent" or has("agent", ("setup",)):
            phase = "agent"
        else:  # agent output lands at the end; the run command in trial.log marks the start
            phase = "setup"
            tl = names.get("trial.log")
            size, read_at = self.log_seen.get(trial, (None, 0))
            # re-read when it grew, and every few minutes regardless: a listed size can lag the file's contents
            if tl and (size != tl.size or time.time() - read_at > LOG_REREAD):
                self.log_seen[trial] = (tl.size, time.time())
                if AGENT_CMD.search(b"".join(self.vol.read_file(f"{path}/trial.log")).decode(errors="replace")):
                    phase = "agent"
        self.phase[trial] = phase
        row["phase"] = phase
        row["last_write"] = max((e.mtime for e in names.values()), default=None)
        if time.time() - max(row["last_write"] or 0, row["start"] or 0) > self.stale_secs:
            row["phase"] = "stale"  # no result.json long past any trial budget: cut off when its run ended
        return row

    def list_names(self) -> list:
        self.names = sorted(Path(e.path).name for e in self.vol.listdir(f"{self.base}/trials"))
        return self.names

    def rows(self, pool: ThreadPoolExecutor, trials: list, deep: bool, focus: set | None = None) -> list[dict]:
        """deep: look into unfinished dirs; with `focus` (task names) only new dirs and those tasks', the rest
        keep their last row. Not deep (an earlier attempt): only what the cache knows."""
        if not deep:
            return [
                self.done.get(t) or {"trial": t, "task": self.task(t), "start": _name_start(t), "phase": "stale"}
                for t in trials
            ]
        live = [
            t for t in trials if t not in self.done and (focus is None or t not in self.last or self.task(t) in focus)
        ]
        rows = {t: self.done.get(t) or self.last.get(t) for t in trials}
        for t, row in zip(live, pool.map(self._safe_one, live), strict=True):
            rows[t] = row
        # finished trials cached before full names were read: look each up once
        old = [t for t in trials if t in self.done and not self.done[t].get("task_full") and t not in self.fix_tried]
        self.fix_tried.update(old)  # dirs without a lock.json (older Harbor) keep the dir-name prefix
        for t, name in zip(old, pool.map(self._fix_task, old), strict=True):
            if name:
                self.done[t] = rows[t] = self.done[t] | {"task": name, "task_full": True}
                (self.cache_dir / f"{t}.json").write_text(json.dumps(self.done[t]))
        self.last = {t: r for t, r in rows.items() if r and t not in self.done}
        return [rows[t] for t in trials]

    def _fix_task(self, trial):
        path = f"{self.base}/trials/{trial}"
        try:
            return self._full_task(path, trial, {Path(e.path).name: e for e in self.vol.listdir(path)})
        except Exception:
            return None

    def _safe_one(self, trial):
        try:
            return self._one(trial)
        except Exception as e:
            return {
                "trial": trial,
                "task": self.task(trial),
                "phase": "unknown",
                "start": _name_start(trial),
                "error": f"{type(e).__name__}: {e}"[:200],
            }


def summarize_trials(rows: list[dict], expected: int | None, k: int | None = None) -> dict:
    """k (the manifest's n_samples): a task's first k trials by start are the counted ones; later trials of the
    same task (a refill re-sampling the batch after aborted groups) are marked `extra` and kept apart."""
    now = time.time()
    phases: dict = {}
    for r in rows:
        phases[r["phase"]] = phases.get(r["phase"], 0) + 1
    fin = [r for r in rows if r["phase"] in ("done", "error")]
    rewards = [r["reward"] for r in fin if r.get("reward") is not None]
    exc: dict = {}
    for r in fin:
        if r.get("exception"):
            exc[r["exception"]] = exc.get(r["exception"], 0) + 1
    ends = sorted(r["finished"] for r in fin if r.get("finished"))
    recent = [t for t in ends if t > now - 1800]
    rate = len(recent) / 30 if recent else 0  # trials per minute over the last 30 min
    tasks: dict = {}
    for r in sorted(rows, key=lambda r: (r.get("start") or math.inf, r["trial"])):
        t = tasks.setdefault(
            r["task"],
            {
                "task": r["task"],
                "trials": 0,
                "finished": 0,
                "solved": 0,
                "rewards": [],
                "cells": [],
                "running": 0,
                "errors": 0,
                "k_finished": 0,
                "k_solved": 0,
            },
        )
        if k:
            r["extra"] = t["trials"] >= k
        t["trials"] += 1
        done = r["phase"] in ("done", "error")
        solved = done and (r.get("reward") or 0) >= 1.0
        # one cell per trial in start order: its reward, "x" (finished without one), "run" (in flight) or
        # "cut" (stale or unknown), so a cell's index is its trial's start rank and the first k are the counted ones
        if done:
            t["finished"] += 1
            if r.get("reward") is not None:
                t["rewards"].append(r["reward"])
                t["solved"] += solved
            t["errors"] += r["phase"] == "error"
            t["cells"].append(r["reward"] if r.get("reward") is not None else "x")
            if not r.get("extra"):
                t["k_finished"] += 1
                t["k_solved"] += solved
        elif r["phase"] not in ("unknown", "stale"):
            t["running"] += 1
            t["cells"].append("run")
        else:
            t["cells"].append("cut")
    for t in tasks.values():
        t["mean"] = round(sum(t["rewards"]) / len(t["rewards"]), 3) if t["rewards"] else None
        del t["rewards"]
    remaining = (expected - len(fin)) if expected else None
    starts = [r["start"] for r in rows if r.get("start")]
    in_flight = sum(phases.get(k, 0) for k in ("setup", "agent", "verifying"))
    solved_tasks = sum(1 for t in tasks.values() if t["solved"])
    return {
        "expected": expected,
        "dirs": len(rows),
        "not_started": max(expected - len(rows), 0) if expected else None,
        "phases": phases,
        "in_flight": in_flight,
        "finished": len(fin),
        "with_reward": len(rewards),
        "solved": sum(1 for x in rewards if x >= 1.0),
        "nonzero": sum(1 for x in rewards if x > 0),
        "mean_reward": round(sum(rewards) / len(rewards), 4) if rewards else None,
        "tasks_total": len(tasks),
        "tasks_solved": solved_tasks,
        "exceptions": dict(sorted(exc.items(), key=lambda kv: -kv[1])),
        "rate_per_min": round(rate, 2),
        "eta_min": round(remaining / rate) if remaining and rate else None,
        "first_start": min(starts) if starts else None,
        "last_finish": ends[-1] if ends else None,
        "timeline": ends,
        "extras": sum(1 for r in fin if r.get("extra")) if k else 0,  # finished ones, so finished - extras = counted
        "tasks": sorted(tasks.values(), key=lambda t: t["task"]),
    }


TRIALS: dict = {}
POOL = ThreadPoolExecutor(32)
HINTS: dict = {}  # run_id -> task names the launch log just reported an outcome for
RUNS_WAKE = threading.Event()


def discover_runs(reg: dict) -> list[tuple[str, str]]:
    """(volume, run_id) for every top-level dir of the results volumes, plus registry entries."""
    found = []
    # a top-level dir that only groups runs (eval1017/ holding eval1017/<run_id>) is not a run itself
    groups = {run_base(r, rid).split("/")[0] for rid, r in reg.items() if "/" in run_base(r, rid)}
    for vol in RESULTS_VOLUMES:
        try:
            for e in volume(vol).listdir("/"):
                if Path(e.path).name not in groups:
                    found.append((vol, Path(e.path).name))
            note_error(f"volume {vol}", None)
        except Exception as e:
            note_error(f"volume {vol}", e)
    for rid, r in reg.items():
        key = (r.get("results_volume") or (RESULTS_VOLUMES or [results.PUSHED])[0], rid)
        if key not in found:
            found.append(key)
    # watched runs first, so a restart has the live run back on the page before the history is rescanned
    return sorted(found, key=lambda k: not reg.get(k[1], {}).get("watch"))


def run_base(entry: dict, rid: str) -> str:
    """A run's dir on its results volume: <run_id> unless its manifest names a results_path (eval1017/<run_id>)."""
    return (entry.get("results_path") or rid).strip("/")


def _has_trials(vol: str, run_id: str) -> bool:
    try:
        return any(Path(e.path).name == "trials" for e in volume(vol).listdir(run_id))
    except Exception:
        return False


def sandbox_name(entry: dict, rid: str) -> str:
    return (entry.get("sandbox") or {}).get("app") or f"{CFG['sandbox_app_prefix']}{rid}"


def sandboxes_live(entry: dict, rid: str):
    sbx = entry.get("sandbox") or {}
    name = sandbox_name(entry, rid)
    with LOCK:
        if sbx.get("provider") == "modal":
            return next((a["tasks"] for a in STATE["apps"] if a["name"] == name), None)
        return (STATE["sail"].get(name) or {}).get("live")


def slim_summary(t: dict | None) -> dict | None:
    return {k: v for k, v in t.items() if k not in ("tasks", "timeline")} if t else None


MILESTONES = (1, 10, 25, 50, 100, 150, 200, 250, 300, 400, 500, 1000)


def trial_events(rid: str, app_id: str, prev_rows: list, rows: list, expected):
    """Feed lines for what a scan found new: finished trials, milestones, a first exception type."""
    if prev_rows is None:
        return
    was = {r["trial"]: r["phase"] for r in prev_rows}
    fin = [r for r in rows if r["phase"] in ("done", "error")]
    for r in rows:
        if r["phase"] in ("done", "error") and was.get(r["trial"]) not in ("done", "error"):
            rew = r.get("reward")
            if rew is not None and rew >= 1.0:
                EVENTS.emit(
                    f"{app_id}:solved:{r['trial']}",
                    rid,
                    f"{r['task']} solved (reward 1) in {dur(r.get('agent_s'))}",
                    "good",
                    r.get("finished"),
                    trial=r["trial"],
                )
            elif r.get("exception"):
                EVENTS.emit(
                    f"{app_id}:exc:{r['exception']}",
                    rid,
                    f"first {r['exception']}: {r['task']}"
                    f"{' · ' + r['exception_msg'][:120] if r.get('exception_msg') else ''}",
                    "warn",
                    r.get("finished"),
                    trial=r["trial"],
                )
    n = len(fin)
    for k in MILESTONES:
        if n >= k > sum(1 for x in prev_rows if x["phase"] in ("done", "error")):
            solved = sum(1 for r in fin if (r.get("reward") or 0) >= 1.0)
            EVENTS.emit(
                f"{app_id}:n{k}",
                rid,
                f"{k} trials finished{f' of {expected}' if expected else ''}, {solved} solved",
                "info",
            )


def dur(s) -> str:
    if s is None:
        return "–"
    return f"{round(s)}s" if s < 120 else f"{round(s / 60)}m" if s < 7200 else f"{s / 3600:.1f}h"


def collect_runs(first: bool):
    reg = registry()
    found = discover_runs(reg)
    with LOCK:  # a dir that turned out to only group runs (see discover_runs) leaves the page
        for key in [
            k
            for k, r in STATE["runs"].items()
            if (r["volume"], r["run_id"]) not in found
            and r["run_id"] not in reg
            and any(run_base(e, x).startswith(r["run_id"] + "/") for x, e in reg.items())
        ]:
            STATE["runs"].pop(key)
    for vol, rid in found:
        key = f"{vol}/{rid}"
        with LOCK:
            prev = STATE["runs"].get(key)
        entry = reg.get(rid, {})
        pub_entry = {k: v for k, v in entry.items() if not k.startswith("_")}
        prev_live = prev and (prev.get("trials") or {}).get("in_flight")
        live = prev is None or first or entry.get("watch") or prev_live or (prev or {}).get("restored")
        if not live:
            prev["registry"] = pub_entry
            continue
        run = {"key": key, "run_id": rid, "volume": vol, "registry": pub_entry, "trials": None, "attempts": []}
        try:
            base = run_base(entry, rid)
            if key not in TRIALS and _has_trials(vol, base):
                TRIALS[key] = Trials(vol, rid, int(entry.get("stale_secs") or STALE_SECS), base)
            ms = entry.get("_manifests") or []
            if key in TRIALS:
                tr = TRIALS[key]
                tr.stale_secs = int(entry.get("stale_secs") or STALE_SECS)
                names = tr.list_names()
                since = _ts(entry.get("trials_since"))
                current = [t for t in names if not since or (_name_start(t) or since) >= since]
                app = app_by_id(ms[-1]["app_id"]) if ms else None
                stopped = bool(
                    app and app["state"].startswith("stopped") or not app and ms and ms[-1].get("backfilled")
                )
                full = time.time() - tr.last_full >= TRIALS_FULL_EVERY or first
                if full:
                    tr.last_full = time.time()
                    HINTS.pop(rid, None)
                focus = None if full else HINTS.pop(rid, set())
                rows = tr.rows(
                    POOL,
                    current,
                    deep=not stopped or not (prev or {}).get("app_stopped") or bool((prev or {}).get("restored")),
                    focus=focus,
                )
                run["app_stopped"] = stopped
                if stopped:  # its GPU app is gone: whatever has no result now never will
                    rows = [r if r["phase"] in ("done", "error", "stale") else {**r, "phase": "stale"} for r in rows]
                run["trials"] = summarize_trials(rows, entry.get("expected_trials"), entry.get("n_samples"))
                run["rows"] = rows
                if ms:
                    trial_events(rid, ms[-1]["app_id"], (prev or {}).get("rows"), rows, entry.get("expected_trials"))
                if entry.get("watch"):
                    metrics.backfill_trials(rid, rows)
                    if not ms or is_live((app_by_id(ms[-1]["app_id"]) or {}).get("state", "")):
                        metrics.ingest_trials(rid, run["trials"], sandboxes_live(entry, rid))
                # earlier attempts: their own window of trial dirs, from names and the result cache only
                for i, m in enumerate(ms[:-1]):
                    t0, t1 = _ts(m["started_at"]), _ts(ms[i + 1]["started_at"])
                    window = [t for t in names if t0 <= (_name_start(t) or 0) < t1]
                    m["_trials"] = slim_summary(
                        summarize_trials(tr.rows(POOL, window, deep=False), m.get("expected_trials"))
                    )
            run["attempts"] = [attempt_record(rid, m, i == len(ms) - 1, run["trials"]) for i, m in enumerate(ms)]
            note_error(f"trials {key}", None)
        except Exception as e:
            note_error(f"trials {key}", e)
            traceback.print_exc()
            run = {**(prev or run), "registry": pub_entry}
            run.pop("restored", None)
        with LOCK:
            STATE["runs"][key] = run
        HUB.poke("runs")


def attempt_record(rid: str, m: dict, latest: bool, trials: dict | None) -> dict:
    app = app_by_id(m["app_id"]) or {}
    su = STARTUP.get(m["app_id"]) or {}
    tail = TAILS.get(m["app_id"])
    rec = {
        "app_id": m["app_id"],
        "n": None,
        "latest": latest,
        "started_at": m["started_at"],
        "app_state": app.get("state"),
        "containers": app.get("tasks"),
        "stopped_at": app.get("stopped_at"),
        "url": app.get("url") or (f"https://modal.com/apps/{MODAL_WORKSPACE}/main/{m['app_id']}" if m["app_id"].startswith("ap-") else None),
        "stage": su.get("stage"),
        "log_path": (
            str(Path(m["log_path"]).relative_to(LAUNCH))
            if LAUNCH and m.get("log_path") and Path(m["log_path"]).is_relative_to(LAUNCH)
            else m.get("log_path")
        ),
        "outcome": m.get("outcome"),
        "notes": m.get("notes"),
        "limits": m.get("limits"),
        "trials": slim_summary(trials) if latest else m.get("_trials"),
    }
    if tail:
        rec["log"] = tail.summary()
    return rec


# ---- launch logs: tail the file a launcher writes, for live stage, engine and trial-outcome events ------

ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")
EMBED_TS = re.compile(r"\[(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d)")
# launch-log patterns: startup stages, trial outcomes, error signatures
TS = r"\[(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)[^\]]*\]"
SETUP_FAIL = re.compile(TS + r" agent_function\.py:\d+ - Harbor trial for (\S+) failed: (.*)")
OUTCOME = re.compile(TS + r" agent_function\.py:\d+ - Harbor trial (\S+): exit_status=(\S+) reward=([\d.]+)")
DECODE = re.compile(TS + r" Decode batch, #running-req: (\d+).*?gen throughput \(token/s\): ([\d.]+)")
EXC_LINE = re.compile(r"^(?:\(\w+ pid=\d+\)\s*)?([A-Za-z_][\w.]*(?:Error|Exception|Exit|Timeout)\w*): (.{0,160})")
IGNORE = re.compile(r"freeze_gc|Connection refused.*20002|NewConnectionError.*20002|MaxRetryError.*20002")
NOISE = re.compile(r"env_report_summary|wait_init_expected_num_cells|retry_until_deadline|RuntimeWarning|^\s*$")
# Harbor's exit statuses: Submitted (agent finished, verifier scored it), AgentError (setup or agent failure),
# LimitsExceeded / TimeExceeded (budget spent, still scored). Only AgentError is a failure.
FAILED_STATUS = ("AgentError",)
HTTP_LINE = re.compile(r'INFO:\s+[\d.]+:\d+ - "(GET|POST|PUT|DELETE) |"(GET|POST) /\S* HTTP/1\.[01]" \d{3}')

STAGES = [  # (key, label, log marker); the furthest marker seen wins, and stays once seen
    ("queued", "queued for a GPU node", None),
    ("container", "node placed, container starting", None),
    ("ray", "Ray up, Miles starting", re.compile(r"ray up;|train_async\.py --|Ray cluster ready|Ray runtime started")),
    ("sessions", "session servers up", re.compile(r"Session servers ready")),
    ("loading", "engine loading weights", re.compile(r"Load weight begin")),
    ("loaded", "weights loaded, engine warming up", re.compile(r"Load weight end")),
    ("ready", "engine ready", re.compile(r"fired up and ready to roll")),
    ("rollout", "rollout started, sandboxes starting", re.compile(r"Started fully-async rollout worker")),
    ("trials", "trials running", None),
    (
        "training",
        "training steps",
        None,
    ),  # training runs only: the trainer's first "Timer train start" (or "step N:" line)
    ("done", "done", re.compile(r"\] eval done|^eval done|^exit record: .*\"reason\": \"success\"")),
]
TRAIN_ONLY = {"training"}
# SFT runs (manifest kind "sft") start no engines and run no trials: the trainer's stages only
SFT_STAGES = ("queued", "container", "ray", "training", "done")

# training runs: Miles logs each step's metrics as one Python dict per line; the ones the page shows
STEP_LINE = re.compile(r" - (rollout|step|perf) (\d+): (\{.*\})")
TRAIN_KEYS = {
    "rollout/raw_reward": "raw_reward",
    "rollout/raw_reward_unfiltered": "raw_reward_unfiltered",
    "rollout/zero_std/all_zero_percentage": "zero_std_all_zero",
    "rollout/zero_std/all_one_percentage": "zero_std_all_one",
    "rollout/truncated_ratio": "truncated",
    "rollout/response_len/mean": "response_len",
    "rollout/fully_async/avg_staleness": "staleness",
    "rollout/num_training_samples": "samples",
    "train/grad_norm": "grad_norm",
    "train/ppo_kl": "ppo_kl",
    "train/train_rollout_logprob_abs_diff": "logprob_diff",
    "train/tis_clipfrac": "tis_clipfrac",
    "train/mis_tis_mask_fraction_low": "mis_mask_low",
    "train/mis_tis_mask_fraction_high": "mis_mask_high",
    "train/sc_masked": "sc_masked",
    "train/sc_importance_weight": "sc_weight",
    "train/sc_correction": "sc_correction",
    "train/loss": "loss",
    "train/lr-pg_0": "lr",
    "perf/step_time": "step_time",
    "perf/actor_train_time": "train_time",
    "perf/actor_train_tok_per_s": "tok_per_s",
    "perf/actor_train_mfu": "mfu",
    "perf/update_weights_time": "update_weights_time",
    "perf/wait_time_ratio": "wait_ratio",
}
SAVE_LINE = re.compile(r"successfully saved checkpoint from iteration\s+(\d+)")
HF_LINE = re.compile(r"Successfully saved HuggingFace model to (\S+)")
# held-out loss of an SFT run: "validation at step N: {'val/nll': ...}" (miles_ext.sft), N = optimizer steps done
VAL_LINE = re.compile(r" - (?:validation|val) (?:at )?step (\d+): (\{.*\})")
VAL_KEYS = ("val/nll", "val/loss")
LOSS_NAN = re.compile(r"'train/loss': -?(?:nan|inf)\b")
SYNC_START = re.compile(r"ft op=update_weights phase=start rollout=(\d*)")
SYNC_END = re.compile(r"fn=update_weights ok=(\w+) elapsed_s=([\d.]+)")
EXIT_LINE = re.compile(r"^exit record: (\{.*\})")
# the trainer's phases, from rank 0's Megatron timers: waiting for a batch, weight sync, the step itself
TIMER_LINE = re.compile(r"rank0+\] timer\.py:\d+ - Timer (train_wait|update_weights|train) (start|end)\b")


def _r5(v: float) -> float:
    """5 decimals, but small values (a learning rate of 1e-6) keep 4 significant digits instead of becoming 0."""
    return round(v, 5) if abs(v) >= 1e-3 or v == 0 else float(f"{v:.4g}")


def _pydict(text: str) -> dict:
    import ast

    try:
        d = ast.literal_eval(re.sub(r"-?\b(?:nan|inf)\b", "None", text))
    except (ValueError, SyntaxError):
        return {}
    return d if isinstance(d, dict) else {}


STAGE_KEYS = [k for k, _, _ in STAGES]
STAGE_LABEL = {k: label for k, label, _ in STAGES}
STARTUP: dict = {}  # app_id -> {"stage", "seen": {stage: ts}, "shards", "last", "tail_read"}
SHARDS = re.compile(r"loading shards:\s+(\d+)% Completed \| (\d+)/(\d+)")


def signature(exc: str, msg: str) -> str:
    return exc.split(".")[-1] + ": " + re.sub(r"\d+", "N", re.sub(r"'[^']*'|\"[^\"]*\"", "'…'", msg))[:100]


def advance_stage(app_id: str, rid: str, key: str, t: float | None):
    st = STARTUP.setdefault(app_id, {"stage": "queued", "seen": {}, "shards": None, "last": "", "tail_read": False})
    if STAGE_KEYS.index(key) > STAGE_KEYS.index(st["stage"]):
        st["stage"] = key
    if key not in st["seen"]:
        later = [v for k, v in st["seen"].items() if v and STAGE_KEYS.index(k) > STAGE_KEYS.index(key)]
        st["seen"][key] = min([t or time.time()] + later)
        for k, v in list(st["seen"].items()):  # an earlier stage can't have been reached after this one
            if v and STAGE_KEYS.index(k) < STAGE_KEYS.index(key) and v > st["seen"][key]:
                st["seen"][k] = st["seen"][key]
        if key not in ("queued", "container"):
            EVENTS.emit(
                f"{app_id}:stage:{key}",
                rid,
                STAGE_LABEL[key][0].upper() + STAGE_LABEL[key][1:],
                "good" if key in ("ready", "done") else "info",
                st["seen"][key],
            )
    return st


class LogTail:
    """One attempt's launch log (the `modal run` stdout the launcher redirected to a file)."""

    def __init__(self, app_id: str, run_id: str, path: str, engine: bool, sft: bool = False):
        self.app_id, self.run_id, self.path, self.sft = app_id, run_id, Path(path), sft
        self.pos, self.partial, self.initial = 0, b"", True
        self.feed = metrics.EngineFeed(run_id) if engine else None
        self.lines: collections.deque = collections.deque(maxlen=4000)  # [seq, t, cat, text]
        self.seq = 0
        self.last_t = None
        self.outcomes: list = []  # (t, task, status, reward)
        self.setup_fail: list = []  # (t, task, msg)
        self.sigs: dict = {}
        self.decode = None  # (t, running, tps, engines): the last decode line of each engine, summed
        self.engines: dict = {}
        self.decode_busy = None  # t of the last decode line with running requests
        self.noise = 0
        self.frozen = False
        self.pending: list = []
        self.size = 0
        self.mtime = 0.0
        self.steps: dict = {}  # training: step -> {"t": time its "step N:" line was logged, short metric -> value}
        self.saves: list = []  # (t, step) per checkpoint save
        self.syncs: list = []  # (t, ok, secs) per weight sync
        self.sync_open = None  # t a weight sync started, until it ends
        self.exit = None  # the launcher's exit record
        self.phases: list = []  # [name, t0, t1 or None] per trainer phase (TIMER_LINE)
        self.vals: list = []  # [step, nll, t] per validation pass (VAL_LINE); step 0 is before any training
        self.hf: list = []  # [t, path] per HF export
        self.loss_nan: list = []  # steps whose train/loss was nan or inf

    def _train(self, line: str, t: float):
        m = TIMER_LINE.search(line)
        if m:
            name, edge = m.groups()
            if edge == "start":
                self.phases.append([name, t, None])
                if name == "train":
                    n = sum(1 for x in self.phases if x[0] == "train") - 1
                    if n == 0:
                        advance_stage(self.app_id, self.run_id, "training", t)
                    EVENTS.emit(
                        f"{self.app_id}:train_start:{n}",
                        self.run_id,
                        f"training step {n} started (batch {n} full)",
                        "info",
                        t,
                    )
            else:
                open_ = next((x for x in reversed(self.phases) if x[0] == name and x[2] is None), None)
                if open_:
                    open_[2] = t
            if len(self.phases) > 600:
                del self.phases[:100]
            return "stage"
        m = VAL_LINE.search(line)
        if m:
            k, d = int(m.group(1)), _pydict(m.group(2))
            v = next((d[x] for x in VAL_KEYS if isinstance(d.get(x), (int, float))), None)
            if v is not None and not any(x[0] == k for x in self.vals):
                self.vals.append([k, v, t])
                # validation after k steps belongs to step k - 1 (the "step N" lines count from 0)
                prev = self.steps.get(k - 1)
                if prev is not None:
                    prev["val_nll"] = v
                    if "t" in prev and self.feed:
                        metrics.STORE.add(self.run_id, [(prev["t"], "train.val_nll", v)])
                EVENTS.emit(
                    f"{self.app_id}:val:{k}",
                    self.run_id,
                    f"validation NLL {v:.4f} " + ("before training" if k == 0 else f"after step {k - 1}"),
                    "info",
                    t,
                )
            return "stage"
        m = STEP_LINE.search(line)
        if m:
            kind, n = m.group(1), int(m.group(2))
            if kind == "step" and LOSS_NAN.search(line) and n not in self.loss_nan:
                self.loss_nan.append(n)
                EVENTS.emit(
                    f"{self.app_id}:loss_nan:{n}", self.run_id, f"train/loss is not finite at step {n}", "bad", t
                )
            vals = {
                TRAIN_KEYS[k]: v
                for k, v in _pydict(m.group(3)).items()
                if k in TRAIN_KEYS and isinstance(v, (int, float))
            }
            step = self.steps.setdefault(n, {"n": n})
            step.update(vals)
            # an RL run's train/loss is the policy loss, not worth a curve; an SFT run's is the curve that matters
            skip = ("n", "t", "samples", "dt", "val_nll", "train_time") + (() if self.sft else ("loss",))
            if (
                kind != "step" and "t" in step and self.feed
            ):  # a line about a step already done (its perf line follows it)
                metrics.STORE.add(
                    self.run_id,
                    [(step["t"], "train." + k, v) for k, v in vals.items() if k not in skip],
                )
            if kind == "step":  # the trainer's line: the step is done
                first = "t" not in step
                step["t"] = t
                prev = self.steps.get(n - 1)
                if first and prev and prev.get("t") and t > prev["t"]:
                    step["dt"] = round(t - prev["t"], 1)  # wall time since the previous step: SFT logs no step_time
                if self.feed:
                    metrics.STORE.add(
                        self.run_id,
                        [(t, "train." + k, v) for k, v in step.items() if k not in skip],
                    )
                if first:
                    if len(self.steps) == 1 or n == min(self.steps):
                        advance_stage(self.app_id, self.run_id, "training", t)
                    r, secs = step.get("raw_reward"), step.get("step_time")
                    loss = step.get("loss") if self.sft else None
                    text = (
                        f"step {n} trained"
                        + (f", reward {r:.3f}" if r is not None else "")
                        + (f", loss {loss:.4f}" if loss is not None else "")
                        + (f", {round(secs / 60)} min" if secs else "")
                    )
                    # an SFT step takes seconds: one feed line per 50 steps, not one per step
                    if not self.sft or n % 50 == 0 or n == min(self.steps):
                        EVENTS.emit(f"{self.app_id}:step:{n}", self.run_id, text, "info", t)
            return "stage"
        m = SAVE_LINE.search(line)
        if m:
            n = int(m.group(1))
            if not any(x[1] == n for x in self.saves):
                self.saves.append((t, n))
                EVENTS.emit(f"{self.app_id}:save:{n}", self.run_id, f"checkpoint saved at step {n}", "good", t)
            return "stage"
        m = HF_LINE.search(line)
        if m:
            path = m.group(1).rstrip(".,")
            if not any(x[1] == path for x in self.hf):
                self.hf.append([t, path])
                EVENTS.emit(f"{self.app_id}:hf:{path}", self.run_id, f"HF export saved: {path}", "good", t)
            return "stage"
        m = SYNC_START.search(line)
        if m:
            self.sync_open = t
            return None
        m = SYNC_END.search(line)
        if m:
            ok = m.group(1) == "true"
            self.syncs.append((t, ok, float(m.group(2))))
            self.sync_open = None
            if not ok:
                EVENTS.emit(f"{self.app_id}:sync_fail:{len(self.syncs)}", self.run_id, "weight sync failed", "bad", t)
            return None
        m = EXIT_LINE.match(line)
        if m:
            try:
                rec = json.loads(m.group(1))
            except ValueError:
                rec = {}
            self.exit = {
                "reason": rec.get("reason"),
                "returncode": rec.get("returncode"),
                "step": rec.get("step"),
                "note": redact(str(rec.get("note") or ""))[:300],
                "t": t,
            }
            text = f"trainer exited: {rec.get('reason')}" + (
                f" at step {rec['step']}" if rec.get("step") is not None else ""
            )
            EVENTS.emit(
                f"{self.app_id}:exit",
                self.run_id,
                text,
                (
                    "good"
                    if rec.get("reason") == "success"
                    else "warn" if rec.get("reason") in ("segment_end", "lease_expired") else "bad"
                ),
                t,
            )
            return "stage"
        return None

    def train_summary(self) -> dict | None:
        if not (self.steps or self.saves or self.syncs or self.exit or self.phases or self.vals):
            return None
        done = sorted((s for s in self.steps.values() if "t" in s), key=lambda s: s["n"])
        times = sorted(s.get("step_time") or s.get("dt") for s in done if s.get("step_time") or s.get("dt"))
        ok_syncs = [x[2] for x in self.syncs if x[1]]
        return {
            "steps": [{k: (_r5(v) if isinstance(v, float) else v) for k, v in s.items()} for s in done],
            "last_step": done[-1]["n"] if done else None,
            "last_step_t": done[-1]["t"] if done else None,
            "median_step_s": times[len(times) // 2] if times else None,
            "saves": [[t, n] for t, n in self.saves],
            "syncs": len(self.syncs),
            "sync_failed": sum(1 for x in self.syncs if not x[1]),
            "last_sync_s": ok_syncs[-1] if ok_syncs else None,
            "sync_open": self.sync_open,
            "exit": self.exit,
            "phases": [list(x) for x in self.phases[-400:]],
            "trains_started": sum(1 for x in self.phases if x[0] == "train"),
            "training_now": any(x[0] == "train" and x[2] is None for x in self.phases[-3:]),
            "vals": [list(x) for x in self.vals],
            "hf": [list(x) for x in self.hf],
            "loss_nan": list(self.loss_nan),
        }

    def poll(self) -> bool:
        try:
            st = self.path.stat()
        except OSError:
            return False
        self.size, self.mtime = st.st_size, st.st_mtime
        if st.st_size < self.pos:  # truncated or replaced: start over
            self.pos, self.partial = 0, b""
        if st.st_size == self.pos:
            if self.initial:
                self.initial = False
                HUB.poke("runs", "startup")
            return False
        with open(self.path, "rb") as f:
            f.seek(self.pos)
            chunk = f.read(8 << 20)
        self.pos += len(chunk)
        data = self.partial + chunk
        lines = data.split(b"\n")
        self.partial = lines.pop()
        new = []
        for raw in lines:
            item = self._line(raw.decode(errors="replace"))
            if item:
                new.append(item)
        if self.feed:
            self.feed.flush()
        if new and not self.initial:
            HUB.log_moved()
        return True

    def _line(self, line: str):
        line = ANSI.sub("", line).rstrip("\r")
        m = EMBED_TS.search(line)
        if m:
            self.last_t = _ts(f"{m.group(1)}T{m.group(2)}Z")
            for key in self.pending:  # stage lines read back without a time of their own take the next one seen
                advance_stage(self.app_id, self.run_id, key, self.last_t)
            self.pending = []
        # a line without its own time: now if it just arrived, the last time seen if read back from history
        t = self.last_t if m or (self.initial and self.last_t) else None if self.initial else time.time()
        if NOISE.search(line):
            self.noise += 1
            return None
        if self.feed:
            self.feed.line(line)
        cat = "other"
        if (
            "step" in line
            or "rollout" in line
            or "perf" in line
            or "checkpoint" in line
            or "HuggingFace" in line
            or "update_weights" in line
            or "Timer " in line
            or line.startswith("exit record")
        ):
            cat = self._train(line, t or self.last_t or time.time()) or cat
        if cat != "other":
            pass
        elif HTTP_LINE.search(line):
            cat = "http"
        elif "Decode batch" in line or "Prefill batch" in line:
            cat = "engine"
            d = DECODE.search(line)
            t = t or self.last_t or time.time()
            if d and ("TP" not in line.split("Decode batch")[0] or re.search(r"TP0\b", line)):
                # one entry per engine (its Ray actor prefix); the run's decode is the sum over engines heard from lately
                eng = re.match(r"\s*\(\w+ pid=\d+(?:, ip=[\d.]+)?\)", line)
                self.engines[eng.group(0).strip() if eng else ""] = (t, int(d.group(2)), float(d.group(3)))
                live = [e for e in self.engines.values() if t - e[0] < 120]
                self.decode = (t, sum(e[1] for e in live), round(sum(e[2] for e in live), 2), len(live))
                if int(d.group(2)) > 0:
                    self.decode_busy = t
        elif "Harbor trial" in line:
            cat = "trial"
            t = t or self.last_t or time.time()
            o = OUTCOME.search(line)
            if o:
                self.outcomes.append((t, o.group(2), o.group(3), float(o.group(4))))
                if not self.initial:  # a result.json is about to land: rescan that task's dirs now
                    HINTS.setdefault(self.run_id, set()).add(o.group(2))
                    RUNS_WAKE.set()
            else:
                s = SETUP_FAIL.search(line)
                if s:
                    self.setup_fail.append((t, s.group(2), s.group(3)[:200]))
                    if len(self.setup_fail) == 1:
                        EVENTS.emit(
                            f"{self.app_id}:setup_fail",
                            self.run_id,
                            f"first sandbox setup failure: {s.group(2)}: {s.group(3)[:140]}",
                            "bad",
                            t,
                        )
        else:
            e = EXC_LINE.match(re.sub(r"^\(\w+ pid=\d+\)\s*", "", line))
            if e and not IGNORE.search(line):
                cat = "error"
                k = signature(*e.groups())
                n = self.sigs.get(k, 0) + 1
                self.sigs[k] = n
                if n == 5:
                    EVENTS.emit(f"{self.app_id}:sig:{k}", self.run_id, f"error seen 5 times: {k}", "warn", t)
            elif "Traceback" in line or " ERROR " in line:
                cat = "error"
        for key, _, rx in STAGES:
            if rx and rx.search(line):
                if t is None:
                    self.pending.append(key)
                else:
                    advance_stage(self.app_id, self.run_id, key, t)
                cat = "stage" if cat == "other" else cat
                HUB.poke("startup", "runs")
        sh = SHARDS.search(line)
        if sh:
            STARTUP.setdefault(
                self.app_id, {"stage": "queued", "seen": {}, "shards": None, "last": "", "tail_read": False}
            )["shards"] = f"{sh.group(2)}/{sh.group(3)}"
        text = redact(line)[:600]
        if cat not in ("engine", "http"):
            st = STARTUP.get(self.app_id)
            if st is not None:
                st["last"] = text[:300]
        self.seq += 1
        item = [self.seq, round(t or self.mtime, 1), cat, text]
        self.lines.append(item)
        return item

    def summary(self) -> dict:
        now = time.time()
        recent_out = [o for o in self.outcomes if now - o[0] < FAIL_WINDOW]
        recent_fail = [f for f in self.setup_fail if now - f[0] < FAIL_WINDOW]
        return {
            "outcomes": len(self.outcomes),
            "solved": sum(1 for o in self.outcomes if o[3] >= 1.0),
            "outcome_errors": sum(1 for o in self.outcomes if o[2] in FAILED_STATUS),
            "setup_failed": len(self.setup_fail),
            "recent_outcomes": len(recent_out),
            "recent_failed": len(recent_fail) + sum(1 for o in recent_out if o[2] in FAILED_STATUS),
            "last_outcome": self.outcomes[-1][0] if self.outcomes else None,
            "decode": self.decode,
            "decode_busy": self.decode_busy,
            "sigs": sorted(self.sigs.items(), key=lambda kv: -kv[1])[:8],
            "train": self.train_summary(),
        }


TAILS: dict = {}  # app_id -> LogTail


def tail_loop():
    """Every second: make sure each recent attempt with a launch log has a tailer, and read what's new."""
    last_scan = 0.0
    while True:
        try:
            if time.time() - last_scan > 5:
                last_scan = time.time()
                for rid, ms in manifests().items():
                    for i, m in enumerate(ms):
                        lp = m.get("log_path")
                        nxt = _ts(ms[i + 1]["started_at"]) if i + 1 < len(ms) else None
                        tail = TAILS.get(m["app_id"])
                        if tail:
                            tail.sft = ms[-1].get("kind") == "sft"  # a manifest edited to kind sft applies at once
                        if tail and nxt:
                            tail.frozen = True  # a newer attempt exists; its launcher may reuse this file
                        if lp and not tail and Path(lp).exists() and not (nxt and Path(lp).stat().st_mtime > nxt + 60):
                            # engine curves come from the newest attempt only, so attempts never interleave
                            TAILS[m["app_id"]] = LogTail(
                                m["app_id"], rid, lp, engine=i == len(ms) - 1, sft=ms[-1].get("kind") == "sft"
                            )
                            STARTUP.setdefault(
                                m["app_id"],
                                {"stage": "queued", "seen": {}, "shards": None, "last": "", "tail_read": True},
                            )
            busy = False
            for t in list(TAILS.values()):
                if not t.frozen:
                    busy |= t.poll()
            if busy:
                HUB.poke("runs")
        except Exception as e:
            note_error("log tail", e)
            traceback.print_exc()
        time.sleep(0.2 if any(t.initial for t in TAILS.values()) else 1.0)


# ---- startup phase of a watched attempt: GPU app state, plus log markers (local log, else `modal app logs`) --


def collect_startup():
    reg = registry()
    for rid, entry in reg.items():
        ms = entry.get("_manifests") or []
        if not entry.get("watch") or not (entry.get("gpu_app_name") or entry.get("gpu_app_id")):
            continue
        if (entry.get("gpu_app_id") or "").startswith("node-"):  # no app to list: its log and state say it all
            continue
        app = app_by_id(entry["gpu_app_id"]) if entry.get("gpu_app_id") else _named_gpu_app(entry)
        if not app and entry.get("gpu_app_id"):
            app = {
                "app_id": entry["gpu_app_id"],
                "state": "not listed yet",
                "tasks": 0,
                "created_at": entry.get("trials_since"),
            }
        if not app:
            continue
        st = STARTUP.setdefault(
            app["app_id"], {"stage": "queued", "seen": {}, "shards": None, "last": "", "tail_read": False}
        )
        st["seen"].setdefault("queued", _ts(app["created_at"]))
        if app["tasks"] > 0:
            advance_stage(app["app_id"], rid, "container", None)
        tail = TAILS.get(app["app_id"])
        if not tail and is_live(app["state"]):  # no launch log on disk: read the app's own logs
            args = ["--tail", "1500"] if st["tail_read"] else ["--tail", "5000", "--since", "12h"]
            try:
                out = subprocess.run(
                    [MODAL_CLI, "app", "logs", app["app_id"], *args, "--timestamps"],
                    capture_output=True,
                    text=True,
                    timeout=60,
                )
                lines = out.stdout.splitlines()
                st["tail_read"] = True
            except subprocess.TimeoutExpired:
                lines = []
            try:
                metrics.ingest_engine_logs(rid, lines)
            except Exception as e:
                note_error(f"engine metrics {rid}", e)
            for line in lines:
                for key, _, rx in STAGES:
                    if rx and rx.search(line):
                        advance_stage(app["app_id"], rid, key, _ts(line[:25].replace(" ", "T", 1)))
                m = SHARDS.search(line)
                if m:
                    st["shards"] = f"{m.group(2)}/{m.group(3)}"
            useful = [ln for ln in lines if not NOISE.search(ln)]
            if useful:
                st["last"] = redact(ANSI.sub("", useful[-1]))[:300]
        with LOCK:
            run = STATE["runs"].get(f"{entry.get('results_volume', RESULTS_VOLUMES[0])}/{rid}") or {}
        t = run.get("trials") or {}
        scanned_for = ((run.get("attempts") or [{}])[-1]).get("app_id")
        if ms and scanned_for != app["app_id"]:
            t = {}  # the last scan was of the previous attempt's window: don't read its dirs as this one's
        if t.get("dirs") and (not ms or (tail and tail.outcomes) or t.get("in_flight") or t.get("finished")):
            advance_stage(app["app_id"], rid, "trials", t.get("first_start"))
        with LOCK:
            STATE["startup"][rid] = startup_view(app, st, entry.get("kind"))
    HUB.poke("startup")


def startup_view(app: dict, st: dict, kind: str | None = None) -> dict:
    train = kind in ("train", "sft") or "training" in st["seen"]
    # on a training run trials fill the first batch; nothing trains until the trainer's first step starts
    relabel = (
        {"ray": "Ray up, trainer loading", "done": "run finished"}
        if kind == "sft"
        else (
            {"done": "run finished", "trials": "rollout filling batch 0", "training": "training"}
            if train
            else {"done": "eval done"}
        )
    )
    stages = [
        [k, relabel.get(k, label)]
        for k, label, _ in STAGES
        if (k in SFT_STAGES if kind == "sft" else train or k not in TRAIN_ONLY)
    ]
    return {
        "app_id": app["app_id"],
        "app_state": app["state"],
        "containers": app["tasks"],
        "created": _ts(app["created_at"]),
        "stage": st["stage"],
        "seen": dict(st["seen"]),
        "shards": st["shards"],
        "last": st["last"],
        "stages": stages,
    }


def _named_gpu_app(entry: dict) -> dict | None:
    with LOCK:
        named = [
            a for a in STATE["apps"] if a["name"] == entry.get("gpu_app_name") and not a["state"].startswith("stopped")
        ]
    return max(named, key=lambda a: a["created_at"] or "", default=None)


# ---- Sail ---------------------------------------------------------------------------------------------


def collect_sail():
    from sail import App, Sailbox

    with LOCK:
        out = dict(STATE["sail"])
    for app in App.list():
        name = getattr(app, "name", "") or ""
        if not OUR_APP.match(name):  # our namespace only; never other people's apps
            continue
        created = app.created_at.timestamp() if getattr(app, "created_at", None) else 0
        prev = out.get(name)
        if prev and not prev["live"] and created < time.time() - 2 * 86400:
            continue  # an old app with nothing live: its counts don't change
        counts: dict = {}
        cpu = mem = 0.0
        for box in Sailbox.list(app_id=app):
            st = str(getattr(box, "status", "?"))
            counts[st] = counts.get(st, 0) + 1
            if st != "terminated":
                cpu += float(getattr(box, "cpu_used_vcpu", 0) or 0)
                mem += float(getattr(box, "memory_used_bytes", 0) or 0)
        out[name] = {
            "name": name,
            "app_id": str(getattr(app, "id", "")),
            "created": created,
            "counts": counts,
            "live": sum(v for k, v in counts.items() if k != "terminated"),
            "cpu_used": round(cpu, 1),
            "mem_used_gib": round(mem / 2**30, 1),
        }
    with LOCK:
        STATE["sail"] = out
    HUB.poke("sail")


# ---- W&B ----------------------------------------------------------------------------------------------

KEEP_METRICS = re.compile(
    r"^(rollout/(raw_reward|rewards|response_len|truncated)|perf/|train/(loss|grad_norm|pg_loss|kl)|"
    r"_step$|_runtime$)"
)


def collect_wandb():
    import wandb

    global WANDB_ENTITY
    api = wandb.Api(timeout=60)
    WANDB_ENTITY = WANDB_ENTITY or api.default_entity
    cutoff = time.time() - WANDB_DAYS * 86400
    rows = []
    for p in api.projects(WANDB_ENTITY):
        if not WANDB_PROJECT.match(p.name):
            continue
        for r in api.runs(f"{WANDB_ENTITY}/{p.name}", order="-created_at", per_page=50):
            created = _ts(r.created_at)
            if created and created < cutoff:
                break
            summ = {
                k: v
                for k, v in dict(r.summary._json_dict).items()
                if KEEP_METRICS.search(k) and isinstance(v, (int, float))
            }
            rows.append(
                {
                    "project": p.name,
                    "id": r.id,
                    "name": r.name,
                    "group": r.group,
                    "state": r.state,
                    "created": created,
                    "url": r.url,
                    "tags": list(r.tags or []),
                    "summary": dict(sorted(summ.items())[:24]),
                }
            )
    rows.sort(key=lambda r: r["created"] or 0, reverse=True)
    with LOCK:
        STATE["wandb"] = rows
    HUB.poke("wandb")
    for rid, entry in registry().items():  # GPU curves for watched runs, from W&B system metrics
        if not entry.get("watch"):
            continue
        match = wandb_of(rid, entry, rows)
        live = [r for r in match if r["state"] == "running"] or match
        if live:
            try:
                metrics.fetch_wandb_gpu(api, rid, f"{WANDB_ENTITY}/{live[0]['project']}/{live[0]['id']}")
            except Exception as e:
                note_error(f"wandb gpu {rid}", e)


def wandb_of(rid: str, entry: dict, rows: list) -> list:
    wid = (entry.get("wandb") or {}).get("run_id")
    return [
        w
        for w in rows
        if w["name"] == rid or w["group"] == rid or (w["name"] or "").startswith(rid + "_") or w["id"] == wid
    ]


def wandb_api():
    import wandb

    global _WANDB_API
    if _WANDB_API is None:
        _WANDB_API = wandb.Api(timeout=60)
    return _WANDB_API


_WANDB_API = None


def own_wandb_path(path: str) -> bool:
    with LOCK:
        return any(f"{WANDB_ENTITY}/{w['project']}/{w['id']}" == path for w in STATE["wandb"])


# ---- watchdogs: the run's own watchdog process and its last status file ---------------------------------

# ---- cost: what Modal bills each shown app (`modal billing report`), plus a labelled estimate since then -------

COST_DAYS, COST_EVERY = 7, 300  # hourly reports span at most 7 days


def collect_cost():
    out = subprocess.run(
        [MODAL_CLI, "billing", "report", "--start", f"{COST_DAYS} days ago", "-r", "h", "--show-resources", "--json"],
        capture_output=True,
        text=True,
        timeout=180,
    )
    if out.returncode:
        raise RuntimeError(out.stderr.strip()[-300:])
    apps: dict = {}
    gpu_hours: dict = {}  # app id -> {hour: cost of its GPU resources}, the GPUs tab's last 24 h
    through = 0.0
    for x in json.loads(out.stdout):
        name = x.get("description") or ""
        if not OUR_APP.match(name):  # other people's apps are not shown
            continue
        t = _ts(x["interval_start"] + "Z")
        c = float(x.get("cost") or 0)
        a = apps.setdefault(x["object_id"], {"name": name, "total": 0.0, "by_resource": {}, "hours": {}})
        a["total"] += c
        res = x.get("resource") or "other"
        a["by_resource"][res] = a["by_resource"].get(res, 0.0) + c
        a["hours"][t] = a["hours"].get(t, 0.0) + c
        if res not in NON_GPU_RESOURCES and t >= time.time() - gpus.WINDOW - 7200:
            gh = gpu_hours.setdefault(x["object_id"], {})
            gh[t] = gh.get(t, 0.0) + c
        through = max(through, t + 3600)
    day0 = datetime.now(PACIFIC).replace(hour=0, minute=0, second=0, microsecond=0).timestamp()
    for a in apps.values():
        hours = sorted(a.pop("hours").items())
        a["total"] = round(a["total"], 2)
        a["by_resource"] = {
            k: round(v, 2) for k, v in sorted(a["by_resource"].items(), key=lambda kv: -kv[1]) if v >= 0.005
        }
        a["first"], a["last"] = hours[0][0], hours[-1][0] + 3600
        a["last_hour"] = round(hours[-1][1], 2)
        # the newest bucket can be partial (billing lag) and so can the first; the hour before the newest is whole
        a["full_hour"] = round(hours[-2][1], 2) if len(hours) >= 3 and hours[-2][0] == hours[-1][0] - 3600 else None
        a["today"] = round(sum(c for t, c in hours if t >= day0), 2)
    with LOCK:
        STATE["cost"] = {
            "apps": apps,
            "through": through,
            "days": COST_DAYS,
            "checked": time.time(),
            "gpu_hours": gpu_hours,
            "today": round(sum(a["today"] for a in apps.values()), 2),
            "total": round(sum(a["total"] for a in apps.values()), 2),
        }
    HUB.poke("cost", "runs", "gpus")


# ---- GPUs: every GPU our apps hold right now ----------------------------------------------------------

NON_GPU_RESOURCES = {"CPU", "Memory", "Network Egress", "other"}
GPUS_EVERY = 30
WORKSTREAMS = gpus.Workstreams(DATA / "workstreams.json")
GPU_HISTORY = gpus.History(DATA / "history" / "gpus.jsonl")
GPU_FUNCS: dict = {}  # app id -> its functions' GPU configs (fixed for an app's life)


def collect_gpus():
    known = CACHE / "gpu_functions.json"
    known.parent.mkdir(parents=True, exist_ok=True)
    known.write_text(json.dumps(GPU_FUNCS))
    out = subprocess.run(
        [sys.executable, "-P", str(HERE / "gpus_probe.py"), MODAL_ENVS[0], OUR_APP.pattern, str(known)],
        capture_output=True,
        text=True,
        timeout=180,
    )
    if out.returncode:
        raise RuntimeError(out.stderr.strip()[-300:])
    probe = json.loads(out.stdout)
    GPU_FUNCS.update(probe["functions"])
    now = time.time()
    with LOCK:
        meta = {a["app_id"]: a for a in STATE["apps"]}
        cost = dict(STATE["cost"] or {})
    manifest_of = {m["app_id"]: m for ms in manifests().values() for m in ms}
    apps = gpus.build_apps(probe, WORKSTREAMS, manifest_of, meta, cost)
    GPU_HISTORY.add(now, apps)
    names = {
        **{i: a.get("name", "") for i, a in (cost.get("apps") or {}).items()},
        **{a["app_id"]: a["name"] for a in apps},
    }
    billing = gpus.billing_by_workstream(cost.get("gpu_hours") or {}, names, WORKSTREAMS, now)
    billing["through"] = cost.get("through")
    view = gpus.view(apps, GPU_HISTORY, billing, now, now)
    view["order"] = [r["name"] for r in WORKSTREAMS.rows]  # fixed colour order on the page
    with LOCK:
        STATE["gpus"] = view
    HUB.poke("gpus")


def run_train(entry: dict) -> dict | None:
    """A training run's steps over all its attempts (a resumed segment carries on the step count), newest wins."""
    parts = [TAILS[m["app_id"]].train_summary() for m in entry.get("_manifests") or [] if m["app_id"] in TAILS]
    parts = [p for p in parts if p]
    if not parts:
        return None
    steps = {}
    for p in parts:
        steps.update({s["n"]: s for s in p["steps"]})
    out = dict(parts[-1])
    out["steps"] = [steps[n] for n in sorted(steps)]
    out["saves"] = sorted({tuple(x) for p in parts for x in p["saves"]})
    out["phases"] = sorted((x for p in parts for x in p.get("phases") or []), key=lambda x: x[1])[-600:]
    vals = {}
    for p in parts:
        vals.update({v[0]: v for v in p.get("vals") or []})
    out["vals"] = [vals[k] for k in sorted(vals)]
    out["hf"] = sorted((x for p in parts for x in p.get("hf") or []), key=lambda x: x[0])
    out["loss_nan"] = sorted({n for p in parts for n in p.get("loss_nan") or []})
    out["expected_steps"] = entry.get("expected_steps")
    if out["steps"]:
        out["last_step"], out["last_step_t"] = out["steps"][-1]["n"], out["steps"][-1]["t"]
    return out


def _gpu_seconds(app_id: str, a: float, b: float) -> float | None:
    """GPU-seconds an app held in [a, b), from the GPUs tab's history (a step function); None if not covered."""
    samples = list(GPU_HISTORY.samples)
    if not samples or samples[0]["t"] > a + 300:
        return None
    total = 0.0
    for s, nxt in zip(samples, samples[1:] + [{"t": time.time()}], strict=True):
        lo, hi = max(a, s["t"]), min(b, nxt["t"])
        if hi > lo:
            total += (s["apps"].get(app_id) or [None, None, 0])[2] * (hi - lo)
    return total


def _unbilled(app_id: str, a: dict, now: float) -> float:
    """Modal bills whole hours once they are over, so a running app's bill trails by up to ~80 min. This estimates
    the time since its newest billed hour at that hour's cost per GPU-second (from the GPUs tab's history, so an
    app that got its GPUs mid-hour isn't undercounted), else per second of the hour it was up."""
    app = app_by_id(app_id)
    if not app:
        return 0.0
    stopped = (
        _ts(app.get("stopped_at"))
        if app.get("stopped_at")
        else (a["last"] if app["state"].startswith("stopped") else None)
    )
    end = min(now, stopped or now)
    if end - a["last"] < 60:
        return 0.0
    billed_gpu_s = _gpu_seconds(app_id, a["last"] - 3600, a["last"])
    since_gpu_s = _gpu_seconds(app_id, a["last"], end)
    if billed_gpu_s and billed_gpu_s > 600 and since_gpu_s is not None:
        return a["last_hour"] / billed_gpu_s * since_gpu_s
    created = _ts(app.get("created_at")) or a["last"] - 3600
    covered = a["last"] - max(a["last"] - 3600, created)
    rate = max(a["last_hour"] / covered if covered >= 600 else 0.0, (a.get("full_hour") or 0.0) / 3600)
    return rate * (end - a["last"])


def run_cost(entry: dict, j: dict) -> dict | None:
    """A run's Modal bill: its attempts' GPU apps, plus its Modal sandbox app when sandboxes ran on Modal."""
    with LOCK:
        cost = (STATE["cost"] or {}).get("apps") or {}
    ids = [m["app_id"] for m in entry.get("_manifests") or []] or [a["app_id"] for a in j["gpu_apps"][:1]]
    if (j.get("modal_sandboxes") or {}).get("app_id"):
        ids.append(j["modal_sandboxes"]["app_id"])
    parts = {i: cost[i] for i in dict.fromkeys(ids) if i in cost}
    if not parts:
        return None
    now = time.time()
    unbilled = {i: _unbilled(i, p, now) for i, p in parts.items()}
    total = sum(p["total"] for p in parts.values())
    return {
        "total": round(total, 2),
        "unbilled": round(sum(unbilled.values()), 2),
        "estimate": round(total + sum(unbilled.values()), 2),
        "last_hour": round(sum(p["last_hour"] for p in parts.values() if p["last"] >= time.time() - 3 * 3600), 2),
        "apps": {
            i: {k: p[k] for k in ("name", "total", "by_resource", "first", "last", "last_hour")}
            for i, p in parts.items()
        },
    }


def collect_watchdogs():
    procs = {}
    for p in Path("/proc").iterdir():
        if not p.name.isdigit():
            continue
        try:
            argv = (p / "cmdline").read_bytes().split(b"\0")
        except OSError:
            continue
        args = [a.decode(errors="replace") for a in argv if a]
        if len(args) >= 4 and args[1].endswith("watchdog.py"):
            try:
                cwd = os.readlink(p / "cwd")
            except OSError:
                continue
            procs[cwd] = {"pid": int(p.name), "app_id": args[2], "run_id": args[3]}
    out = {}
    for rid, ms in manifests().items():
        m = ms[-1]
        d = (LAUNCH / m["launcher"]).parent if LAUNCH and m.get("launcher") else None
        proc = next((v for v in procs.values() if v["app_id"] == m["app_id"]), None)
        if proc:
            d = Path(next(k for k, v in procs.items() if v is proc))
        f = d / "watchdog_status.json" if d else None
        if not f or not f.exists():
            continue
        try:
            status = json.loads(f.read_text())
        except ValueError:
            continue
        out[rid] = {
            "pid": proc and proc["pid"],
            "running": bool(proc),
            "file": str(f.relative_to(LAUNCH)) if LAUNCH and f.is_relative_to(LAUNCH) else str(f),
            "checked": f.stat().st_mtime,
            "status": status,
            "app_id": proc and proc["app_id"],
        }
    with LOCK:
        changed = out != STATE["watchdogs"]
        STATE["watchdogs"] = out
    if changed:
        HUB.poke("watchdogs")


# ---- signals: what deserves attention on a live run, from manifest limits and the watchdog's thresholds ---


def signals(run: dict, entry: dict, now: float) -> list[dict]:
    out = []

    def add(level, sid, text):
        out.append({"level": level, "id": sid, "text": text})

    ms = entry.get("_manifests") or []
    if not ms:
        return out
    m = ms[-1]
    app = app_by_id(m["app_id"])
    st = STARTUP.get(m["app_id"]) or {}
    tail = TAILS.get(m["app_id"])
    if tail and tail.initial:
        tail = None  # half-read history would look like silence
    t = run.get("trials") or {}
    lim = entry.get("limits") or {}
    inflight = t.get("in_flight") or 0
    if not app:
        return out
    if not is_live(app["state"]):
        if inflight:
            add("bad", "cut", f"GPU app {app['state']}; {inflight} trials left without a result")
        return out
    created = _ts(app["created_at"]) or now
    stage = st.get("stage", "queued")
    seen = st.get("seen", {})
    si = STAGE_KEYS.index(stage)
    # only once the startup log has been read: a run registered late would otherwise look stuck at "queued"
    sft = entry.get("kind") == "sft"  # starts no engines: the step-stall check below covers its startup
    if not sft and m["app_id"] in STARTUP and si < STAGE_KEYS.index("ready") and now - created > READY_BY * 0.8:
        add(
            "bad" if now - created > READY_BY else "warn",
            "slow_ready",
            f"not serving {round((now - created) / 60)} min after start (watchdog wakes at {READY_BY // 60})",
        )
    ready = seen.get("ready")
    if tail and ready and not tail.decode_busy and now - ready > DECODE_BY * 0.6:
        add(
            "bad" if now - ready > DECODE_BY else "warn",
            "no_decode",
            f"engine ready {round((now - ready) / 60)} min ago and no model call yet (watchdog stops at {DECODE_BY // 60})",
        )
    if tail and tail.decode_busy and inflight:
        last = max(tail.decode_busy, tail.outcomes[-1][0] if tail.outcomes else 0)
        if now - last > STALL * 0.5:
            add(
                "bad" if now - last > STALL else "warn",
                "stall",
                f"no decode line or trial outcome for {round((now - last) / 60)} min with {inflight} in flight (watchdog stops at {STALL // 60})",
            )
    if tail:
        s = tail.summary()
        tot = s["recent_outcomes"] + len([f for f in tail.setup_fail if now - f[0] < FAIL_WINDOW])
        if tot >= 5 and s["recent_failed"] / tot >= 0.5:
            add(
                "bad" if s["recent_failed"] >= FAIL_MIN and s["recent_failed"] / tot >= FAIL_SHARE else "warn",
                "fail_share",
                f"{s['recent_failed']} of {tot} trial outcomes in the last 10 min failed",
            )
    if entry.get("kind") == "train" and run.get("rows"):
        trs = tail.train_summary() if tail else {}
        exp = (entry.get("expected_fill_min") or 0) * 60 or fill.EXPECTED_FILL_S
        bf = fill.batch_fill(
            run["rows"],
            entry.get("batch_size"),
            entry.get("n_samples"),
            (trs or {}).get("last_step_t") or t.get("first_start"),
            now,
            exp,
        )
        if bf:
            add(bf["level"], "batch_fill", bf["text"])
    fin = t.get("finished") or 0
    exc = sum((t.get("exceptions") or {}).values())
    if fin >= 10 and exc / fin > 0.5:
        top = next(iter(t["exceptions"]), "")
        add("warn", "exc_share", f"{exc} of {fin} finished trials ended in an exception (mostly {top})")
    cap = lim.get("trial_secs") or lim.get("agent_secs")
    if cap and run.get("rows"):
        near = [
            r
            for r in run["rows"]
            if r["phase"] in ("setup", "agent", "verifying") and r.get("start") and now - r["start"] > 0.8 * cap
        ]
        if near:
            add(
                "info",
                "near_cap",
                f"{len(near)} trial{'s' if len(near) > 1 else ''} past 80% of the {dur(cap)} trial cap",
            )
    live_sbx = sandboxes_live(entry, run["run_id"])
    if live_sbx is not None and inflight >= 8 and live_sbx < inflight * 0.5 and stage in ("trials", "rollout"):
        add("warn", "sandboxes", f"only {live_sbx} sandboxes live for {inflight} trials in flight")
    tr = tail.train_summary() if tail else None
    exp_steps = entry.get("expected_steps")
    if tr or (entry.get("kind") in ("train", "sft") and tail):
        tr = tr or {}
        med = tr.get("median_step_s")
        if tr.get("loss_nan"):
            add("bad", "loss_nan", f"train/loss not finite at step {', '.join(map(str, tr['loss_nan'][-5:]))}")
        if tr.get("exit") and tr["exit"]["reason"] not in ("success",):
            add(
                "bad",
                "exit",
                f"trainer exited: {tr['exit']['reason']}"
                + (f" ({tr['exit']['note'][:140]})" if tr["exit"].get("note") else ""),
            )
        # an SFT run has no rollout: from Ray up, loading the trainer must reach a first step
        last = (
            tr.get("last_step_t") or seen.get("rollout") or (seen.get("ray") if entry.get("kind") == "sft" else None)
        )
        if last and not tr.get("exit"):
            # before the first step the batch waits on whole trials, so the trial cap sets the bar; after it, the step time
            warn_after = (
                max(3 * med, 45 * 60)
                if med
                else 3600 if entry.get("kind") == "sft" else (lim.get("trial_secs") or 3 * 3600) + 30 * 60
            )
            gap = now - last
            if gap > warn_after:
                what = f"no training step for {round(gap / 60)} min" + (
                    f" (median step {round(med / 60)} min)" if med else " since the rollout started"
                )
                add("bad" if gap > 1.7 * warn_after else "warn", "step_stall", what)
        if tr.get("sync_open") and now - tr["sync_open"] > 15 * 60:
            add(
                "bad" if now - tr["sync_open"] > 30 * 60 else "warn",
                "sync_slow",
                f"weight sync running for {round((now - tr['sync_open']) / 60)} min",
            )
        if tr.get("sync_failed"):
            add("bad", "sync_failed", f"{tr['sync_failed']} weight sync{'s' if tr['sync_failed'] > 1 else ''} failed")
        hard_s = (lim.get("hard_stop_h") or 0) * 3600
        start = _ts(m["started_at"])
        if exp_steps and med and tr.get("last_step") is not None and hard_s and start:
            left = exp_steps - 1 - tr["last_step"]  # steps count from 0
            if left > 0:
                eta = tr["last_step_t"] + left * med
                end = start + hard_s
                add(
                    "warn" if eta > end else "ok",
                    "step_pace",
                    f"at {round(med / 60)} min a step, step {exp_steps - 1} lands ~{pt(eta)}"
                    + (
                        f", after the {hard_s / 3600:g} h limit ({pt(end)})"
                        if eta > end
                        else f", before the {hard_s / 3600:g} h limit"
                    ),
                )
    hard = lim.get("hard_stop_h")
    start = _ts(m["started_at"])
    if hard and start and not exp_steps:
        end = start + hard * 3600
        exp = t.get("expected")
        rate = t.get("rate_per_min") or 0
        if exp and rate and fin < exp and fin >= max(10, 0.05 * exp):
            eta = now + (exp - fin) / rate * 60
            if eta > end:
                add(
                    "warn",
                    "hard_stop",
                    f"at {rate}/min the last ~{round((eta - end) / 60 * rate)} trials finish after the "
                    f"{hard:g} h hard stop ({pt(end)})",
                )
            else:
                add("ok", "pace", f"on pace to finish ~{pt(eta)}, before the hard stop at {pt(end)}")
    return out


_SIGNAL_ON: dict = {}


def signal_events(rid: str, app_id: str, sigs: list):
    on = {s["id"] for s in sigs if s["level"] in ("bad", "warn")}
    prev = _SIGNAL_ON.get(app_id, set())
    for s in sigs:
        if s["id"] in on - prev:
            EVENTS.emit(f"{app_id}:signal:{s['id']}:{int(time.time() // 600)}", rid, s["text"], s["level"])
    _SIGNAL_ON[app_id] = on


# ---- joins and status, server-side so every view (page, watchdog, API) agrees -----------------------------


def joins(run: dict, entry: dict, apps: list, sail: dict, wandb_rows: list) -> dict:
    rid = run["run_id"]
    t = run.get("trials") or {}
    ms = entry.get("_manifests") or []
    ids = [m["app_id"] for m in ms]
    if ids:
        gpu = [a for a in apps if a["app_id"] in ids]
        gpu.sort(key=lambda a: ids.index(a["app_id"]), reverse=True)
    else:
        name = entry.get("gpu_app_name")
        cands = [a for a in apps if a["name"] == name or rid in a["name"]]
        if name and t.get("first_start"):
            named = sorted(
                [a for a in cands if a["name"] == name and (_ts(a["created_at"]) or 0) <= t["first_start"] + 60],
                key=lambda a: a["created_at"] or "",
                reverse=True,
            )[:1]
            cands = [a for a in cands if a["name"] != name] + named
        elif name:
            cands = [a for a in cands if a["name"] != name or not a["state"].startswith("stopped")]
        gpu = cands
    sbx = entry.get("sandbox") or {}
    sname = sandbox_name(entry, rid)
    sail_app = sail.get(sname) or sail.get(f"miles-fork-sbx-{rid}")
    modal_sbx = next((a for a in apps if a["name"] == sname), None) if sbx.get("provider") == "modal" else None
    gpu = [a for a in gpu if a is not modal_sbx]
    wb = sorted(wandb_of(rid, entry, wandb_rows), key=lambda w: (w["state"] != "running", -(w["created"] or 0)))
    return {
        "gpu_apps": [
            {
                "app_id": a["app_id"],
                "name": a["name"],
                "state": a["state"],
                "tasks": a["tasks"],
                "url": a["url"],
                "created_at": a["created_at"],
            }
            for a in gpu[:4]
        ],
        "sail": sail_app and {"name": sail_app["name"], "live": sail_app["live"]},
        "modal_sandboxes": modal_sbx
        and {
            "name": modal_sbx["name"],
            "app_id": modal_sbx["app_id"],
            "tasks": modal_sbx["tasks"],
            "url": modal_sbx["url"],
        },
        "sandbox_app": sname,
        "sandbox_provider": sbx.get("provider"),
        "wandb": [
            {"project": w["project"], "id": w["id"], "name": w["name"], "state": w["state"], "url": w["url"]}
            for w in wb[:4]
        ],
    }


def run_status(run: dict, j: dict, su: dict | None) -> tuple[str, str]:
    if reported := results.status_of(run.get("node_state") or {}):
        return reported
    t = run.get("trials") or {}
    inflight = t.get("in_flight") or 0
    live_app = any(
        is_live(a["state"]) and (a["state"].startswith(("ephemeral", "running")) or a["tasks"] > 0)
        for a in j["gpu_apps"][:1]
    )
    att = (run.get("attempts") or [{}])[-1]
    if live_app:
        if su and su.get("stage") not in ("trials", "done"):
            return su["stage"], "run"
        return "running", "run"
    if (att.get("outcome") or "").startswith("failed"):
        return "failed", "bad"
    if (
        inflight
        or (t.get("phases") or {}).get("stale")
        and att.get("latest")
        and (att.get("app_state") or "").startswith("stopped")
    ):
        return "stopped, trials cut off", "warn"
    if t.get("finished"):
        return "finished", "good"
    tr, exp = run.get("train") or {}, (run.get("registry") or {}).get("expected_steps")
    if exp and tr.get("last_step") is not None and tr["last_step"] + 1 >= exp:
        return "finished", "good"  # a trainer-only run (SFT): every expected step logged
    # ended with no finished trials: "stopped" when its app was stopped, else plain "ended" (an old dir, a bench)
    if any((a.get("app_state") or "").startswith("stopped") for a in run.get("attempts") or []) or any(
        a["state"].startswith("stopped") for a in j["gpu_apps"][:1]
    ):
        return "stopped", "idle"
    return "ended", "idle"


# ---- views: the topics the page subscribes to, and the /api/state snapshot the watchdog reads ----------------


def runs_view() -> list:
    reg = registry()
    now = time.time()
    with LOCK:
        runs = list(STATE["runs"].values())
        apps, sail, wb, startup = (
            list(STATE["apps"]),
            dict(STATE["sail"]),
            list(STATE["wandb"]),
            dict(STATE["startup"]),
        )
    out = []
    for r in runs:
        entry = reg.get(r["run_id"], {})
        slim = {k: v for k, v in r.items() if k not in ("rows", "restored")}
        if entry:  # the manifests as they are now (a field added by register.py shows without waiting for a scan)
            slim["registry"] = {k: v for k, v in entry.items() if not k.startswith("_")}
        if slim.get("trials"):
            slim["trials"] = slim_summary(slim["trials"])
        ms = entry.get("_manifests") or []
        if ms and (r.get("attempts") or [{}])[-1].get("app_id") != ms[-1]["app_id"]:
            slim["trials"] = None  # a new attempt just launched: its trial window hasn't been scanned yet
        if ms:  # refresh the live bits of each attempt record (app state, stage, log) between scans
            slim["attempts"] = [
                attempt_record(r["run_id"], m, i == len(ms) - 1, slim["trials"] and r.get("trials"))
                for i, m in enumerate(ms)
            ]
            for i, a in enumerate(slim["attempts"]):
                a["n"] = i + 1
        j = joins(r, entry, apps, sail, wb)
        su = startup.get(r["run_id"])
        slim["links"] = j
        slim["train"] = run_train(entry)
        slim["node_state"] = results.node_state(r["run_id"], PUSHES, _run_dir(r["run_id"], r.get("volume")))
        slim["status"], slim["tone"] = run_status(slim, j, su)
        slim["signals"] = signals(r, entry, now) if entry.get("watch") else []
        slim["cost"] = run_cost(entry, j)
        slim["pass"] = pass_at((r.get("trials") or {}).get("tasks") or [], entry.get("n_samples"))
        slim["group"], slim["type"] = groups.classify(slim)
        if ms:
            signal_events(r["run_id"], ms[-1]["app_id"], slim["signals"])
        starts = [_ts(a["started_at"]) for a in slim.get("attempts") or []]
        slim["sort_t"] = max([x for x in starts if x] + [(r.get("trials") or {}).get("first_start") or 0])
        out.append(slim)
    out.sort(key=lambda r: -r["sort_t"])
    link_evals(out)
    return out


def pass_at(tasks: list[dict], k: int | None) -> dict | None:
    """pass@1 and pass@k (unbiased estimator; reward 1 = solved) over each task's counted trials, its first k by
    start (summarize_trials), on the tasks with at least k of them finished. `all` is the same over every finished
    trial, refill extras included. k: the manifest's n_samples, else the most finished trials of any task."""
    tasks = [t for t in tasks if t.get("finished")]
    if not tasks:
        return None
    k = int(k or max(t["finished"] for t in tasks))

    def est(n, c, kk):
        return 1.0 if n - c < kk else 1.0 - math.comb(n - c, kk) / math.comb(n, kk)

    def over(nf, sf):
        done = [t for t in tasks if t[nf]]
        full = [t for t in done if t[nf] >= k]
        return {
            "at1": round(sum(t[sf] / t[nf] for t in done) / len(done), 4) if done else None,
            "atk": round(sum(est(t[nf], t[sf], k) for t in full) / len(full), 4) if full else None,
            "tasks": len(done),
            "tasks_k": len(full),
            "tasks_solved": sum(1 for t in done if t[sf]),
        }

    counted = over("k_finished", "k_solved") if "k_finished" in tasks[0] else over("finished", "solved")
    return {"k": k, **counted, "all": over("finished", "solved")}


def link_evals(runs: list):
    """Attach evaluation summaries to the training runs named by their registry entries."""
    by_id = {r["run_id"]: r for r in runs}
    for r in runs:
        ev = (r.get("registry") or {}).get("evaluates")
        if isinstance(ev, str):
            ev = {"run": ev}
        target = by_id.get((ev or {}).get("run"))
        if not target or target is r:
            continue
        t = r.get("trials") or {}
        target.setdefault("evals", []).append(
            {
                "run_id": r["run_id"],
                "key": r["key"],
                "step": ev.get("step"),
                "label": ev.get("label"),
                "status": r["status"],
                "tone": r["tone"],
                "finished": t.get("finished"),
                "expected": t.get("expected"),
                "mean_reward": t.get("mean_reward"),
                "pass": r.get("pass"),
                "cost": (r.get("cost") or {}).get("estimate"),
                "started": r["sort_t"],
            }
        )
    for r in runs:
        if r.get("evals"):
            r["evals"].sort(
                key=lambda e: (e["step"] is None, e["step"] if isinstance(e["step"], int) else 0, e["started"])
            )


def build_topics(only: set | None, cache: dict) -> dict:
    with LOCK:
        base = {
            "apps": STATE["apps"],
            "sail": STATE["sail"],
            "wandb": STATE["wandb"],
            "startup": STATE["startup"],
            "errors": STATE["errors"],
            "updated": STATE["updated"],
            "watchdogs": STATE["watchdogs"],
            "cost": STATE["cost"],
            "gpus": STATE["gpus"],
        }
        base = json.loads(json.dumps(base, default=str))
    for su in base["startup"].values():  # stages reached since the last startup pass (the log tailer is live)
        st = STARTUP.get(su.get("app_id"))
        if st:
            su |= {"stage": st["stage"], "seen": dict(st["seen"]), "shards": st["shards"], "last": st["last"]}
    makers = {
        **{k: (lambda k=k: base[k]) for k in base},
        "runs": runs_view,
        "events": lambda: EVENTS.recent(300),
        "meta": lambda: {
            "modal_workspace": MODAL_WORKSPACE,
            "started": STARTED,
            "pid": os.getpid(),
            "title": CFG["title"],
            "wandb_entity": WANDB_ENTITY,
            "wandb_project_prefix": CFG["wandb_project_prefix"],
            "app_prefixes": CFG["app_prefixes"],
            "modal_environments": MODAL_ENVS,
        },
    }
    out = {}
    for k, fn in makers.items():
        if only is None or k in only or k not in cache:
            out[k] = json.dumps(scrub(fn()), default=str)
    return out


def detail_version(key: str):
    with LOCK:
        r = STATE["runs"].get(key)
    rid = r["run_id"] if r else None
    return (id(r), len(EVENTS.recent(10**6, rid)) if rid else 0, int(time.time() // 30))


def detail_of(key: str) -> dict | None:
    with LOCK:
        r = STATE["runs"].get(key)
        r = dict(r) if r else None
    if not r:
        return None
    r.pop("restored", None)
    return {**r, "events": EVENTS.recent(200, r["run_id"]), "compare": compare_with(r)}


# Script evals and benches write <dir>/<run_id>/summary.json on the results volume; an ended run's is cached on disk.
EVAL_DIRS = ["oodtask", "inference-throughput", "sc058"]
EVAL_CACHE: dict = {}


def _eval_dir(rid: str):
    if not RESULTS_VOLUMES:
        return None, None, []
    vol = volume(RESULTS_VOLUMES[0])
    for d in EVAL_DIRS:
        try:
            names = [Path(e.path).name for e in vol.listdir(f"{d}/{rid}")]
        except Exception:
            continue
        return vol, f"{d}/{rid}", names
    return None, None, []


def eval_summary(rid: str) -> dict | None:
    if not re.fullmatch(r"[\w.-]+", rid or ""):
        return None
    disk = CACHE / "eval" / f"{rid}.json"
    if disk.exists():
        return json.loads(disk.read_text())
    hit = EVAL_CACHE.get(rid)
    if hit and time.time() - hit[0] < 120:
        return hit[1]
    vol, base, names = _eval_dir(rid)
    out = None
    if vol and "summary.json" in names:
        out = json.loads(b"".join(vol.read_file(f"{base}/summary.json")))
        out["_tries_files"] = sorted(n for n in names if n.startswith("tries_") and n.endswith(".jsonl"))
        out = scrub(out)
        with LOCK:
            run = next((r for r in STATE["runs"].values() if r["run_id"] == rid), None)
        live = run and any(is_live(a.get("app_state") or "") for a in run.get("attempts") or [])
        if not live and (out.get("ended") or out.get("chat") or out.get("low") or "sc_plain" in out):
            disk.parent.mkdir(parents=True, exist_ok=True)
            disk.write_text(json.dumps(out))
    EVAL_CACHE[rid] = (time.time(), out)
    return out


def eval_tries(rid: str, level: str, kind: str, n: int = 12) -> list:
    """A few sampled answers of one eval level (optionally of one outcome kind), answers cut to 1,500 chars."""
    s = eval_summary(rid) or {}
    vol, base, _ = _eval_dir(rid) if s.get("_tries_files") else (None, None, [])
    rows = []
    for f in s.get("_tries_files") or []:
        for line in b"".join(vol.read_file(f"{base}/{f}")).decode(errors="replace").splitlines():
            try:
                x = json.loads(line)
            except ValueError:
                continue
            if (not level or x.get("level") == level) and (not kind or x.get("kind") == kind):
                rows.append(
                    {
                        k: (redact(str(x.get(k)))[:1500] if k in ("answer", "label") else x.get(k))
                        for k in (
                            "id",
                            "level",
                            "effort",
                            "try",
                            "reward",
                            "kind",
                            "finish",
                            "tokens",
                            "secs",
                            "label",
                            "answer",
                        )
                    }
                )
                if len(rows) >= n:
                    return rows
    return rows


def compare_with(r: dict) -> dict | None:
    """The latest earlier run of the same campaign and kind that ran some of the same tasks: its per-task results."""
    reg = r.get("registry") or {}
    mine = {t["task"] for t in (r.get("trials") or {}).get("tasks", [])}
    if not mine or not reg.get("campaign"):
        return None
    start = (r.get("trials") or {}).get("first_start") or time.time()
    with LOCK:
        cands = [
            x
            for x in STATE["runs"].values()
            if x["key"] != r["key"]
            and (x.get("registry") or {}).get("campaign") == reg["campaign"]
            and (x.get("registry") or {}).get("kind") == reg.get("kind")
            and ((x.get("trials") or {}).get("first_start") or 0) < start
        ]
    best = None
    for x in sorted(cands, key=lambda x: -((x.get("trials") or {}).get("first_start") or 0)):
        tasks = {t["task"]: t for t in (x.get("trials") or {}).get("tasks", [])}
        if len(mine & tasks.keys()) >= max(3, len(mine) // 4):
            best = (x, tasks)
            break
    if not best:
        return None
    x, tasks = best
    return {
        "run_id": x["run_id"],
        "key": x["key"],
        "title": (x.get("registry") or {}).get("title"),
        "tasks": {k: [v["solved"], v["finished"], v["mean"]] for k, v in tasks.items() if k in mine},
    }


def snapshot(detail: str | None) -> dict:
    snap = {k: json.loads(v) for k, v in build_topics(None, {}).items()}
    snap |= {"now": time.time(), "modal_workspace": MODAL_WORKSPACE}
    if detail:
        d = detail_of(detail)
        if d:
            snap["detail"] = scrub(d)
    return snap


# ---- persistence: the last state on disk, so a restart serves the page at once --------------------------------

STATE_FILE = DATA / "state.json"


def save_state_loop():
    while True:
        time.sleep(60)
        try:
            with LOCK:
                data = json.dumps(
                    {k: STATE[k] for k in ("apps", "runs", "sail", "wandb", "startup", "updated", "cost", "gpus")},
                    default=str,
                )
            tmp = STATE_FILE.with_suffix(".tmp")
            tmp.write_text(data)
            tmp.replace(STATE_FILE)
        except Exception:
            traceback.print_exc()


def restore_state():
    try:
        saved = json.loads(STATE_FILE.read_text())
    except (OSError, ValueError):
        return
    with LOCK:
        for k in ("apps", "sail", "wandb", "startup", "updated", "cost", "gpus"):
            STATE[k] = saved.get(k, STATE[k])
        for key, r in saved.get("runs", {}).items():
            r["restored"] = True
            STATE["runs"][key] = r
    for su in STATE["startup"].values():  # keep reached stages across restarts
        STARTUP.setdefault(
            su["app_id"],
            {
                "stage": su["stage"],
                "seen": su.get("seen", {}),
                "shards": su.get("shards"),
                "last": su.get("last", ""),
                "tail_read": False,
            },
        )


# ---- loops --------------------------------------------------------------------------------------------


def loop(name, fn, every, takes_first=False, wake: threading.Event | None = None):
    first = True
    while True:
        t0 = time.time()
        try:
            fn(first) if takes_first else fn()
            note_error(name, None)
            stamp(name)
            HUB.poke("updated")
        except Exception as e:
            note_error(name, e)
            traceback.print_exc()
        first = False
        wait = (every() if callable(every) else every) - (time.time() - t0)
        if wake:
            if wake.wait(timeout=max(2, wait)) and wake is RUNS_WAKE:
                time.sleep(3)  # let the result.json the log line announced land on the volume
            wake.clear()
        else:
            time.sleep(max(5, wait))


def runs_every() -> float:
    with LOCK:
        busy = any(
            (r.get("trials") or {}).get("in_flight")
            for r in STATE["runs"].values()
            if (r.get("registry") or {}).get("watch")
        )
    return TRIALS_LIVE_EVERY if busy else TRIALS_IDLE_EVERY


def manifest_watch():
    """A new or changed manifest is a launch: pick it up within 2 s, not at the next scheduled scan."""
    seen = None
    while True:
        try:
            cur = sorted((str(f), f.stat().st_mtime) for d in MANIFEST_DIRS for f in d.glob("*.json"))
            if seen is not None and cur != seen:
                for rid, ms in manifests().items():
                    m = ms[-1]
                    if not m.get("backfilled"):
                        EVENTS.emit(
                            f"{m['app_id']}:launch",
                            rid,
                            f"launched: attempt {len(ms)}, app {m['app_id']}",
                            "info",
                            _ts(m["started_at"]),
                        )
                RUNS_WAKE.set()
                APPS_WAKE.set()
                HUB.poke("*")
            seen = cur
        except Exception as e:
            note_error("manifests", e)
        time.sleep(2)


APPS_WAKE = threading.Event()
STARTUP_WAKE = threading.Event()


# ---- on-demand: app log tail, docs ---------------------------------------------------------------------

LOG_CACHE: dict = {}


def app_logs(app_id: str) -> str:
    with LOCK:
        ours = any(a["app_id"] == app_id for a in STATE["apps"])
    if not ours or not re.fullmatch(r"ap-[A-Za-z0-9]+", app_id):
        return "not one of our apps"
    hit = LOG_CACHE.get(app_id)
    if hit and time.time() - hit[0] < 30:
        return hit[1]
    text = ""
    for extra in ([], ["--since", "2h"], ["--since", "20m"]):  # a long, chatty app can hit Modal's query limit
        try:
            out = subprocess.run(
                [MODAL_CLI, "app", "logs", app_id, "--tail", "400", "--timestamps", *extra],
                capture_output=True,
                text=True,
                timeout=40,
            )
            text = out.stdout + out.stderr
        except subprocess.TimeoutExpired:
            text = "(modal app logs timed out)"
        if "resource limit" not in text:
            break
    text = redact("\n".join(text.splitlines()[-400:])) or "(no log lines yet)"
    LOG_CACHE[app_id] = (time.time(), text)
    return text


def log_lines(app_id: str, after: int = 0, n: int = 400) -> dict:
    tail = TAILS.get(app_id)
    if not tail:
        return {"app": app_id, "live": False, "lines": []}
    items = [x for x in list(tail.lines) if x[0] > after][-n:]
    return {"app": app_id, "live": True, "path": str(tail.path), "lines": items, "noise": tail.noise}


def doc_list() -> list[str]:
    files = []
    for g in DOC_GLOBS:
        files += [str(p.relative_to(LAUNCH)) for p in sorted(LAUNCH.glob(g)) if p.is_file()]
    return files


def doc_read(rel: str) -> str:
    if rel not in doc_list():
        return "not an allowed file"
    p = LAUNCH / rel
    with open(p, "rb") as f:
        size = f.seek(0, 2)
        f.seek(max(0, size - 400_000))
        data = f.read().decode(errors="replace")
    return redact(ANSI.sub("", data))


# ---- HTTP ---------------------------------------------------------------------------------------------

# MONITOR_AUTH=1 (start.sh sets it with --tunnel unless --no-auth): basic auth with <data dir>/auth.txt (user:password)
AUTH_REQUIRED = os.environ.get("MONITOR_AUTH", "0") == "1"
EXPECTED = (
    "Basic " + base64.b64encode((DATA / "auth.txt").read_text().strip().encode()).decode() if AUTH_REQUIRED else ""
)
STATIC = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/curves.js": ("curves.js", "text/javascript; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/pages.js": ("pages.js", "text/javascript; charset=utf-8"),
}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass

    def _send(self, code, body, ctype="application/json"):
        data = body if isinstance(body, bytes) else body.encode()
        gz = len(data) > 2048 and "gzip" in (self.headers.get("Accept-Encoding") or "")
        if gz:
            data = gzip.compress(data, 5)
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("X-Robots-Tag", "noindex")
        if gz:
            self.send_header("Content-Encoding", "gzip")
        self.end_headers()
        self.wfile.write(data)

    def _ingest(self, method: str) -> None:
        """Run state from nodes (MILES_STATE=http): PUT, GET, DELETE /ingest/<run_id>/<key>, behind its own token."""
        given = self.headers.get("Authorization", "")
        if not INGEST_TOKEN or not hmac.compare_digest(given, f"Bearer {INGEST_TOKEN}"):
            self.close_connection = True
            return self._send(401, '{"error": "bad token"}')
        length = int(self.headers.get("Content-Length") or 0)
        if length > 16 * 1024**2:
            self.close_connection = True
            return self._send(413, '{"error": "too large"}')
        body = self.rfile.read(length)
        parts = urlparse(self.path).path.split("/")
        try:
            run_id, key = unquote(parts[2]), unquote(parts[3])
            if method == "PUT":
                PUSHES.put(run_id, key, body)
                RUNS_WAKE.set()
                HUB.poke("runs")
                self._send(200, "null")
            elif method == "DELETE":
                PUSHES.delete(run_id, key)
                self._send(200, "null")
            else:
                value = PUSHES.get(run_id, key)
                self._send(404, "null") if value is None else self._send(200, value)
        except (IndexError, ValueError) as e:
            self._send(400, json.dumps({"error": str(e)}))

    def do_PUT(self):
        if self.path.startswith("/ingest/"):
            return self._ingest("PUT")
        self._send(404, '{"error": "not found"}')

    def do_DELETE(self):
        if self.path.startswith("/ingest/"):
            return self._ingest("DELETE")
        self._send(404, '{"error": "not found"}')

    def do_GET(self):
        if self.path.startswith("/ingest/"):
            return self._ingest("GET")
        if AUTH_REQUIRED and not hmac.compare_digest(self.headers.get("Authorization", ""), EXPECTED):
            self.send_response(401)
            self.send_header("WWW-Authenticate", 'Basic realm="miles-monitor"')
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        try:
            if u.path in STATIC:
                f, ctype = STATIC[u.path]
                self._send(200, (HERE / f).read_bytes(), ctype)
            elif u.path == "/api/poll":
                self._send(
                    200, HUB.poll(int(q.get("since") or 0), q.get("run"), q.get("log"), int(q.get("after") or 0))
                )
            elif u.path == "/api/state":
                self._send(200, json.dumps(snapshot(q.get("run")), default=str))
            elif u.path == "/api/series":
                self._send(
                    200,
                    json.dumps(
                        {
                            "catalog": metrics.CATALOG,
                            "series": metrics.STORE.get(q.get("run", ""), min(4000, int(q.get("max") or 1200))),
                        }
                    ),
                )
            elif u.path in ("/api/wandb/keys", "/api/wandb/series"):
                path = q.get("path", "")
                if not own_wandb_path(path):
                    self._send(404, '{"error": "not one of our W&B runs"}')
                elif u.path.endswith("keys"):
                    self._send(200, json.dumps(metrics.wandb_keys(wandb_api(), path)))
                else:
                    self._send(
                        200,
                        json.dumps(
                            metrics.wandb_series(wandb_api(), path, q.get("key", ""), q.get("stream", "default"))
                        ),
                    )
            elif u.path == "/api/detail":
                self._send(200, json.dumps(scrub(detail_of(q.get("run", ""))), default=str))
            elif u.path == "/api/eval":
                self._send(200, json.dumps(eval_summary(q.get("run", ""))))
            elif u.path == "/api/evaltries":
                self._send(200, json.dumps(eval_tries(q.get("run", ""), q.get("level", ""), q.get("kind", ""))))
            elif u.path == "/api/logs":
                self._send(200, json.dumps({"text": app_logs(q.get("app", ""))}))
            elif u.path == "/api/loglines":
                self._send(
                    200, json.dumps(log_lines(q.get("app", ""), int(q.get("after") or 0), int(q.get("n") or 400)))
                )
            elif u.path == "/api/events":
                self._send(200, json.dumps({"events": EVENTS.recent(int(q.get("n") or 300), q.get("run"))}))
            elif u.path == "/api/docs":
                self._send(200, json.dumps({"files": doc_list()}))
            elif u.path == "/api/doc":
                self._send(200, json.dumps({"text": doc_read(q.get("f", ""))}))
            else:
                self._send(404, '{"error": "not found"}')
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:
            traceback.print_exc()
            self._send(500, json.dumps({"error": redact(f"{type(e).__name__}: {e}")}))


class Server(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 64


def _profile(path: str, every: float = 0.01):
    """MONITOR_PROFILE=<file>: sample every thread's stack and keep counts of the innermost frame of ours."""
    counts: collections.Counter = collections.Counter()
    me = threading.get_ident()
    last = time.time()
    while True:
        for tid, fr in sys._current_frames().items():
            if tid == me:
                continue
            ours = None
            f = fr
            while f:
                if f.f_code.co_filename.endswith(("server.py", "metrics.py")):
                    ours = f"{Path(f.f_code.co_filename).name}:{f.f_code.co_name}:{f.f_lineno}"
                    break
                f = f.f_back
            top = f"{Path(fr.f_code.co_filename).name}:{fr.f_code.co_name}"
            counts[(ours, top)] += 1
        if time.time() - last > 10:
            last = time.time()
            Path(path).write_text("\n".join(f"{n}\t{o}\t{t}" for (o, t), n in counts.most_common(60)))
        time.sleep(every)


def main():
    if os.environ.get("MONITOR_PROFILE"):
        threading.Thread(target=_profile, args=(os.environ["MONITOR_PROFILE"],), daemon=True).start()
    for k in (
        *(("MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET") if "modal" in PROVIDERS else ()),
        "WANDB_API_KEY",
        *(("SAIL_API_KEY",) if "sail" in PROVIDERS else ()),
    ):
        if not os.environ.get(k):
            print(f"warning: {k} not set", file=sys.stderr)
    restore_state()
    threading.Thread(target=HUB.run, daemon=True).start()
    threading.Thread(target=tail_loop, daemon=True).start()
    threading.Thread(target=manifest_watch, daemon=True).start()
    threading.Thread(target=save_state_loop, daemon=True).start()
    if not COLLECT:
        return serve()
    modal_only = [
        ("modal apps", collect_apps, APPS_EVERY, False, APPS_WAKE),
        ("startup", collect_startup, STARTUP_EVERY, False, STARTUP_WAKE),
        ("cost", collect_cost, COST_EVERY, False, None),
        ("gpus", collect_gpus, GPUS_EVERY, False, None),
    ]
    sail_only = [("sail", collect_sail, SAIL_EVERY, False, None)]
    for name, fn, every, tf, wake in [
        ("runs", collect_runs, runs_every, True, RUNS_WAKE),
        ("wandb", collect_wandb, WANDB_EVERY, False, None),
        ("watchdogs", collect_watchdogs, 15, False, None),
        *(modal_only if "modal" in PROVIDERS else []),
        *(sail_only if "sail" in PROVIDERS else []),
    ]:
        threading.Thread(target=loop, args=(name, fn, every, tf, wake), daemon=True).start()
    serve()


def serve():
    server = Server(("127.0.0.1", PORT), Handler)
    print(f"monitor on http://127.0.0.1:{server.server_address[1]}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
