#!/bin/bash
# pm2-start.sh — wrapper de inicialização com detecção de dist/ desatualizado.
# Chamado pelo PM2 ao iniciar/reiniciar o processo.
# Se qualquer arquivo .ts em src/ for mais novo que dist/index.js, rebuida antes de iniciar.

set -e
cd "$(dirname "$0")/.."

DIST="dist/index.js"

if [ ! -f "$DIST" ]; then
    echo "[PM2-START] dist/index.js não encontrado — executando build..."
    npm run build
    echo "[PM2-START] Build concluído."
fi

# Verifica se algum .ts é mais novo que o dist (indica git pull sem rebuild)
STALE=$(find src -name "*.ts" -newer "$DIST" 2>/dev/null | head -1)
if [ -n "$STALE" ]; then
    echo "[PM2-START] Fontes mais novas que dist/ detectadas (ex: $STALE)"
    echo "[PM2-START] Reconstruindo dist/ para evitar erro de versão..."
    npm run build
    echo "[PM2-START] Build concluído."
else
    echo "[PM2-START] dist/ está atualizado."
fi

exec node --max-old-space-size=256 --disable-warning=DEP0040 dist/index.js "$@"
