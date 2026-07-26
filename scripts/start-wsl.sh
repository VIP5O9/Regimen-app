#!/bin/bash
# REGIMEN — idempotent starter for WSL. Safe to run repeatedly; starts the
# server only if it isn't already running. A live node process also keeps the
# WSL VM from idle-shutdown.
#
# Paths come from this script's own location, so the repo can live anywhere.
# PORT must match the server's (config.js default: 3117).
set -u
APP_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
APP="$APP_DIR/server.js"
LOG="$APP_DIR/data/server.log"
PORT="${PORT:-3117}"

mkdir -p "$APP_DIR/data"

# listener check, not pgrep: pgrep -f matches its own caller's command line
if ss -tln 2>/dev/null | grep -q ":$PORT "; then
  echo "REGIMEN already listening on $PORT"
  exit 0
fi

# setsid + closed stdin: fully detach from the wsl.exe session so WSL's
# session teardown can't reap the server when the launcher exits
setsid nohup node "$APP" < /dev/null >> "$LOG" 2>&1 &
disown

# Poll for the listener instead of a single sleep: node needs ~2-4s to come up
# off the /mnt/c 9p mount, so a fixed `sleep 1` reported a false failure while
# the server was in fact starting normally.
for _ in $(seq 1 20); do
  if ss -tln 2>/dev/null | grep -q ":$PORT "; then
    echo "REGIMEN started and listening on $PORT — log: $LOG"
    exit 0
  fi
  sleep 1
done

echo "REGIMEN failed to start after 20s — check $LOG"
exit 1
