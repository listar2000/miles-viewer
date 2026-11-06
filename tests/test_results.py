"""Runs with no launcher and no provider: from a results dir and from nodes' pushes."""

import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

import pytest

from miles_ui import results as Res

REPO = Path(__file__).resolve().parents[1]
RECIPE = {
    "name": "toy",
    "cluster": {"nodes": 1, "gpu": "H200", "timeout_hours": 1},
    "algorithm": {"num_rollout": 3, "rollout_batch_size": 4, "n_samples": 2},
    "agent": {},
    "sandbox": {},
    "tracking": {"wandb_project": "miles-toy"},
}


def test_local_volume_reads_like_a_modal_one_and_stays_inside(tmp_path):
    (tmp_path / "run1" / "trials").mkdir(parents=True)
    (tmp_path / "run1" / "exit.json").write_text("{}")
    vol = Res.LocalVolume(tmp_path)
    assert {Path(e.path).name for e in vol.listdir("run1")} == {"trials", "exit.json"}
    assert b"".join(vol.read_file("run1/exit.json")) == b"{}"
    with pytest.raises(ValueError):
        vol.listdir("../..")


def test_pushes_refuse_bad_names_and_non_json(tmp_path):
    p = Res.Pushes(tmp_path)
    p.put("run1", "run:run1", b'{"phase": "training"}')
    assert json.loads(p.get("run1", "run:run1"))["phase"] == "training"
    p.delete("run1", "run:run1")
    assert p.get("run1", "run:run1") is None
    with pytest.raises(ValueError):
        p.put("../up", "run:x", b"{}")
    with pytest.raises(ValueError):
        p.put("run1", "../../etc", b"{}")
    with pytest.raises(ValueError):
        p.put("run1", "run:run1", b"not json")


def test_a_dir_name_no_node_pushes_under_reads_as_no_state(tmp_path):
    assert Res.node_state("_probes", Res.Pushes(tmp_path), tmp_path / "_probes") == {}


@pytest.mark.parametrize(
    "state, want",
    [
        ({}, None),
        ({"run": {"phase": "training", "heartbeat_at": 1000}}, ("training", "run")),
        ({"run": {"phase": "training", "heartbeat_at": 100}}, ("no heartbeat", "warn")),
        ({"exit": {"reason": "success", "ended_at": 900}}, ("finished", "good")),
        ({"exit": {"reason": "oom", "ended_at": 900}}, ("failed (oom)", "bad")),
        ({"exit": {"reason": "segment_end", "ended_at": 900}}, ("saved and stopped (segment_end)", "idle")),
        # a relaunch after a failure: the older exit record does not hide the new segment
        (
            {"run": {"phase": "starting", "heartbeat_at": 990, "started_at": 950}, "exit": {"reason": "oom", "ended_at": 900}},
            ("starting", "run"),
        ),
    ],
)
def test_status_comes_from_what_nodes_reported(state, want):
    assert Res.status_of(state, now=1000) == want


def test_a_run_on_storage_becomes_an_attempt(tmp_path):
    run = tmp_path / "results" / "run1"
    (run / "logs").mkdir(parents=True)
    (run / "recipe-20261106-000000.json").write_text(json.dumps({"recipe": RECIPE}))
    (run / "logs" / "trainer-0.log").write_text("hello\n")
    m = Res.node_attempt("run1", "shared", run, Res.Pushes(tmp_path / "pushed"))
    assert m["app_id"] == "node-run1" and m["expected_steps"] == 3 and m["log_path"].endswith("trainer-0.log")
    assert m["results_volume"] == "shared" and m["launcher"] == "node"


@pytest.fixture
def server(tmp_path):
    """The viewer with no provider at all, a results dir, and its token."""
    results = tmp_path / "results"
    run = results / "on-storage"
    (run / "logs").mkdir(parents=True)
    (run / "recipe-20261106-000000.json").write_text(json.dumps({"recipe": RECIPE}))
    (run / "exit.json").write_text(json.dumps({"reason": "success", "ended_at": time.time()}))
    (run / "logs" / "trainer-0.log").write_text("exit record: {}\n")
    data = tmp_path / "data"
    data.mkdir()
    (data / "monitor.toml").write_text(f'providers = []\nresults_dirs = {{shared = "{results}"}}\n')
    env = {k: v for k, v in os.environ.items() if not k.startswith("MODAL")} | {
        "MILES_MONITOR_DIR": str(data),
        "MILES_UI_TOKEN": "tok",
        "MONITOR_PORT": "0",
    }
    log = tmp_path / "server.log"
    with log.open("w") as out:
        proc = subprocess.Popen(
            [sys.executable, "-u", "-m", "miles_ui.server"], cwd=REPO, env=env, stdout=out, stderr=subprocess.STDOUT
        )
    try:
        port = None
        deadline = time.monotonic() + 30
        while port is None and proc.poll() is None and time.monotonic() < deadline:
            m = re.search(r"monitor on http://127\.0\.0\.1:(\d+)", log.read_text())
            port = m and int(m.group(1))
            time.sleep(0.05)
        assert port, log.read_text()
        yield f"http://127.0.0.1:{port}"
    finally:
        proc.kill()
        proc.wait()


def _call(url, method="GET", body=None, token="tok"):
    req = urllib.request.Request(url, data=body, method=method, headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read()


def _runs(base, deadline=20):
    end = time.monotonic() + deadline
    while True:
        runs = {r["run_id"]: r for r in json.loads(_call(f"{base}/api/state"))["runs"]}
        if "on-storage" in runs and ("pushed-run" in runs or time.monotonic() > end):
            return runs
        if time.monotonic() > end:
            raise AssertionError(runs)
        time.sleep(0.2)


def test_no_provider_shows_runs_from_storage_and_from_pushes(server):
    now = time.time()
    beat = {"phase": "training", "step": 2, "num_rollout": 8, "heartbeat_at": now, "started_at": now}
    _call(f"{server}/ingest/pushed-run/run%3Apushed-run", "PUT", json.dumps(beat).encode())
    assert json.loads(_call(f"{server}/ingest/pushed-run/run%3Apushed-run"))["step"] == 2

    runs = _runs(server)
    assert runs["on-storage"]["status"] == "finished" and runs["on-storage"]["registry"]["expected_steps"] == 3
    assert runs["pushed-run"]["status"] == "training"
    assert runs["pushed-run"]["node_state"]["run"]["step"] == 2
    assert runs["pushed-run"]["attempts"][-1]["url"] is None


def test_ingest_needs_the_token(server):
    with pytest.raises(urllib.error.HTTPError) as e:
        _call(f"{server}/ingest/r1/run%3Ar1", "PUT", b"{}", token="wrong")
    assert e.value.code == 401
