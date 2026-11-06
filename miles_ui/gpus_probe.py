"""Print our running Modal containers and their GPUs as one JSON document (read-only).

Modal's CLI lists containers but not their GPUs, so this asks the same internal API the CLI uses:
TaskList (running and queued containers), TaskGetInfo (a container's GPU type) and, per app, AppGetLayout +
FunctionGetById (each function's GPU type and count). Run by server.py in a subprocess so a change in that
unsupported API can only fail this probe, never the server.

    python gpus_probe.py <env> <app-name-regex> [known-apps.json]
"""

import json
import re
import sys

from modal._utils.async_utils import synchronizer
from modal.client import _Client
from modal_proto import api_pb2


async def _functions(client, app_id: str) -> list[dict]:
    layout = await client._stub.AppGetLayout(api_pb2.AppGetLayoutRequest(app_id=app_id))
    out = []
    for tag, fid in layout.app_layout.function_ids.items():
        f = (await client._stub.FunctionGetById(api_pb2.FunctionGetByIdRequest(function_id=fid))).function
        for r in f.ranked_functions:
            g = r.function.resources.gpu_config
            out.append(
                {
                    "function": tag,
                    "gpu_type": g.gpu_type,
                    "count": g.count,
                    "milli_cpu": r.function.resources.milli_cpu,
                    "memory_mb": r.function.resources.memory_mb,
                }
            )
    return out


@synchronizer.create_blocking
async def probe(env: str, pattern: str, known: dict) -> dict:
    client = await _Client.from_env()
    ours = re.compile(pattern)
    res = await client._stub.TaskList(api_pb2.TaskListRequest(environment_name=env))
    tasks, apps = [], {}
    for t in res.tasks:
        if not ours.match(t.app_description or ""):
            continue  # other people's containers are not shown
        info = (await client._stub.TaskGetInfo(api_pb2.TaskGetInfoRequest(task_id=t.task_id))).info
        tasks.append(
            {
                "task_id": t.task_id,
                "app_id": t.app_id,
                "app_name": t.app_description,
                "started_at": t.started_at or None,
                "enqueued_at": t.enqueued_at or None,
                "gpu_type": info.gpu_type,
                "sandbox_id": info.sandbox_id or None,
            }
        )
        if t.app_id not in apps and not info.sandbox_id:
            apps[t.app_id] = known.get(t.app_id) or await _functions(client, t.app_id)
    return {"tasks": tasks, "functions": apps}


if __name__ == "__main__":
    known = json.load(open(sys.argv[3])) if len(sys.argv) > 3 else {}
    print(json.dumps(probe(sys.argv[1], sys.argv[2], known)))
