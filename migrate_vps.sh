#!/bin/bash

# Script de Migração Automatizada: Thorial -> NewClaw
# Autor: Antigravity

echo "🪐 Iniciando migração para NewClaw..."

# 1. Definir caminhos
OLD_DIR="$HOME/thorial"
NEW_DIR="$HOME/newclaw"

# 2. Verificar se a pasta antiga existe
if [ ! -d "$OLD_DIR" ]; then
    echo "❌ Erro: A pasta $OLD_DIR não foi encontrada."
    exit 1
fi

# 3. Parar processos do Node
echo "🛑 Parando processos do Node..."
pkill -f node || echo "⚠️ Nenhum processo node encontrado rodando."

# 4. Renomear o diretório principal
echo "📂 Renomeando pasta de 'thorial' para 'newclaw'..."
mv "$OLD_DIR" "$NEW_DIR"

# 5. Entrar na nova pasta
cd "$NEW_DIR" || exit

# 6. Renomear banco de dados (se existir)
if [ -f "data/thorial.db" ]; then
    echo "💾 Renomeando banco de dados de thorial.db para newclaw.db..."
    mv "data/thorial.db" "data/newclaw.db"
fi

# 7. Renomear arquivos residuais (.env e .pid)
if [ -f "thorial.env" ]; then
    echo "⚙️ Renomeando thorial.env para newclaw.env..."
    mv "thorial.env" "newclaw.env"
fi

if [ -f "thorial.pid" ]; then
    echo "🧹 Removendo thorial.pid antigo..."
    rm -f "thorial.pid"
fi

# 7. Sincronizar com o repositório (opcional, mas recomendado)
# Nota: Você deve ter feito o push das alterações que eu fiz antes de rodar isso.
echo "📥 Sincronizando código..."
git fetch origin
git reset --hard origin/main

# 8. Limpar PIDs antigos
rm -f *.pid

echo "==========================================="
echo "✅ Migração concluída com sucesso!"
echo "📍 Sua pasta agora é: $NEW_DIR"
echo "🚀 Para iniciar, use: node bin/newclaw start --daemon"
echo "==========================================="
