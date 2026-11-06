#!/usr/bin/env bash
# (Re)start the monitor server, detached, on 127.0.0.1. Data, logs and pid files live in $MILES_MONITOR_DIR
# (default ~/.miles-monitor).
#
#   ./start.sh               # local only: http://127.0.0.1:8787 (or the config's port)
#   ./start.sh --tunnel      # plus a cloudflared quick tunnel, behind basic auth; prints the URL
#   ./start.sh --tunnel --no-auth   # a public page: read-only and redacted, but anyone with the URL
#
# A running tunnel is kept, so a server restart keeps its URL, and auth stays on while it runs (unless --no-auth).
# The password is <data dir>/auth.txt (user:password), made on first use. Credentials (MODAL_TOKEN_*,
# WANDB_API_KEY, SAIL_API_KEY) come from the environment, or from $MILES_DOTENV_DIR/.env when that is set.
# MONITOR_PYTHON picks the interpreter (default python3, 3.11+, with modal, wandb and pyyaml installed).
set -euo pipefail
tunnel=0; auth=1
for a in "$@"; do
  case $a in
    --tunnel) tunnel=1 ;;
    --no-auth) auth=0 ;;
    *) sed -n 2,12p "$0"; exit 2 ;;
  esac
done
REPO=$(cd "$(dirname "$0")" && pwd)
export MILES_MONITOR_DIR=${MILES_MONITOR_DIR:-$HOME/.miles-monitor}
D=$MILES_MONITOR_DIR
mkdir -p "$D"
[ -f "$D/server.pid" ] && kill "$(cat "$D/server.pid")" 2>/dev/null && sleep 1 || true
if [ -n "${MILES_DOTENV_DIR:-}" ] && [ -f "$MILES_DOTENV_DIR/.env" ]; then set -a; . "$MILES_DOTENV_DIR/.env"; set +a; fi
tunnel_up() { [ -f "$D/tunnel.pid" ] && kill -0 "$(cat "$D/tunnel.pid")" 2>/dev/null; }
if [ $auth = 1 ] && { [ $tunnel = 1 ] || tunnel_up; }; then
  if [ ! -s "$D/auth.txt" ]; then
    (umask 077; echo "miles:$(head -c 18 /dev/urandom | base64 | tr -d '/+=')" > "$D/auth.txt")
    echo "login: $(cat "$D/auth.txt") (in $D/auth.txt)"
  fi
  export MONITOR_AUTH=1
else
  export MONITOR_AUTH=0
fi
cd "$REPO"
setsid nohup "${MONITOR_PYTHON:-python3}" -u -m miles_ui.server > "$D/server.log" 2>&1 < /dev/null & echo $! > "$D/server.pid"
port=$(MILES_MONITOR_DIR=$D "${MONITOR_PYTHON:-python3}" -c 'import os; from miles_ui import config; print(os.environ.get("MONITOR_PORT") or config.load()["port"])')
if [ $tunnel = 0 ]; then
  tunnel_up && cat "$D/url.txt" 2>/dev/null || echo "http://127.0.0.1:$port"
  exit 0
fi
if ! tunnel_up; then
  rm -f "$D/url.txt"
  setsid nohup "${CLOUDFLARED:-cloudflared}" tunnel --no-autoupdate --url "http://127.0.0.1:$port" > "$D/tunnel.log" 2>&1 < /dev/null & echo $! > "$D/tunnel.pid"
fi
for _ in $(seq 60); do
  url=$(grep -aoE 'https://[a-z0-9-]+\.trycloudflare\.com' "$D/tunnel.log" | head -1 || true)
  [ -n "$url" ] && { echo "$url" > "$D/url.txt"; echo "$url"; exit 0; }
  sleep 1
done
echo "no tunnel URL yet; see $D/tunnel.log" >&2
