#!/bin/bash
# pm2-start.sh — wrapper de inicialização com detecção de dist/ desatualizado.
# Chamado pelo PM2 ao iniciar/reiniciar o processo.
# Rebuilda se qualquer .ts mudou OU se arquivos estáticos do dashboard mudaram.

set -e
cd "$(dirname "$0")/.."

DIST="dist/index.js"

if [ ! -f "$DIST" ]; then
    echo "[PM2-START] dist/index.js não encontrado — executando build..."
    npm run build
    echo "[PM2-START] Build concluído."
fi

# Detecta fontes TypeScript OU arquivos estáticos do dashboard mais novos que o dist.
# Os .js/.html/.css de src/dashboard/public/ são copiados pelo build mas não são .ts,
# então precisam de uma verificação separada para evitar servir versão desatualizada.
STALE=$(find src \( -name "*.ts" -o -path "*/dashboard/public/*" \) -newer "$DIST" 2>/dev/null | head -1)
if [ -n "$STALE" ]; then
    echo "[PM2-START] Fontes mais novas que dist/ detectadas (ex: $STALE)"
    echo "[PM2-START] Reconstruindo dist/ para evitar erro de versão..."
    npm run build
    echo "[PM2-START] Build concluído."
else
    echo "[PM2-START] dist/ está atualizado."
fi

exec node --max-old-space-size=256 --disable-warning=DEP0040 dist/index.js "$@"
