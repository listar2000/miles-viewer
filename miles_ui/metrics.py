"""Time series for the monitor: a history store under monitor/history and the samplers that feed it.

Sources, all read-only towards the run:
- engine.*  SGLang's own "Decode batch" / "Prefill batch" log lines (TP0), read from `modal app logs`
            by the startup collector it already runs; no request reaches the engine.
- gpu.*     W&B system metrics of the run (the wandb process on the GPU node samples every GPU).
- trials.*  the monitor's own trial scans of the results volume.
- any W&B metric, on demand, for the explorer.
"""

import json
import re
import threading
import time
from datetime import datetime, timezone

from . import config

HISTORY = config.DIR / "history"
HISTORY.mkdir(parents=True, exist_ok=True)

# metric -> (group, label, unit); the order here is the order on the page
CATALOG = {
    "engine.gen_tps": ("Engine", "Output tokens/s (decode)", "tok/s"),
    "engine.running_req": ("Engine", "Running requests", ""),
    "engine.queue_req": ("Engine", "Queued requests", ""),
    "engine.kv_usage": ("Engine", "KV cache usage (full attention)", "frac"),
    "engine.swa_usage": ("Engine", "KV cache usage (sliding window)", "frac"),
    "engine.input_tpm": ("Engine", "New prefill tokens / min", "tok/min"),
    "engine.count": ("Engine", "Engines logging", ""),
    "engine.prefix_hit": ("Engine", "Prefix cache hit rate (prefill)", "frac"),
    "gpu.util": ("GPU", "GPU utilization, mean of 8", "%"),
    "gpu.sm_active": ("GPU", "SM active, mean", "%"),
    "gpu.tensor_active": ("GPU", "Tensor core active, mean", "%"),
    "gpu.power": ("GPU", "Power, all GPUs", "W"),
    "gpu.mem_alloc": ("GPU", "Memory allocated, mean", "%"),
    "gpu.dram_active": ("GPU", "DRAM bandwidth active, mean", "%"),
    "gpu.temp_max": ("GPU", "Temperature, hottest GPU", "°C"),
    # training runs: Miles' own per-step log lines ("rollout N: {...}", "step N: {...}", "perf N: {...}"), at the
    # time the step's line was logged
    "train.loss": ("Training", "Train loss (train/loss)", ""),
    "train.val_nll": ("Training", "Validation NLL (val/nll)", ""),
    "train.lr": ("Training", "Learning rate", ""),
    "train.tok_per_s": ("Training", "Trainer tokens/s", "tok/s"),
    "train.mfu": ("Training", "Trainer MFU", "frac"),
    "train.raw_reward": ("Training", "Reward per step (rollout/raw_reward)", ""),
    "train.raw_reward_unfiltered": ("Training", "Reward of groups finished this step (not the trained batch)", ""),
    "train.zero_std_all_zero": ("Training", "Groups with all-zero reward", "frac"),
    "train.zero_std_all_one": ("Training", "Groups with all-one reward", "frac"),
    "train.truncated": ("Training", "Truncated samples", "frac"),
    "train.response_len": ("Training", "Response length, mean", "tok"),
    "train.staleness": ("Training", "Weight staleness, mean (fully async)", ""),
    "train.grad_norm": ("Training", "Grad norm", ""),
    "train.ppo_kl": ("Training", "PPO KL", ""),
    "train.logprob_diff": ("Training", "Train vs rollout log-prob gap (abs)", ""),
    "train.tis_clipfrac": ("Training", "TIS clip fraction", "frac"),
    "train.mis_mask_low": ("Training", "MIS masked tokens, ratio below band", "frac"),
    "train.mis_mask_high": ("Training", "MIS masked tokens, ratio above band", "frac"),
    "train.sc_masked": ("Training", "MIS masked tokens (score centering)", "frac"),
    "train.sc_weight": ("Training", "MIS mean token weight (score centering)", ""),
    "train.sc_correction": ("Training", "Score-centering correction, mean", ""),
    "train.step_time": ("Training", "Step time", "s"),
    "train.update_weights_time": ("Training", "Weight sync time", "s"),
    "train.wait_ratio": ("Training", "Trainer waiting on rollout", "frac"),
    "trials.in_flight": ("Trials", "Trials in flight", ""),
    "trials.agent": ("Trials", "Agent running", ""),
    "trials.setup": ("Trials", "Setting up", ""),
    "trials.finished": ("Trials", "Finished", ""),
    "trials.errors": ("Trials", "Finished with exception", ""),
    "trials.solved": ("Trials", "Reward 1", ""),
    "trials.mean_reward": ("Trials", "Mean reward of finished", ""),
    "sandboxes.live": ("Trials", "Live sandboxes", ""),
}


class Store:
    """Per run: an append-only jsonl of [t, metric, value] and a mirror in memory."""

    def __init__(self):
        self.lock = threading.Lock()
        self.series: dict = {}  # run_id -> metric -> [[t, v], ...]
        self.wandb: dict = {}  # run_id -> metric -> [[t, v], ...], replaced on every fetch (W&B samples)
        for f in HISTORY.glob("*.jsonl"):
            s = self.series.setdefault(f.stem, {})
            for line in f.read_text().splitlines():
                try:
                    t, k, v = json.loads(line)
                    s.setdefault(k, []).append([t, v])
                except ValueError:
                    pass
        for f in HISTORY.glob("*.wandb.json"):
            try:
                self.wandb[f.name[: -len(".wandb.json")]] = json.loads(f.read_text())
            except ValueError:
                pass

    def last_t(self, run_id: str, metric: str) -> float:
        with self.lock:
            pts = self.series.get(run_id, {}).get(metric)
            return pts[-1][0] if pts else 0.0

    def add(self, run_id: str, points: list):
        """points: [(t, metric, value)]; keeps only points newer than the metric's last one."""
        rows = []
        with self.lock:
            s = self.series.setdefault(run_id, {})
            for t, k, v in sorted(points):
                if v is None:
                    continue
                pts = s.setdefault(k, [])
                if pts and t <= pts[-1][0]:
                    continue
                pts.append([round(t, 1), v])
                rows.append(json.dumps([round(t, 1), k, v]))
        if rows:
            with open(HISTORY / f"{run_id}.jsonl", "a") as f:
                f.write("\n".join(rows) + "\n")

    def set_wandb(self, run_id: str, series: dict):
        with self.lock:
            self.wandb[run_id] = series
        (HISTORY / f"{run_id}.wandb.json").write_text(json.dumps(series))

    def get(self, run_id: str, max_points: int = 1200) -> dict:
        """Every metric of a run, each thinned to at most max_points by averaging equal time buckets
        (a day of decode lines is ~50k points; the page needs a curve, not every sample)."""
        with self.lock:
            out = {k: list(v) for k, v in self.series.get(run_id, {}).items()}
            out.update({k: list(v) for k, v in self.wandb.get(run_id, {}).items()})
        return {k: thin(v, max_points) for k, v in out.items()}


def thin(pts: list, n: int) -> list:
    if len(pts) <= n:
        return pts
    t0, t1 = pts[0][0], pts[-1][0]
    w = (t1 - t0) / n or 1
    out, acc, b = [], [], None
    for t, v in pts:
        k = int((t - t0) / w)
        if b is not None and k != b and acc:
            out.append([round(acc[-1][0], 1), _r4(sum(x for _, x in acc) / len(acc))])
            acc = []
        b = k
        acc.append((t, v))
    if acc:
        out.append([round(acc[-1][0], 1), _r4(sum(x for _, x in acc) / len(acc))])
    return out


def _r4(v: float) -> float:
    """4 decimals; a value below 1e-2 (a learning rate) keeps 4 significant digits instead."""
    return round(v, 4) if abs(v) >= 1e-2 or v == 0 else float(f"{v:.4g}")


STORE = Store()


# ---- engine: SGLang log lines -----------------------------------------------------------------------

STAMP = re.compile(r"\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})(?:\.\d+)? TP0\b")
# any engine's lead rank: "[... TP0]" with tensor parallelism, a plain "[time]" without it
LEAD = re.compile(
    r"\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})(?:\.\d+)?(?: (?:DP\d+ )?TP(\d+)[^\]]*)?\] (?:Decode|Prefill) batch"
)
RAY_PREFIX = re.compile(r"^\((\w+) pid=(\d+)(?:, ip=([\d.]+))?\)")
DECODE = re.compile(
    r"Decode batch.*?#running-req: (\d+).*?full token usage: ([\d.]+)(?:.*?swa token usage: ([\d.]+))?"
    r".*?gen throughput \(token/s\): ([\d.]+).*?#queue-req: (\d+)"
)
PREFILL = re.compile(r"Prefill batch.*?#new-token: (\d+), #cached-token: (\d+)")


def _stamp(line: str):
    m = STAMP.search(line)
    if not m:
        return None
    return datetime.strptime(m.group(1), "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc).timestamp()


def ingest_engine_logs(run_id: str, lines: list[str]):
    pts, buckets = [], {}
    last_prefill = STORE.last_t(run_id, "engine.input_tpm")
    now_min = int(time.time() // 60) * 60
    for line in lines:
        if "TP0" not in line:
            continue
        t = _stamp(line)
        if t is None:
            continue
        m = DECODE.search(line)
        if m:
            run, kv, swa, tps, queue = m.groups()
            pts += [
                (t, "engine.running_req", int(run)),
                (t, "engine.kv_usage", float(kv)),
                (t, "engine.gen_tps", float(tps)),
                (t, "engine.queue_req", int(queue)),
            ]
            if swa is not None:
                pts.append((t, "engine.swa_usage", float(swa)))
            continue
        m = PREFILL.search(line)
        if m:
            b = int(t // 60) * 60
            if b + 60 <= last_prefill or b >= now_min:  # done already, or the minute isn't over yet
                continue
            new, cached = buckets.setdefault(b, [0, 0])
            buckets[b] = [new + int(m.group(1)), cached + int(m.group(2))]
    # a bucket only counts if the fetched lines cover the whole minute (the fetch starts mid-minute)
    first = min((_stamp(ln) for ln in lines if "TP0" in ln and _stamp(ln)), default=None)
    for b, (new, cached) in buckets.items():
        if first is not None and b < first:
            continue
        pts += [
            (b + 60, "engine.input_tpm", new),
            (b + 60, "engine.prefix_hit", round(cached / (new + cached), 4) if new + cached else None),
        ]
    STORE.add(run_id, pts)


class EngineFeed:
    """Engine samples from a live log, line by line (the local launch log or a streamed `modal app logs`):
    decode points go in at once, prefill tokens are summed per minute and written when the minute closes."""

    def __init__(self, run_id: str):
        self.run_id, self.minute, self.new, self.cached = run_id, None, 0, 0
        self.pts: list = []
        self.engines: dict = {}  # engine (its Ray actor) -> (t, running, kv, swa, tps, queue) of its last decode line
        self.last_emit = 0.0

    def line(self, line: str):
        lead = LEAD.search(line)
        if not lead or lead.group(2) not in (None, "0"):
            return
        t = datetime.strptime(lead.group(1), "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc).timestamp()
        m = DECODE.search(line)
        if m:
            # several engines log side by side: each curve is the sum (or mean, for cache usage) over the engines
            # heard from in the last 2 minutes, so two engines never zigzag on one line
            ray = RAY_PREFIX.match(line.lstrip())
            run, kv, swa, tps, queue = m.groups()
            self.engines[ray.group(0) if ray else ""] = (
                t,
                int(run),
                float(kv),
                None if swa is None else float(swa),
                float(tps),
                int(queue),
            )
            live = [e for e in self.engines.values() if t - e[0] < 120]
            t = max(t, self.last_emit + 0.1)
            self.last_emit = t
            self.pts += [
                (t, "engine.running_req", sum(e[1] for e in live)),
                (t, "engine.kv_usage", round(sum(e[2] for e in live) / len(live), 4)),
                (t, "engine.gen_tps", round(sum(e[4] for e in live), 2)),
                (t, "engine.queue_req", sum(e[5] for e in live)),
            ]
            swas = [e[3] for e in live if e[3] is not None]
            if swas:
                self.pts.append((t, "engine.swa_usage", round(sum(swas) / len(swas), 4)))
            if len(self.engines) > 1:
                self.pts.append((t, "engine.count", len(live)))
            return
        m = PREFILL.search(line)
        if m:
            b = int(t // 60) * 60
            if self.minute is not None and b > self.minute:
                self._close()
            if self.minute is None or b >= self.minute:
                self.minute = b
                self.new += int(m.group(1))
                self.cached += int(m.group(2))

    def _close(self):
        tot = self.new + self.cached
        self.pts += [
            (self.minute + 60, "engine.input_tpm", self.new),
            (self.minute + 60, "engine.prefix_hit", round(self.cached / tot, 4) if tot else None),
        ]
        self.new = self.cached = 0

    def flush(self):
        if self.minute is not None and time.time() > self.minute + 90:  # no prefill line for a while: close it
            self._close()
            self.minute = None
        if self.pts:
            STORE.add(self.run_id, self.pts)
            self.pts = []


# ---- trials: from the monitor's own scan --------------------------------------------------------------


def backfill_trials(run_id: str, rows: list[dict]):
    """The first time a run is sampled, rebuild its trial curves from trial start/finish times."""
    if STORE.last_t(run_id, "trials.finished") or not rows:
        return
    starts = [r["start"] for r in rows if r.get("start")]
    if not starts:
        return
    pts, t = [], (int(min(starts)) // 60) * 60
    while t < time.time() - 60:
        live = [
            r for r in rows if r.get("start") and r["start"] <= t and not (r.get("finished") and r["finished"] <= t)
        ]
        fin = [r for r in rows if r.get("finished") and r["finished"] <= t]
        rewards = [r["reward"] for r in fin if r.get("reward") is not None]
        pts += [
            (t, "trials.in_flight", len(live)),
            (t, "trials.finished", len(fin)),
            (t, "trials.errors", sum(1 for r in fin if r.get("exception"))),
            (t, "trials.solved", sum(1 for x in rewards if x >= 1.0)),
            (t, "trials.mean_reward", round(sum(rewards) / len(rewards), 4) if rewards else None),
        ]
        t += 60
    STORE.add(run_id, pts)


def ingest_trials(run_id: str, trials: dict, sandboxes_live: int | None):
    p, t = trials.get("phases", {}), time.time()
    pts = [
        (t, "trials.in_flight", p.get("setup", 0) + p.get("agent", 0) + p.get("verifying", 0)),
        (t, "trials.agent", p.get("agent", 0)),
        (t, "trials.setup", p.get("setup", 0)),
        (t, "trials.finished", trials.get("finished", 0)),
        (t, "trials.errors", p.get("error", 0)),
        (t, "trials.solved", trials.get("solved", 0)),
        (t, "trials.mean_reward", trials.get("mean_reward")),
    ]
    if sandboxes_live is not None:
        pts.append((t, "sandboxes.live", sandboxes_live))
    STORE.add(run_id, pts)


# ---- GPU: W&B system metrics --------------------------------------------------------------------------

GPU_KEY = re.compile(
    r"^system\.gpu\.(\d+)\.(gpu|smActive|pipeTensorActive|powerWatts|memoryAllocated|dramActive|temp)(?:/l:([\w.:-]+))?$"
)
AGG = {
    "gpu": ("gpu.util", "mean"),
    "smActive": ("gpu.sm_active", "mean"),
    "pipeTensorActive": ("gpu.tensor_active", "mean"),
    "powerWatts": ("gpu.power", "sum"),
    "memoryAllocated": ("gpu.mem_alloc", "mean"),
    "dramActive": ("gpu.dram_active", "mean"),
    "temp": ("gpu.temp_max", "max"),
}


def fetch_wandb_gpu(api, run_id: str, path: str):
    """Per node when the run labels its system metrics by node (ext-015: <key>/l:<role>-node<k>, role train,
    rollout or colocated): series "<name>@<label>". One node, or none labelled: plain "<name>" as before."""
    run = api.run(path)
    raw: dict = {}  # (name, label) -> points
    for row in run.history(stream="system", samples=4000, pandas=False):
        t = row.get("_timestamp")
        if not t:
            continue
        acc: dict = {}
        for k, v in row.items():
            m = GPU_KEY.match(k)
            if m and isinstance(v, (int, float)):
                gpu, field, label = m.group(1), m.group(2), m.group(3) or ""
                acc.setdefault((field, label), []).append(v)
                if field == "gpu":
                    raw.setdefault((f"gpu.{gpu}.util", label), []).append([t, v])
        for (field, label), vals in acc.items():
            name, how = AGG[field]
            v = sum(vals) / len(vals) if how == "mean" else sum(vals) if how == "sum" else max(vals)
            raw.setdefault((name, label), []).append([t, round(v, 2)])
    split = len({label for _, label in raw}) > 1
    out = {(f"{name}@{label}" if split and label else name): pts for (name, label), pts in raw.items()}
    for pts in out.values():
        pts.sort()
    STORE.set_wandb(run_id, out)


# ---- explorer: any W&B metric, on demand --------------------------------------------------------------

_EXPLORER_CACHE: dict = {}


def wandb_keys(api, path: str) -> dict:
    hit = _EXPLORER_CACHE.get(("keys", path))
    if hit and time.time() - hit[0] < 120:
        return hit[1]
    run = api.run(path)
    default = set()
    for row in run.history(samples=200, pandas=False):
        default |= {k for k, v in row.items() if isinstance(v, (int, float)) and not k.startswith("_")}
    default |= {k for k, v in run.summary._json_dict.items() if isinstance(v, (int, float)) and not k.startswith("_")}
    system = set()
    for row in run.history(stream="system", samples=5, pandas=False):
        system |= {k for k, v in row.items() if isinstance(v, (int, float)) and k.startswith("system.")}
    res = {"default": sorted(default), "system": sorted(system)}
    _EXPLORER_CACHE[("keys", path)] = (time.time(), res)
    return res


def wandb_series(api, path: str, key: str, stream: str) -> dict:
    hit = _EXPLORER_CACHE.get((path, key, stream))
    if hit and time.time() - hit[0] < 60:
        return hit[1]
    run = api.run(path)
    if stream == "system":
        rows = run.history(stream="system", samples=4000, pandas=False)
        pts = [[r["_timestamp"], r[key]] for r in rows if isinstance(r.get(key), (int, float)) and r.get("_timestamp")]
        res = {"x": "time", "points": sorted(pts)}
    else:
        rows = run.history(keys=[key], samples=4000, pandas=False)
        pts = [[r.get("_step"), r[key]] for r in rows if isinstance(r.get(key), (int, float))]
        res = {"x": "step", "points": sorted(p for p in pts if p[0] is not None)}
    _EXPLORER_CACHE[(path, key, stream)] = (time.time(), res)
    return res
