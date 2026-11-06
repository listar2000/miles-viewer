import json
import os
import re
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
RECIPE = {
    "name": "toy",
    "cluster": {"nodes": 2, "gpu": "B300", "timeout_hours": 6},
    "algorithm": {"num_rollout": 3, "rollout_batch_size": 4, "n_samples": 2},
    "agent": {"timeout": 600, "trial_timeout": 1200, "max_steps": 30},
    "sandbox": {"provider": "sail"},
    "tracking": {"wandb_project": "miles-toy"},
}


def _manifest(monkeypatch, tmp_path):
    monkeypatch.setenv("MILES_MONITOR_DIR", str(tmp_path))
    monkeypatch.setattr("miles_ui.config.DIR", tmp_path)
    from miles_ui import manifest

    return manifest


def test_launcher_registration_keeps_hand_registered_fields(monkeypatch, tmp_path):
    manifest = _manifest(monkeypatch, tmp_path)
    manifest.write_manifest("ap-1", "toy-1", title="by hand", started_at="2026-10-01T00:00:00Z")
    manifest.register_launch("ap-1", "miles-fork", RECIPE, "toy-1")
    m = json.loads((tmp_path / "manifests" / "ap-1.json").read_text())
    assert (m["title"], m["started_at"]) == ("by hand", "2026-10-01T00:00:00Z")
    assert m["expected_trials"] == 24 and m["gpu"] == "2x B300:8" and m["sandbox"]["app"] == "miles-mobius-toy-1"


def test_register_launch_is_off_without_monitor_dir(monkeypatch, tmp_path):
    manifest = _manifest(monkeypatch, tmp_path)
    monkeypatch.delenv("MILES_MONITOR_DIR")
    assert manifest.register_launch("ap-1", "miles-fork", RECIPE, "toy-1") is None
    assert not (tmp_path / "manifests").exists()


@pytest.mark.skipif(sys.version_info < (3, 11), reason="the monitor reads monitor.toml with tomllib")
def test_config_rejects_unknown_keys(tmp_path):
    from miles_ui import config

    (tmp_path / "monitor.toml").write_text('wandb_entity = "me"\n')
    assert config.load(tmp_path / "monitor.toml")["wandb_entity"] == "me"
    (tmp_path / "monitor.toml").write_text('wandb_entiy = "me"\n')
    with pytest.raises(ValueError, match="wandb_entiy"):
        config.load(tmp_path / "monitor.toml")


def test_server_serves_a_registered_run(monkeypatch, tmp_path):
    """The fields a watchdog reads from /api/state, from a manifest and a saved state, with no collectors."""
    manifest = _manifest(monkeypatch, tmp_path)
    manifest.write_manifest("ap-1", "toy-1", **manifest.fields_from_recipe(RECIPE, "toy-1"))
    run = {
        "key": "miles-fork-results/toy-1",
        "run_id": "toy-1",
        "volume": "miles-fork-results",
        "registry": {},
        "attempts": [{"app_id": "ap-1"}],
        "trials": {"dirs": 5, "finished": 3, "solved": 1, "phases": {"done": 3}, "exceptions": {}},
    }
    (tmp_path / "state.json").write_text(json.dumps({"runs": {run["key"]: run}}))
    env = os.environ | {"MILES_MONITOR_DIR": str(tmp_path), "MONITOR_COLLECT": "0", "MONITOR_PORT": "0"}
    log = tmp_path / "server.log"
    with log.open("w") as out:
        proc = subprocess.Popen(
            [sys.executable, "-u", "-m", "miles_ui.server"],
            cwd=REPO,
            env=env,
            stdout=out,
            stderr=subprocess.STDOUT,
        )
    try:
        port = None
        deadline = time.monotonic() + 30
        while port is None and proc.poll() is None and time.monotonic() < deadline:
            m = re.search(r"monitor on http://127\.0\.0\.1:(\d+)", log.read_text())
            port = m and int(m.group(1))
            time.sleep(0.05)
        assert port, log.read_text()
        snap = json.loads(urllib.request.urlopen(f"http://127.0.0.1:{port}/api/state", timeout=30).read())
        (r,) = [r for r in snap["runs"] if r["run_id"] == "toy-1"]
        assert r["links"]["sandbox_app"] == "miles-mobius-toy-1" and r["attempts"][0]["limits"]["trial_secs"] == 1200
        assert (r["trials"]["finished"], r["trials"]["solved"]) == (3, 1)
    finally:
        proc.kill()
        proc.wait()


def test_log_tail_reads_mis_metrics(monkeypatch, tmp_path):
    """A score-centering run's MIS metrics reach the run's step table."""
    _manifest(monkeypatch, tmp_path)
    from miles_ui import server

    log = tmp_path / "launch.log"
    values = {"train/sc_masked": 0.0004, "train/sc_importance_weight": 0.9993}
    log.write_text(f"[2026-10-28 10:56:20.880 actor_cell00000_rank00000] log_utils.py:555 - step 2: {values}\n")
    tail = server.LogTail("ap-1", "toy-1", str(log), engine=False)
    tail.poll()
    (step,) = tail.train_summary()["steps"]
    assert (step["sc_masked"], step["sc_weight"]) == (0.0004, 0.9993)


SFT_LOG = """\
(SftTrainRayActor pid=1) [2026-11-01 10:00:00] val.py:80 - validation at step 0: {'val/nll': 0.61, 'train/step': 0}
(SftTrainRayActor pid=1) [2026-11-01 10:00:20] log_utils.py:555 - step 0: {'train/loss': 0.63, 'train/grad_norm': 0.5, 'train/lr-pg_0': 2e-07, 'train/step': 0}
(SftTrainRayActor pid=1) [2026-11-01 10:00:20] perf.py:56 - perf 0: {'perf/actor_train_time': 15.0, 'perf/actor_train_tok_per_s': 24000.0, 'perf/actor_train_mfu': 0.41}
(SftTrainRayActor pid=1) [2026-11-01 10:00:38] log_utils.py:555 - step 1: {'train/loss': nan, 'train/grad_norm': 0.4, 'train/lr-pg_0': 4e-07, 'train/step': 1}
(SftTrainRayActor pid=1) [2026-11-01 10:00:50] val.py:80 - validation at step 2: {'val/nll': 0.55, 'train/step': 2}
(SftTrainRayActor pid=1) [2026-11-01 10:00:51] hf_export.py:87 - Successfully saved HuggingFace model to /results/s/hf/iter_0000001
"""


def test_log_tail_reads_an_sft_run(monkeypatch, tmp_path):
    """Loss, LR, throughput, validation NLL (on the step it follows), HF exports and a non-finite loss."""
    _manifest(monkeypatch, tmp_path)
    from miles_ui import server

    log = tmp_path / "sft.log"
    log.write_text(SFT_LOG)
    tail = server.LogTail("ap-1", "sft-1", str(log), engine=False, sft=True)
    tail.poll()
    s = tail.train_summary()
    s0, s1 = s["steps"]
    assert (s0["loss"], s0["lr"], s0["tok_per_s"], s0["mfu"]) == (0.63, 2e-07, 24000.0, 0.41)
    assert s1["dt"] == 18.0 and s1["val_nll"] == 0.55 and s["median_step_s"] == 18.0
    assert [v[:2] for v in s["vals"]] == [[0, 0.61], [2, 0.55]]
    assert s["hf"][0][1] == "/results/s/hf/iter_0000001" and s["loss_nan"] == [1]


def test_pass_at_k_and_eval_links(monkeypatch, tmp_path):
    _manifest(monkeypatch, tmp_path)
    from miles_ui import server

    tasks = [{"finished": 2, "solved": 1}, {"finished": 2, "solved": 0}, {"finished": 1, "solved": 1}]
    p = server.pass_at(tasks, 2)
    assert (p["k"], p["atk"], p["tasks_k"], p["at1"]) == (2, 0.5, 2, 0.5)
    runs = [
        {"run_id": "sft-1", "key": "v/sft-1", "registry": {"kind": "sft"}},
        {
            "run_id": "ev-1",
            "key": "v/ev-1",
            "registry": {"evaluates": {"run": "sft-1", "step": 500}},
            "status": "finished",
            "tone": "good",
            "trials": {"finished": 4},
            "pass": p,
            "sort_t": 1,
        },
    ]
    server.link_evals(runs)
    assert [(e["run_id"], e["step"], e["pass"]["atk"]) for e in runs[0]["evals"]] == [("ev-1", 500, 0.5)]


def test_refill_extras_are_left_out_of_pass_at_k(monkeypatch, tmp_path):
    _manifest(monkeypatch, tmp_path)
    from miles_ui import server

    def row(i, start, reward):
        return {"trial": f"a__{i}", "task": "a", "start": start, "phase": "done", "reward": reward}

    # two counted trials fail (one cut off), a later refill extra solves the task, another is still running
    rows = [
        row(3, 30, 1.0),
        row(1, 10, 0.0),
        {**row(2, 11, None), "phase": "stale"},
        {**row(4, 40, None), "phase": "agent"},
    ]
    t = server.summarize_trials(rows, 2, 2)
    assert (t["extras"], [r["extra"] for r in rows]) == (1, [True, False, False, True])
    assert t["tasks"][0]["cells"] == [0.0, "cut", 1.0, "run"]
    p = server.pass_at(t["tasks"], 2)
    # one counted trial finished: the task is left out of pass@2 until both have
    assert (p["atk"], p["tasks_k"], p["at1"], p["all"]["atk"], p["all"]["tasks_solved"]) == (None, 0, 0.0, 1.0, 1)


def test_sft_kind_is_its_own_type(monkeypatch, tmp_path):
    _manifest(monkeypatch, tmp_path)
    from miles_ui import groups

    assert groups.classify({"run_id": "sft-q36-1", "registry": {"kind": "sft"}, "train": {}})[1] == "sft"


def test_thinned_curves_keep_small_values(monkeypatch, tmp_path):
    _manifest(monkeypatch, tmp_path)
    from miles_ui import metrics

    pts = [[float(i), 2e-7] for i in range(100)]
    assert {v for _, v in metrics.thin(pts, 10)} == {2e-7}
