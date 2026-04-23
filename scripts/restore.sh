#!/usr/bin/env bash
# ============================================================
#  NewClaw — Script de Restauração Inteligente
#
#  Este script automatiza a restauração de backups criados
#  pelo desinstalador ou pelo script de backup automático.
# ============================================================

set -e

# ── Cores ────────────────────────────────────────────────────
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

# ── Configurações ────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NEWCLAW_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BACKUP_ROOT="${HOME}/newclaw-backups"

banner() {
  echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${CYAN}  🪐 NewClaw — Restaurador de Backup${NC}"
  echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
}

# ── 1. Localizar Backups ─────────────────────────────────────
find_backups() {
  if [ ! -d "$BACKUP_ROOT" ]; then
    echo -e "${RED}❌ Pasta de backups não encontrada: $BACKUP_ROOT${NC}"
    exit 1
  fi

  echo -e "\n${BOLD}Buscando backups disponíveis em ${BACKUP_ROOT}...${NC}\n"
  
  # Listar pastas de backup (do desinstalador) e arquivos .db (do backup_db.sh)
  # Usamos um array para guardar os caminhos
  mapfile -t BACKUPS < <(find "$BACKUP_ROOT" -maxdepth 1 \( -type d -name "newclaw_*" -o -type f -name "newclaw_*.db" \) | sort -r)

  if [ ${#BACKUPS[@]} -eq 0 ]; then
    echo -e "${YELLOW}⚠️  Nenhum backup encontrado.${NC}"
    exit 1
  fi

  for i in "${!BACKUPS[@]}"; do
    local item="${BACKUPS[$i]}"
    local name=$(basename "$item")
    local info=""
    if [ -d "$item" ]; then
      info="[Pasta - Completo]"
    else
      info="[Arquivo - Apenas DB]"
    fi
    echo -e "  ${BOLD}[$((i+1))]${NC} $name $info"
  done

  echo ""
  echo -ne "  ${BOLD}Escolha o número do backup para restaurar (ou 'q' para sair):${NC} "
  read -r choice

  if [[ "$choice" == "q" ]]; then
    exit 0
  fi

  if ! [[ "$choice" =~ ^[0-9]+$ ]] || [ "$choice" -lt 1 ] || [ "$choice" -gt ${#BACKUPS[@]} ]; then
    echo -e "${RED}❌ Opção inválida.${NC}"
    exit 1
  fi

  SELECTED_BACKUP="${BACKUPS[$((choice-1))]}"
}

# ── 2. Preparar Restauração ──────────────────────────────────
prepare_restore() {
  echo -e "\n${YELLOW}⚠️  A restauração irá sobrescrever os dados atuais em ${NEWCLAW_DIR}.${NC}"
  echo -ne "  ${BOLD}Tem certeza que deseja continuar? [s/N]:${NC} "
  read -r confirm
  if [[ ! "$confirm" =~ ^[sSyY]$ ]]; then
    echo "Cancelado."
    exit 0
  fi

  # Parar NewClaw
  if [ -f "$NEWCLAW_DIR/bin/newclaw" ]; then
    echo -e "\n🛑 Parando NewClaw..."
    node "$NEWCLAW_DIR/bin/newclaw" stop || true
  fi
  
  # Matar processos residuais
  pkill -f "node.*dist/index.js" || true
  
  # Limpar arquivos WAL para evitar corrupção
  echo "🧹 Limpando arquivos temporários do banco..."
  rm -f "$NEWCLAW_DIR/data/newclaw.db-wal" "$NEWCLAW_DIR/data/newclaw.db-shm"
}

# ── 3. Executar Restauração ──────────────────────────────────
do_restore() {
  echo -e "🚚 Restaurando: $(basename "$SELECTED_BACKUP")..."

  if [ -d "$SELECTED_BACKUP" ]; then
    # Backup completo (Pasta)
    
    # Restaurar DB
    if [ -f "$SELECTED_BACKUP/data/newclaw.db" ]; then
      mkdir -p "$NEWCLAW_DIR/data"
      cp "$SELECTED_BACKUP/data/newclaw.db" "$NEWCLAW_DIR/data/newclaw.db"
      echo "  ✅ Banco de dados restaurado."
    fi
    
    # Restaurar Workspace
    if [ -d "$SELECTED_BACKUP/workspace" ]; then
      rm -rf "$NEWCLAW_DIR/workspace"
      cp -r "$SELECTED_BACKUP/workspace" "$NEWCLAW_DIR/workspace"
      echo "  ✅ Workspace restaurado."
    fi
    
    # Restaurar Skills
    if [ -d "$SELECTED_BACKUP/skills" ]; then
      rm -rf "$NEWCLAW_DIR/skills"
      cp -r "$SELECTED_BACKUP/skills" "$NEWCLAW_DIR/skills"
      echo "  ✅ Skills restauradas."
    fi
    
    # Restaurar .env
    if [ -f "$SELECTED_BACKUP/.env" ]; then
      cp "$SELECTED_BACKUP/.env" "$NEWCLAW_DIR/.env"
      echo "  ✅ Configurações (.env) restauradas."
    fi

  else
    # Backup simples (apenas arquivo .db)
    mkdir -p "$NEWCLAW_DIR/data"
    cp "$SELECTED_BACKUP" "$NEWCLAW_DIR/data/newclaw.db"
    echo "  ✅ Banco de dados restaurado."
  fi

  # Corrigir permissões (opcional, mas bom para VPS)
  chmod 664 "$NEWCLAW_DIR/data/newclaw.db" || true
}

finish() {
  echo -e "\n${GREEN}${BOLD}✨ Restauração concluída com sucesso!${NC}"
  echo -e "\n🚀 Iniciando NewClaw..."
  node "$NEWCLAW_DIR/bin/newclaw" start --daemon
  echo -e "✅ Sistema online. Verifique o dashboard."
  echo ""
}

# ── Execução ─────────────────────────────────────────────────
banner
find_backups
prepare_restore
do_restore
finish
