#!/bin/bash
# NewClaw start wrapper — redirects stdout/stderr to log files
# This ensures 'newclaw logs' always has content to show

DIR="/home/venus/newclaw"
LOG_DIR="$DIR/logs"
mkdir -p "$LOG_DIR"

exec node "$DIR/bin/newclaw" start \
  >> "$LOG_DIR/newclaw-stdout.log" \
  2>> "$LOG_DIR/newclaw-stderr.log"