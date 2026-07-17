#!/bin/sh
set -u

terminating=0
child_pid=""

forward_signal() {
  terminating=1
  if [ -n "$child_pid" ]; then
    kill -TERM "$child_pid" 2>/dev/null || true
  fi
}

trap forward_signal TERM INT

node src/index.js &
child_pid=$!
wait "$child_pid"
status=$?

if [ "$terminating" -eq 1 ] || [ "$status" -eq 0 ]; then
  exit "$status"
fi

delay="${MCP_FAILURE_RESTART_DELAY_SECONDS:-60}"
echo "mqttctl-mcp exited with status $status; delaying container exit for ${delay}s so Docker Compose does not restart-loop aggressively." >&2
sleep "$delay" &
child_pid=$!
wait "$child_pid" || true
exit "$status"
