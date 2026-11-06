"""Batch fill: is the rollout on track to hand the trainer its next batch?

A batch needs batch_size complete groups of n_samples trials; a failed trial drops its whole group (Miles' default
filter keeps only groups with no aborted sample), so clean trials alone overstate progress. Groups are inferred:
a task's trials in start order, n_samples at a time (a group's trials start seconds apart; the same task's next
group minutes later).
"""

import collections

EXPECTED_FILL_S = 60 * 60  # a manifest's expected_fill_min overrides
# fraction of the expected fill before the projection is trusted: groups finish in bursts
JUDGE_AFTER = 1.0
LIVE = ("setup", "agent", "verifying")


def groups(rows: list[dict], n: int) -> list[list[dict]]:
    by = collections.defaultdict(list)
    for r in rows:
        if r.get("start"):
            by[r.get("task")].append(r)
    out = []
    for rs in by.values():
        rs.sort(key=lambda r: r["start"])
        out += [rs[i : i + n] for i in range(0, len(rs), n)]
    return out


def batch_fill(
    rows: list[dict], batch: int, n: int, since: float, now: float, expected_s: float = EXPECTED_FILL_S
) -> dict | None:
    """rows: trials with task, start, phase, finished. since: when this batch's rollout began (first trial start,
    or the last training step). None when there is nothing to judge (no batch shape, or the rollout is idle)."""
    if not batch or not n or not since:
        return None
    complete = failed = 0
    for g in groups(rows, n):
        ends = [r.get("finished") or 0 for r in g]
        if any(r.get("phase") == "error" for r in g):
            failed += max(ends) >= since or any(r.get("phase") in LIVE for r in g)
        elif len(g) == n and all(r.get("phase") == "done" for r in g) and max(ends) >= since:
            complete += 1
    in_flight = sum(1 for r in rows if r.get("phase") in LIVE)
    elapsed = now - since
    out = {
        "batch": batch,
        "complete": complete,
        "failed": failed,
        "in_flight": in_flight,
        "elapsed_s": round(elapsed),
        "expected_s": expected_s,
        "projected_s": None,
        "level": "ok",
    }
    if complete >= batch:
        out["text"] = f"batch filled: {complete} complete groups of {batch} in {round(elapsed / 60)} min"
        return out
    if not in_flight:
        return None  # nothing running: the rollout waits on the trainer, not the other way round
    rate = complete / elapsed if elapsed > 0 else 0
    proj = elapsed + (batch - complete) / rate if rate else float("inf")
    out["projected_s"] = None if proj == float("inf") else round(proj)
    lost = f", {failed} dropped by a failed trial" if failed else ""
    when = "not at this rate" if proj == float("inf") else f"~{round(proj / 60)} min"
    out["text"] = (
        f"batch {complete}/{batch} groups complete after {round(elapsed / 60)} min{lost}; "
        f"projected fill {when} (expected ~{round(expected_s / 60)})"
    )
    if failed >= max(2, batch // 2):  # half the batch lost; a few dropped groups per batch are routine
        out["level"] = "bad"
    if elapsed >= JUDGE_AFTER * expected_s:
        if proj > 2 * expected_s:
            out["level"] = "bad"
        elif proj > 1.3 * expected_s and out["level"] == "ok":
            out["level"] = "warn"
    return out
