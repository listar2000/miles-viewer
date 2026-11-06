#!/usr/bin/env bash
# Stop the monitor server and its tunnel (only the processes start.sh recorded; the next tunnel gets a new URL).
D=${MILES_MONITOR_DIR:-$HOME/.miles-monitor}
for f in server.pid tunnel.pid; do
  [ -f "$D/$f" ] && kill "$(cat "$D/$f")" 2>/dev/null; rm -f "$D/$f"
done
