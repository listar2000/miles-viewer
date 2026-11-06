"""The GPUs tab: every GPU our Modal apps hold right now, what it is for, and the last 24 hours.

Inputs: gpus_probe.py's containers (each with its GPU type) and per-app function GPU configs, launch manifests
(run id, title), Modal's billing report (cost, provider-reported only) and workstreams.json (what an app is for).
"""

import collections
import json
import re
import time
from pathlib import Path

WINDOW = 24 * 3600
HEARTBEAT = 300


class Workstreams:
    """workstreams.json, re-read when it changes; first matching regex wins."""

    def __init__(self, path: Path):
        self.path, self.mtime, self.rows = path, None, []

    def _load(self):
        try:
            m = self.path.stat().st_mtime
        except OSError:
            return
        if m != self.mtime:
            rows = json.loads(self.path.read_text())["workstreams"]
            self.rows = [{**r, "_re": re.compile(r["match"])} for r in rows]
            self.mtime = m

    def of(self, app_name: str) -> dict:
        self._load()
        for r in self.rows:
            if r["_re"].search(app_name):
                return {k: v for k, v in r.items() if not k.startswith("_") and k != "match"}
        return {"name": "Other probes", "role": "test", "owner": "", "purpose": ""}


def container_gpus(task: dict, functions: list[dict]) -> int | None:
    """GPUs one container holds: the count of the app's function with this GPU type. None when the type alone
    can't tell (two functions of one type with different counts, or a sandbox, which has no function)."""
    counts = {f["count"] for f in functions if f["gpu_type"] == task["gpu_type"] and f["count"]}
    return counts.pop() if len(counts) == 1 else None


def build_apps(probe: dict, ws: Workstreams, manifest_of: dict, app_meta: dict, cost: dict) -> list[dict]:
    apps: dict = {}
    for t in probe["tasks"]:
        if not t["gpu_type"] or t["gpu_type"].upper() == "CPU":
            continue  # a CPU-only container of a GPU app (fetch, cleanup, a CPU check)
        a = apps.get(t["app_id"])
        if a is None:
            m = manifest_of.get(t["app_id"]) or {}
            meta = app_meta.get(t["app_id"]) or {}
            c = (cost.get("apps") or {}).get(t["app_id"]) or {}
            a = apps[t["app_id"]] = {
                "app_id": t["app_id"],
                "name": t["app_name"],
                "url": meta.get("url"),
                "state": meta.get("state"),
                "workstream": ws.of(t["app_name"]),
                "run_id": m.get("run_id"),
                "title": m.get("title"),
                "kind": m.get("kind"),
                "shape": m.get("gpu"),
                "containers": [],
                "gpus": 0,
                "queued_gpus": 0,
                "unknown": 0,
                "by_type": {},
                "started": None,
                "billed": (
                    {"total": c.get("total"), "full_hour": c.get("full_hour"), "last": c.get("last")} if c else None
                ),
            }
        n = container_gpus(t, probe["functions"].get(t["app_id"]) or [])
        queued = not t["started_at"]
        a["containers"].append(
            {
                "task_id": t["task_id"],
                "gpu_type": t["gpu_type"],
                "gpus": n,
                "queued": queued,
                "started_at": t["started_at"],
                "enqueued_at": t["enqueued_at"],
                "sandbox": bool(t["sandbox_id"]),
            }
        )
        if queued:
            a["queued_gpus"] += n or 0
        elif n is None:
            a["unknown"] += 1
        else:
            a["gpus"] += n
            a["by_type"][t["gpu_type"]] = a["by_type"].get(t["gpu_type"], 0) + n
        if not queued:
            a["started"] = min(filter(None, [a["started"], t["started_at"]]))
    for a in apps.values():
        a["containers"].sort(key=lambda c: (c["queued"], c["started_at"] or 0))
    return sorted(apps.values(), key=lambda a: (-a["gpus"], a["started"] or 0))


class History:
    """GPUs per app over time, sampled each probe pass: history/gpus.jsonl gets a line on change and every 5 min."""

    def __init__(self, path: Path):
        self.path = path
        self.samples: collections.deque = collections.deque()
        self.last_line, self.last_t = None, 0.0
        try:
            for line in path.read_text().splitlines():
                s = json.loads(line)
                if s["t"] >= time.time() - WINDOW:
                    self.samples.append(s)
        except (OSError, ValueError):
            pass
        if self.samples:
            self.last_line = json.dumps(self.samples[-1]["apps"], sort_keys=True)

    def add(self, t: float, apps: list[dict]):
        snap = {a["app_id"]: [a["run_id"] or a["name"], a["workstream"]["name"], a["gpus"]] for a in apps if a["gpus"]}
        line = json.dumps(snap, sort_keys=True)
        if line == self.last_line and t - self.last_t < HEARTBEAT:
            return
        self.last_line, self.last_t = line, t
        s = {"t": round(t), "apps": snap}
        self.samples.append(s)
        while self.samples and self.samples[0]["t"] < t - WINDOW:
            self.samples.popleft()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.path.open("a") as f:
            f.write(json.dumps(s) + "\n")

    def series(self) -> list:
        """[t, {workstream: gpus}] steps."""
        out = []
        for s in self.samples:
            by = collections.Counter()
            for _name, w, g in s["apps"].values():
                by[w] += g
            out.append([s["t"], dict(by)])
        return out

    def lanes(self, now: float) -> list[dict]:
        """Per app: [start, end, gpus] segments in the window, from consecutive samples."""
        lanes: dict = {}
        samples = list(self.samples)
        for i, s in enumerate(samples):
            end = samples[i + 1]["t"] if i + 1 < len(samples) else now
            for app_id, (name, w, g) in s["apps"].items():
                lane = lanes.setdefault(app_id, {"app_id": app_id, "name": name, "workstream": w, "segs": []})
                lane["name"] = name  # the latest label (the run id once a manifest names it)
                segs = lane["segs"]
                if segs and segs[-1][1] == s["t"] and segs[-1][2] == g:
                    segs[-1][1] = end
                else:
                    segs.append([s["t"], end, g])
        return sorted(lanes.values(), key=lambda lane: (lane["workstream"], lane["segs"][0][0]))


def billing_by_workstream(gpu_hours: dict, names: dict, ws: Workstreams, now: float) -> dict:
    """Modal's hourly GPU charges in the window, summed per workstream (cost of GPU resources only)."""
    start = (int(now) // 3600) * 3600 - WINDOW
    hours = list(range(start, start + WINDOW + 3600, 3600))
    by: dict = {}
    for app_id, per_hour in gpu_hours.items():
        w = ws.of(names.get(app_id, ""))["name"]
        row = by.setdefault(w, [0.0] * len(hours))
        for t, c in per_hour.items():
            i = (int(float(t)) - start) // 3600
            if 0 <= i < len(hours):
                row[i] += c
    return {"hours": hours, "workstreams": {w: [round(c, 2) for c in row] for w, row in by.items()}}


def view(apps: list[dict], history: History, billing: dict, now: float, checked: float) -> dict:
    by_ws: dict = {}
    for a in apps:
        w = a["workstream"]
        g = by_ws.setdefault(w["name"], {**w, "gpus": 0, "queued_gpus": 0, "by_type": {}, "apps": []})
        g["apps"].append(a)
        g["gpus"] += a["gpus"]
        g["queued_gpus"] += a["queued_gpus"]
        for k, v in a["by_type"].items():
            g["by_type"][k] = g["by_type"].get(k, 0) + v
    by_type = collections.Counter()
    for a in apps:
        by_type.update(a["by_type"])
    live = [a for a in apps if a["gpus"]]
    rated = [
        a
        for a in live
        if a["billed"] and a["billed"]["full_hour"] is not None and (a["billed"]["last"] or 0) >= now - 3 * 3600
    ]
    return {
        "checked": checked,
        "totals": {
            "gpus": sum(a["gpus"] for a in apps),
            "by_type": dict(by_type.most_common()),
            "apps": len(live),
            "containers": sum(1 for a in apps for c in a["containers"] if not c["queued"]),
            "queued_gpus": sum(a["queued_gpus"] for a in apps),
            "unknown": sum(a["unknown"] for a in apps),
            "billed_per_hour": round(sum(a["billed"]["full_hour"] for a in rated), 2) if rated else None,
            "unrated_apps": len(live) - len(rated),
        },
        "workstreams": sorted(by_ws.values(), key=lambda g: (-g["gpus"], -g["queued_gpus"], g["name"])),
        "series": history.series(),
        "lanes": history.lanes(now),
        "billing": billing,
        "window": WINDOW,
    }
