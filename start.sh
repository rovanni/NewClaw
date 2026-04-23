#!/bin/bash
# NewClaw start/restart script
# Usage: ./start.sh [start|stop|restart]

DIR="$(cd "$(dirname "$0")" && pwd)"
PIDFILE="$DIR/newclaw.pid"
LOGFILE="/tmp/newclaw.log"
WATCHDOG_PIDFILE="$DIR/watchdog.pid"

case "$1" in
  start)
    if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
      echo "NewClaw already running (PID $(cat "$PIDFILE"))"
      exit 0
    fi
    cd "$DIR"
    nohup node dist/index.js >> "$LOGFILE" 2>&1 &
    echo $! > "$PIDFILE"
    echo "NewClaw started (PID $(cat "$PIDFILE"))"
    # NOTE: No watchdog - use systemd or external process manager for auto-restart
    ;;
  stop)
    if [ -f "$PIDFILE" ]; then
      kill "$(cat "$PIDFILE")" 2>/dev/null
      rm -f "$PIDFILE"
      echo "NewClaw stopped"
    else
      pkill -f 'node dist/index' 2>/dev/null
      echo "NewClaw stopped (pkill)"
    fi
    ;;
  restart)
    "$DIR/start.sh" stop
    sleep 2
    "$DIR/start.sh" start
    ;;
  *)
    echo "Usage: $0 {start|stop|restart}"
    exit 1
    ;;
esac