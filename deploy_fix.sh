#!/bin/bash
# Deploy NewClaw fixes: Marte → Venus
# Changes:
#   1. ProviderFactory: separate classification/generation queues
#   2. ModelRouter: use classifyWithFallback + 30s timeout
#   3. AppLogger: file audit logging via LOG_FILE
#   4. Systemd: daemon mode + LOG_FILE env

set -e
echo "🚀 Deploying NewClaw fixes to Venus..."

# 1. Push to GitHub
cd /home/rover/.openclaw/workspace/projects/NewClaw
git add -A
git status --short

echo ""
echo "📦 Committing and pushing to GitHub..."
git commit -m "fix: separate classification/generation queues, file audit logging

- ProviderFactory: separate classificationQueue and generationQueue
  (classification no longer blocks on long generations)
- ProviderFactory: added classifyWithFallback() and OllamaProvider.classify()
- ModelRouter: use classifyWithFallback with 30s timeout (was 15s chatWithFallback)
- AppLogger: file audit logging via LOG_FILE env (clean, no ANSI)
- Fixes: timeout errors causing 'Erro interno ao processar mensagem'" || true
git push origin main 2>&1

echo ""
echo "📥 Pulling and building on Venus..."
ssh venus "cd ~/newclaw && git pull origin main 2>&1"

echo ""
echo "🔧 Building on Venus..."
ssh venus "cd ~/newclaw && npm run build 2>&1"

echo ""
echo "📝 Adding LOG_FILE to .env..."
ssh venus "cd ~/newclaw && grep -q 'LOG_FILE=' .env || echo 'LOG_FILE=./logs/newclaw-audit.log' >> .env"

echo ""
echo "🔄 Restarting NewClaw..."
ssh venus "cd ~/newclaw && newclaw restart --daemon 2>&1"

echo ""
echo "✅ Waiting 5s and checking status..."
sleep 5
ssh venus "cd ~/newclaw && newclaw status 2>&1"

echo ""
echo "📋 Recent logs:"
ssh venus "tail -20 ~/newclaw/logs/newclaw-stdout.log 2>/dev/null || echo 'No stdout log yet'"

echo ""
echo "✅ Deploy complete!"