#!/usr/bin/env bash
# ============================================================
#  NewClaw — Script de Restauração Inteligente
#
#  Fontes de backup suportadas:
#    1. <projeto>/data/backups/  ← backups gerados pelo Dashboard
#    2. ~/newclaw-backups        ← backups gerados pelo instalador
#    3. /home/venus/backups      ← caminho legado da VPS
# ============================================================

set -e

# ── Cores ────────────────────────────────────────────────────
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
GRAY='\033[0;90m'
BOLD='\033[1m'
NC='\033[0m'

# ── Configurações ────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NEWCLAW_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DASHBOARD_BACKUPS="$NEWCLAW_DIR/data/backups"
BACKUP_ROOT="${HOME}/newclaw-backups"
ALT_BACKUP_ROOT="/home/venus/backups"

banner() {
  echo ""
  echo -e "${CYAN}  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${CYAN}    🪐 NewClaw — Restaurador de Backup${NC}"
  echo -e "${CYAN}  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo ""
}

# Retorna 0 se o arquivo .db for um SQLite íntegro, 1 caso contrário
validate_sqlite() {
  local file="$1"
  local result
  result=$(cd "$NEWCLAW_DIR" && node -e \
    "try{var db=require('better-sqlite3')('$file',{readonly:true});var r=db.prepare('PRAGMA integrity_check').get();db.close();process.stdout.write(r&&r.integrity_check||'error');}catch(e){process.stdout.write('error');}" \
    2>/dev/null)
  [ "$result" = "ok" ]
}

# ── 1. Localizar Backups ─────────────────────────────────────
find_backups() {
  echo -e "  ${BOLD}Buscando backups disponíveis...${NC}\n"

  # Arrays paralelos: caminhos e rótulos
  BACKUP_PATHS=()
  BACKUP_LABELS=()
  BACKUP_VALID=()

  # ── Fonte 1: data/backups/ (Dashboard) ──────────────────
  if [ -d "$DASHBOARD_BACKUPS" ]; then
    while IFS= read -r -d $'\0' f; do
      name=$(basename "$f")
      if [[ "$name" == database-pre-restore-* ]]; then
        label="[Safety backup — antes de restore]"
      else
        label="[Backup do Dashboard]"
      fi
      BACKUP_PATHS+=("$f")
      BACKUP_LABELS+=("$label")
      BACKUP_VALID+=("")   # preenchido na exibição
    done < <(find "$DASHBOARD_BACKUPS" -maxdepth 1 -name "database-*.db" -print0 2>/dev/null | sort -rz)
  fi

  # ── Fonte 2 e 3: instalador / VPS ───────────────────────
  EXTRA_PATHS=("$BACKUP_ROOT")
  [ -d "$ALT_BACKUP_ROOT" ] && EXTRA_PATHS+=("$ALT_BACKUP_ROOT")

  for search in "${EXTRA_PATHS[@]}"; do
    [ -d "$search" ] || continue
    while IFS= read -r -d $'\0' item; do
      name=$(basename "$item")
      if [ -d "$item" ]; then
        label="[Backup completo — Instalador]"
      else
        label="[Banco de dados — Instalador]"
      fi
      BACKUP_PATHS+=("$item")
      BACKUP_LABELS+=("$label")
      BACKUP_VALID+=("")
    done < <(find "$search" -maxdepth 1 \( -type d -name "newclaw_*" -o -type f -name "newclaw_*.db" \) -print0 2>/dev/null | sort -rz)
  done

  if [ ${#BACKUP_PATHS[@]} -eq 0 ]; then
    echo -e "  ${YELLOW}⚠️  Nenhum backup encontrado em:${NC}"
    echo -e "  ${GRAY}  • $DASHBOARD_BACKUPS${NC}"
    for p in "${EXTRA_PATHS[@]}"; do echo -e "  ${GRAY}  • $p${NC}"; done
    echo ""
    echo -e "  ${CYAN}Dica: crie um backup pelo Dashboard (Configurações → Backup → Backup Manual)${NC}"
    echo ""
    exit 1
  fi

  # Exibe lista com validação para arquivos .db
  printf "  %-4s %-3s %-45s %-32s\n" "#" "" "Arquivo / Pasta" "Origem"
  echo  "  ─────────────────────────────────────────────────────────────────────────────────"

  for i in "${!BACKUP_PATHS[@]}"; do
    local path="${BACKUP_PATHS[$i]}"
    local label="${BACKUP_LABELS[$i]}"
    local name
    name=$(basename "$path")
    local icon="  "

    if [ -f "$path" ] && [[ "$path" == *.db ]]; then
      if validate_sqlite "$path"; then
        icon="✅"
        BACKUP_VALID[$i]="ok"
      else
        icon="❌"
        BACKUP_VALID[$i]="corrupt"
      fi
    else
      icon="📁"
      BACKUP_VALID[$i]="ok"
    fi

    printf "  %-4s %s %-45s %s\n" "[$((i+1))]" "$icon" "$name" "$label"
    [ "${BACKUP_VALID[$i]}" = "corrupt" ] && echo -e "       ${RED}└─ corrompido — não pode ser restaurado${NC}"
  done

  echo ""
  echo -ne "  ${BOLD}Escolha o número (ou 'q' para sair):${NC} "
  read -r choice

  [[ "$choice" == "q" ]] && exit 0

  if ! [[ "$choice" =~ ^[0-9]+$ ]] || [ "$choice" -lt 1 ] || [ "$choice" -gt ${#BACKUP_PATHS[@]} ]; then
    echo -e "\n  ${RED}❌ Opção inválida.${NC}"
    exit 1
  fi

  local idx=$((choice - 1))

  if [ "${BACKUP_VALID[$idx]}" = "corrupt" ]; then
    echo -e "\n  ${RED}❌ O backup selecionado está corrompido. Escolha outro.${NC}"
    exit 1
  fi

  SELECTED_BACKUP="${BACKUP_PATHS[$idx]}"
}

# ── 2. Preparar Restauração ──────────────────────────────────
prepare_restore() {
  echo ""
  echo -e "  ${YELLOW}⚠️  A restauração irá sobrescrever os dados atuais em:${NC}"
  echo -e "  ${GRAY}   $NEWCLAW_DIR${NC}"
  echo -ne "\n  ${BOLD}Tem certeza que deseja continuar? [s/N]:${NC} "
  read -r confirm
  if [[ ! "$confirm" =~ ^[sSyY]$ ]]; then
    echo "  Cancelado."
    exit 0
  fi

  # Para o processo — funciona mesmo em crash loop (pm2 daemon continua)
  echo ""
  echo -e "  🛑 ${YELLOW}Parando NewClaw...${NC}"
  pm2 stop newclaw 2>/dev/null || node "$NEWCLAW_DIR/bin/newclaw" stop 2>/dev/null || true

  # Mata processos node residuais que possam segurar o .db
  pkill -f "node.*dist/index.js" 2>/dev/null || true
  sleep 0.3

  # Remove WAL/SHM
  echo -e "  🧹 ${GRAY}Limpando arquivos temporários do banco...${NC}"
  rm -f "$NEWCLAW_DIR/data/newclaw.db-wal" "$NEWCLAW_DIR/data/newclaw.db-shm"
}

# ── 3. Executar Restauração ──────────────────────────────────
do_restore() {
  echo ""
  echo -e "  🚚 ${CYAN}Restaurando: $(basename "$SELECTED_BACKUP")...${NC}"
  mkdir -p "$NEWCLAW_DIR/data"

  if [ -d "$SELECTED_BACKUP" ]; then
    # Backup completo (pasta do instalador)
    for pair in "data/newclaw.db:data/newclaw.db" "workspace:workspace" "skills:skills" ".env:.env"; do
      src="$SELECTED_BACKUP/${pair%%:*}"
      dst="$NEWCLAW_DIR/${pair##*:}"
      [ -e "$src" ] || continue
      if [ -d "$src" ]; then
        rm -rf "$dst"
        cp -r "$src" "$dst"
      else
        cp "$src" "$dst"
      fi
      echo -e "    ✅ ${pair%%:*} restaurado."
    done
  else
    # Arquivo .db simples (Dashboard ou instalador)
    cp "$SELECTED_BACKUP" "$NEWCLAW_DIR/data/newclaw.db"
    chmod 664 "$NEWCLAW_DIR/data/newclaw.db" 2>/dev/null || true
    echo -e "    ✅ Banco de dados restaurado."
  fi
}

finish() {
  echo ""
  echo -e "  ${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "  ${GREEN}  ✨ Restauração concluída com sucesso!${NC}"
  echo -e "  ${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo ""
  echo -e "  🚀 ${CYAN}Iniciando NewClaw...${NC}"
  pm2 start "$NEWCLAW_DIR/ecosystem.config.cjs" 2>/dev/null || \
    pm2 restart newclaw 2>/dev/null || \
    node "$NEWCLAW_DIR/bin/newclaw" start --daemon
  echo -e "  ✅ ${GREEN}Sistema online. Verifique o dashboard.${NC}"
  echo ""
}

# ── Execução ─────────────────────────────────────────────────
banner
find_backups
prepare_restore
do_restore
finish
