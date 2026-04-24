#!/bin/bash
# NewClaw Auto-Update Script
# Usage: ./update.sh [restart]
# Pulls from GitHub, builds, and optionally restarts

set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

echo "🔄 NewClaw Auto-Update"
echo "====================="

# Determine .env path
ENV_FILE="$DIR/.env"
[ -f "$DIR/newclaw.env" ] && ENV_FILE="$DIR/newclaw.env"

# 1. Fetch remote
echo "📦 Verificando atualizações..."
git fetch origin main
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)

if [ "$LOCAL" = "$REMOTE" ]; then
    echo "✅ Already up to date ($(echo $LOCAL | cut -c1-7))"
    exit 0
fi

echo "📥 Novos commits encontrados!"
git log --oneline $LOCAL..$REMOTE
echo ""

# 2. Backup .env (always protected)
ENV_BACKUP="$DIR/.env.update-backup"
if [ -f "$ENV_FILE" ]; then
    cp "$ENV_FILE" "$ENV_BACKUP"
    echo "🔒 .env salvo em backup"
fi

# 3. Stash local changes
STASHED=0
STASH_OUT=$(git stash --include-untracked 2>&1 || true)
if echo "$STASH_OUT" | grep -q "Saved working directory"; then
    STASHED=1
    echo "📦 Alterações locais salvas (git stash)"
fi

# 4. Pull with rebase
PULL_OK=0
if git pull --rebase origin main 2>&1; then
    PULL_OK=1
else
    echo "⚠️  Pull falhou, fazendo sync forçado..."
    git rebase --abort 2>/dev/null || true
    git reset --hard origin/main
    PULL_OK=1
fi

# 5. Restore stash
if [ "$STASHED" -eq 1 ]; then
    if git stash pop 2>/dev/null; then
        echo "📦 Alterações locais restauradas"
    else
        echo "⚠️  Conflitos ao restaurar (alterações salvas em 'git stash list')"
    fi
fi

# 6. Restore .env
if [ -f "$ENV_BACKUP" ]; then
    cp "$ENV_BACKUP" "$ENV_FILE"
    rm -f "$ENV_BACKUP"
    echo "🔒 .env restaurado"
fi

# 7. Install deps if changed
DIFF=$(git diff $LOCAL..$REMOTE --name-only 2>/dev/null || true)
if echo "$DIFF" | grep -qE 'package(-lock)?\.json'; then
    echo "📦 Instalando dependências..."
    npm install --production
fi

# 8. Build
echo "🔧 Compilando..."
npm run build

# 9. Restart if requested
if [ "$1" = "restart" ] || [ "$1" = "-r" ]; then
    echo "🔄 Reiniciando NewClaw..."
    if command -v newclaw &>/dev/null; then
        newclaw restart --daemon
    elif [ -f "$DIR/start.sh" ]; then
        bash "$DIR/start.sh" restart
    else
        PID=$(pgrep -f "node dist/index.js" | head -1)
        if [ -n "$PID" ]; then
            kill $PID 2>/dev/null
            sleep 2
        fi
        nohup node dist/index.js >> ./logs/newclaw.log 2>&1 &
        echo "PID: $!"
    fi
    echo "✅ NewClaw reiniciado!"
else
    echo "⚠️  Build concluído. Execute './update.sh restart' para aplicar."
fi

echo "====================="
echo "✅ Atualização concluída!"