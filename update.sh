#!/bin/bash
# NewClaw Auto-Update Script
# Usage: ./update.sh [restart]
# Pulls from GitHub, builds, and optionally restarts

set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

echo "🔄 NewClaw Auto-Update"
echo "====================="

# Pull latest changes
echo "📦 Pulling from GitHub..."
git fetch origin main
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)

if [ "$LOCAL" = "$REMOTE" ]; then
    echo "✅ Already up to date ($(echo $LOCAL | cut -c1-7))"
    exit 0
fi

echo "📥 New commits found!"
git log --oneline $LOCAL..$REMOTE

# Pull and build (force sync)
echo "📥 Syncing..."
git checkout -- .
git fetch origin main
git reset --hard origin/main

echo "🔧 Building..."
npm run build

# Restart if requested
if [ "$1" = "restart" ] || [ "$1" = "-r" ]; then
    echo "🔄 Restarting NewClaw..."
    if [ -f "$DIR/start.sh" ]; then
        bash "$DIR/start.sh" restart
    else
        # Fallback: kill and restart
        PID=$(pgrep -f "node dist/index.js" | head -1)
        if [ -n "$PID" ]; then
            kill $PID 2>/dev/null
            sleep 2
        fi
        nohup node dist/index.js >> /tmp/newclaw.log 2>&1 &
        echo "PID: $!"
    fi
    echo "✅ NewClaw restarted!"
else
    echo "⚠️  Build complete. Run './update.sh restart' to apply changes."
fi

echo "====================="
echo "✅ Done!"