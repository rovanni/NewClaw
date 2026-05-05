#!/usr/bin/env bash
# validate-deploy.sh — Verifica integridade pós-deploy do NewClaw
# Uso: ./deploy/validate-deploy.sh
set -euo pipefail

SERVICE="newclaw"
LOG_LINES=30
CRASH_WINDOW=300  # 5 min

echo "=== NewClaw Deploy Validation ==="
echo ""

# 1. Service status
echo "📋 Service status:"
if systemctl is-active --quiet "$SERVICE"; then
    echo "   ✅ $SERVICE is active (running)"
else
    echo "   ❌ $SERVICE is NOT running"
    systemctl status "$SERVICE" --no-pager 2>/dev/null || true
    exit 1
fi

# 2. Enabled on boot?
if systemctl is-enabled --quiet "$SERVICE"; then
    echo "   ✅ $SERVICE enabled on boot"
else
    echo "   ⚠️  $SERVICE NOT enabled on boot"
fi

# 3. Recent logs (last N lines)
echo ""
echo "📄 Recent logs (last $LOG_LINES lines):"
journalctl -u "$SERVICE" -n "$LOG_LINES" --no-pager 2>/dev/null || \
    tail -n "$LOG_LINES" /tmp/newclaw.log 2>/dev/null || echo "   ⚠️  No logs found"

# 4. Crash loop detection
echo ""
echo "🛡️ Crash loop detection (last $CRASH_WINDOW seconds):"
RESTART_COUNT=$(journalctl -u "$SERVICE" --since "$(date -d "-${CRASH_WINDOW} seconds" '+%Y-%m-%d %H:%M:%S')" 2>/dev/null | grep -c "Started $SERVICE" || true)
if [ "$RESTART_COUNT" -le 3 ]; then
    echo "   ✅ Restarts in last ${CRASH_WINDOW}s: $RESTART_COUNT (≤3 = OK)"
else
    echo "   ❌ CRASH LOOP: $RESTART_COUNT restarts in last ${CRASH_WINDOW}s"
    echo "   Check: journalctl -u $SERVICE --since '-${CRASH_WINDOW}s'"
fi

# 5. Service file validation
echo ""
echo "⚙️ Service file checks:"
SERVICE_FILE="/etc/systemd/system/${SERVICE}.service"
if [ -f "$SERVICE_FILE" ]; then
    echo "   File: $SERVICE_FILE"
    grep -q "Restart=on-failure" "$SERVICE_FILE" && echo "   ✅ Restart=on-failure" || echo "   ⚠️  Missing Restart=on-failure"
    grep -q "StartLimitBurst=" "$SERVICE_FILE" && echo "   ✅ StartLimitBurst set" || echo "   ⚠️  Missing StartLimitBurst"
    grep -q "WatchdogSec=" "$SERVICE_FILE" && echo "   ✅ WatchdogSec set" || echo "   ⚠️  Missing WatchdogSec"
else
    echo "   ⚠️  Service file not found at $SERVICE_FILE"
fi

# 6. Process health
echo ""
echo "🏥 Process health:"
PID=$(systemctl show "$SERVICE" --property=MainPID --value 2>/dev/null || echo "0")
if [ "$PID" != "0" ] && kill -0 "$PID" 2>/dev/null; then
    MEM=$(ps -p "$PID" -o rss= 2>/dev/null | awk '{printf "%.1f", $1/1024}')
    CPU=$(ps -p "$PID" -o %cpu= 2>/dev/null | tr -d ' ')
    echo "   ✅ PID $PID alive — Memory: ${MEM}MB, CPU: ${CPU}%"
else
    echo "   ❌ Process not responding (PID=$PID)"
fi

# 7. Dashboard reachable?
echo ""
echo "🌐 Dashboard check:"
DASHBOARD_PORT=3090
if curl -s -o /dev/null -w "%{http_code}" "http://localhost:${DASHBOARD_PORT}/" 2>/dev/null | grep -qE "200|302"; then
    echo "   ✅ Dashboard responding on :${DASHBOARD_PORT}"
else
    echo "   ⚠️  Dashboard not responding on :${DASHBOARD_PORT}"
fi

# 8. Telegram bot connected?
echo ""
echo "🤖 Telegram bot check:"
if journalctl -u "$SERVICE" -n 100 --no-pager 2>/dev/null | grep -q "bot_started"; then
    echo "   ✅ Telegram bot started"
else
    echo "   ⚠️  No 'bot_started' found in recent logs"
fi

echo ""
echo "=== Validation complete ==="