#!/bin/bash
# NewClaw Auto-Update Script
# Usage: ./update.sh [restart]
# Pulls from GitHub, builds, and optionally restarts

set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

echo "ðŸ”„ NewClaw Auto-Update"
echo "====================="

# Pull latest changes
echo "ðŸ“¦ Pulling from GitHub..."
git fetch origin main
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)

if [ "$LOCAL" = "$REMOTE" ]; then
    echo "âœ… Already up to date ($(echo $LOCAL | cut -c1-7))"
    exit 0
fi

echo "ðŸ“¥ New commits found!"
git log --oneline $LOCAL..$REMOTE

# Pull and build (force sync)
echo ""
echo "âš ï¸  ATENÃ‡ÃƒO: O sync irÃ¡ descartar alteraÃ§Ãµes locais nÃ£o commitadas."
echo "   Certifique-se de ter backup do .env e skills customizados."
echo -n "   Continuar? [s/N]: "
read -r confirm < /dev/tty
case "$confirm" in
  s|S|y|Y) ;;
  *) echo "âŒ Update cancelado."; exit 0 ;;
esac
echo "ðŸ“¥ Syncing..."
git checkout -- .
git fetch origin main
git reset --hard origin/main

echo "ðŸ”§ Building..."
npm run build

# Restart if requested
if [ "$1" = "restart" ] || [ "$1" = "-r" ]; then
    echo "ðŸ”„ Restarting NewClaw..."
    if [ -f "$DIR/start.sh" ]; then
        bash "$DIR/start.sh" restart
    else
        # Fallback: kill and restart
        PID=$(pgrep -f "node dist/index.js" | head -1)
        if [ -n "$PID" ]; then
            kill $PID 2>/dev/null
            sleep 2
        fi
        nohup node dist/index.js >> ./logs/newclaw.log 2>&1 &
        echo "PID: $!"
    fi
    echo "âœ… NewClaw restarted!"
else
    echo "âš ï¸  Build complete. Run './update.sh restart' to apply changes."
fi

echo "====================="
echo "âœ… Done!"