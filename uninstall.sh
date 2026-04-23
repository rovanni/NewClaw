#!/usr/bin/env bash
# ============================================================
#  NewClaw — Desinstalador Interativo (Linux/macOS)
#
#  Uso:
#    ./uninstall.sh
#    ./uninstall.sh --help
#    ./uninstall.sh --no-prompt          # Remove tudo sem perguntar
#    ./uninstall.sh --backup-only        # Apenas cria backup sem desinstalar
#    ./uninstall.sh --keep-data          # Remove código mas mantém dados
#
# ============================================================

set -e

# ── Cores ────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

# ── Variáveis ────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NEWCLAW_DIR="${NEWCLAW_HOME:-$SCRIPT_DIR}"
BACKUP_DIR="${HOME}/newclaw-backups"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")

# Flags
NO_PROMPT=0
BACKUP_ONLY=0
KEEP_DATA=0
VERBOSE=0

# ── Funções de output ────────────────────────────────────────

banner() {
  echo ""
  echo -e "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${RED}  🪐 NewClaw — Desinstalador${NC}"
  echo -e "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo ""
}

step() {
  echo ""
  echo -e "${BOLD}${CYAN}━━━ $1 ━━━${NC}"
  echo ""
}

info() {
  echo -e "  ${CYAN}ℹ${NC}  $1"
}

ok() {
  echo -e "  ${GREEN}✅${NC}  $1"
}

warn() {
  echo -e "  ${YELLOW}⚠️${NC}  $1"
}

fail() {
  echo -e "  ${RED}❌${NC}  $1"
}

debug() {
  [ "$VERBOSE" -eq 1 ] && echo -e "  ${DIM}[debug] $1${NC}" || true
}

ask_yes() {
  local prompt="$1"
  local default="${2:-n}"

  if [ "$NO_PROMPT" -eq 1 ]; then
    case "$default" in
      y|Y|s|S) return 0 ;;
      *) return 1 ;;
    esac
  fi

  local default_show="y/N"
  [ "$default" = "y" ] && default_show="Y/n"
  echo -ne "  ${BOLD}${prompt} [${default_show}]:${NC} "
  read -r answer < /dev/tty
  answer="${answer:-$default}"
  case "$answer" in
    y|Y|s|S) return 0 ;;
    *) return 1 ;;
  esac
}

# ── Ajuda ────────────────────────────────────────────────────

show_help() {
  cat << 'EOF'
🪐 NewClaw — Desinstalador Interativo

USO:
  ./uninstall.sh [OPÇÕES]

OPÇÕES:
  --no-prompt         Modo não-interativo (remove tudo, faz backup automático)
  --backup-only       Apenas cria backup sem desinstalar
  --keep-data         Remove código mas mantém banco de dados e workspace
  --backup-dir PATH   Diretório para backups (padrão: ~/newclaw-backups)
  --verbose           Mostrar saída detalhada
  -h, --help          Mostrar esta ajuda

O QUE SERÁ REMOVIDO:
  • Código fonte e build (src/, dist/, node_modules/)
  • Configuração (.env)
  • Serviço systemd (se existir)
  • Logs (logs/)

DADOS QUE PODEM SER PRESERVADOS (com backup):
  • Banco de dados semântico (data/newclaw.db)
  • Workspace e arquivos de trabalho (workspace/)
  • Skills aprendidas (skills/)
  • Snapshots de memória

EXEMPLOS:
  ./uninstall.sh                       # Interativo (recomendado)
  ./uninstall.sh --backup-only         # Só backup
  ./uninstall.sh --keep-data           # Remove código, mantém dados
  ./uninstall.sh --no-prompt           # Remove tudo com backup automático
EOF
  exit 0
}

# ── Parse de argumentos ──────────────────────────────────────

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --no-prompt)    NO_PROMPT=1; shift ;;
      --backup-only)  BACKUP_ONLY=1; shift ;;
      --keep-data)    KEEP_DATA=1; shift ;;
      --backup-dir)   BACKUP_DIR="$2"; shift 2 ;;
      --verbose|-v)   VERBOSE=1; shift ;;
      --help|-h)      show_help ;;
      *) warn "Opção desconhecida: $1"; shift ;;
    esac
  done
}

# ── Inventário ───────────────────────────────────────────────

show_inventory() {
  step "1/4 — Analisando instalação"

  if [ ! -d "$NEWCLAW_DIR" ]; then
    fail "Pasta do NewClaw não encontrada: $NEWCLAW_DIR"
    exit 1
  fi

  info "Pasta: ${NEWCLAW_DIR}"

  # Banco de dados
  local db_file="$NEWCLAW_DIR/data/newclaw.db"
  if [ -f "$db_file" ]; then
    local db_size
    db_size=$(du -h "$db_file" 2>/dev/null | cut -f1)
    info "Banco de dados: ${db_file} (${db_size})"

    # Contar nós de memória
    if command -v sqlite3 &>/dev/null; then
      local node_count
      node_count=$(sqlite3 "$db_file" "SELECT COUNT(*) FROM memory_nodes;" 2>/dev/null || echo "?")
      local edge_count
      edge_count=$(sqlite3 "$db_file" "SELECT COUNT(*) FROM memory_edges;" 2>/dev/null || echo "?")
      info "  → ${node_count} nós de memória, ${edge_count} relações"
    fi
  else
    info "Banco de dados: não encontrado"
  fi

  # Workspace
  if [ -d "$NEWCLAW_DIR/workspace" ]; then
    local ws_size
    ws_size=$(du -sh "$NEWCLAW_DIR/workspace" 2>/dev/null | cut -f1)
    local ws_files
    ws_files=$(find "$NEWCLAW_DIR/workspace" -type f 2>/dev/null | wc -l)
    info "Workspace: ${ws_files} arquivos (${ws_size})"
  else
    info "Workspace: vazio"
  fi

  # Skills
  if [ -d "$NEWCLAW_DIR/skills" ]; then
    local skill_count
    skill_count=$(find "$NEWCLAW_DIR/skills" -type f -name "*.md" -o -name "*.json" 2>/dev/null | wc -l)
    info "Skills: ${skill_count} habilidades aprendidas"
  else
    info "Skills: nenhuma"
  fi

  # Logs
  if [ -d "$NEWCLAW_DIR/logs" ]; then
    local log_size
    log_size=$(du -sh "$NEWCLAW_DIR/logs" 2>/dev/null | cut -f1)
    info "Logs: ${log_size}"
  fi

  # Snapshots
  if [ -d "$NEWCLAW_DIR/data/snapshots" ]; then
    local snap_count
    snap_count=$(ls -1 "$NEWCLAW_DIR/data/snapshots" 2>/dev/null | wc -l)
    info "Snapshots: ${snap_count} versões salvas"
  fi

  # .env
  if [ -f "$NEWCLAW_DIR/.env" ]; then
    info "Configuração: .env presente"
  fi

  # Serviço systemd
  if [ -f /etc/systemd/system/newclaw.service ]; then
    info "Serviço systemd: instalado"
  fi

  echo ""
  echo -e "  ${YELLOW}${BOLD}⚠️  ATENÇÃO: A desinstalação é irreversível sem backup!${NC}"
  echo ""
}

# ── Backup ───────────────────────────────────────────────────

do_backup() {
  step "2/4 — Backup dos dados"

  local do_backup_db=0
  local do_backup_ws=0
  local do_backup_skills=0
  local do_backup_env=0
  local do_backup_snapshots=0

  local db_file="$NEWCLAW_DIR/data/newclaw.db"
  local has_data=0

  [ -f "$db_file" ] && has_data=1
  [ -d "$NEWCLAW_DIR/workspace" ] && has_data=1
  [ -d "$NEWCLAW_DIR/skills" ] && has_data=1

  if [ "$has_data" -eq 0 ]; then
    info "Nenhum dado para backup."
    return
  fi

  if [ "$NO_PROMPT" -eq 1 ]; then
    # Em modo automático, faz backup de tudo
    do_backup_db=1
    do_backup_ws=1
    do_backup_skills=1
    do_backup_env=1
    do_backup_snapshots=1
    info "Modo automático: fazendo backup completo"
  else
    echo -e "  ${BOLD}Escolha o que salvar antes de desinstalar:${NC}"
    echo ""

    if [ -f "$db_file" ]; then
      if ask_yes "💾 Banco de dados (memória semântica, grafo, conversas)?" "y"; then
        do_backup_db=1
      fi
    fi

    if [ -d "$NEWCLAW_DIR/workspace" ]; then
      if ask_yes "📁 Workspace (arquivos de trabalho, sites, dados)?" "y"; then
        do_backup_ws=1
      fi
    fi

    if [ -d "$NEWCLAW_DIR/skills" ]; then
      if ask_yes "🎓 Skills (habilidades aprendidas pelo agente)?" "y"; then
        do_backup_skills=1
      fi
    fi

    if [ -f "$NEWCLAW_DIR/.env" ]; then
      if ask_yes "🔑 Configuração (.env com tokens e API keys)?" "y"; then
        do_backup_env=1
      fi
    fi

    if [ -d "$NEWCLAW_DIR/data/snapshots" ]; then
      if ask_yes "📸 Snapshots (versões salvas do grafo de memória)?" "y"; then
        do_backup_snapshots=1
      fi
    fi
  fi

  # Verificar se algo foi selecionado
  local total=$((do_backup_db + do_backup_ws + do_backup_skills + do_backup_env + do_backup_snapshots))
  if [ "$total" -eq 0 ]; then
    warn "Nenhum item selecionado para backup."
    if [ "$BACKUP_ONLY" -eq 1 ]; then
      info "Nada a fazer."
      exit 0
    fi
    return
  fi

  # Criar diretório de backup
  local backup_path="${BACKUP_DIR}/newclaw_${TIMESTAMP}"
  mkdir -p "$backup_path"
  info "Salvando em: ${backup_path}"
  echo ""

  # Banco de dados
  if [ "$do_backup_db" -eq 1 ] && [ -f "$db_file" ]; then
    mkdir -p "$backup_path/data"
    if command -v sqlite3 &>/dev/null; then
      info "Exportando banco de dados (backup atômico via sqlite3)..."
      sqlite3 "$db_file" ".backup '$backup_path/data/newclaw.db'"
    else
      info "Copiando banco de dados..."
      cp "$db_file" "$backup_path/data/newclaw.db"
    fi
    # Copiar dump SQL se existir
    [ -f "$NEWCLAW_DIR/data/newclaw_dump.sql" ] && cp "$NEWCLAW_DIR/data/newclaw_dump.sql" "$backup_path/data/"
    local db_bak_size
    db_bak_size=$(du -h "$backup_path/data/newclaw.db" 2>/dev/null | cut -f1)
    ok "Banco de dados salvo (${db_bak_size})"
  fi

  # Workspace
  if [ "$do_backup_ws" -eq 1 ] && [ -d "$NEWCLAW_DIR/workspace" ]; then
    info "Copiando workspace..."
    cp -r "$NEWCLAW_DIR/workspace" "$backup_path/workspace"
    ok "Workspace salvo"
  fi

  # Skills
  if [ "$do_backup_skills" -eq 1 ] && [ -d "$NEWCLAW_DIR/skills" ]; then
    info "Copiando skills..."
    cp -r "$NEWCLAW_DIR/skills" "$backup_path/skills"
    ok "Skills salvas"
  fi

  # .env
  if [ "$do_backup_env" -eq 1 ] && [ -f "$NEWCLAW_DIR/.env" ]; then
    cp "$NEWCLAW_DIR/.env" "$backup_path/.env"
    ok "Configuração salva"
  fi

  # Snapshots
  if [ "$do_backup_snapshots" -eq 1 ] && [ -d "$NEWCLAW_DIR/data/snapshots" ]; then
    info "Copiando snapshots..."
    mkdir -p "$backup_path/data/snapshots"
    cp -r "$NEWCLAW_DIR/data/snapshots/"* "$backup_path/data/snapshots/" 2>/dev/null
    ok "Snapshots salvos"
  fi

  # Resumo do backup
  local backup_total_size
  backup_total_size=$(du -sh "$backup_path" 2>/dev/null | cut -f1)
  echo ""
  ok "Backup completo: ${backup_path} (${backup_total_size})"

  # Se era apenas backup, sair aqui
  if [ "$BACKUP_ONLY" -eq 1 ]; then
    echo ""
    echo -e "  ${GREEN}${BOLD}Backup criado com sucesso!${NC}"
    echo -e "  ${CYAN}Local: ${backup_path}${NC}"
    echo ""
    echo -e "  ${BOLD}Para restaurar depois:${NC}"
    echo -e "    ${CYAN}cp ${backup_path}/data/newclaw.db ~/NewClaw/data/${NC}"
    echo -e "    ${CYAN}cp -r ${backup_path}/workspace ~/NewClaw/workspace${NC}"
    echo -e "    ${CYAN}cp -r ${backup_path}/skills ~/NewClaw/skills${NC}"
    echo -e "    ${CYAN}cp ${backup_path}/.env ~/NewClaw/.env${NC}"
    echo ""
    exit 0
  fi
}

# ── Parar serviços ───────────────────────────────────────────

stop_services() {
  step "3/4 — Parando serviços"

  # Parar via CLI do NewClaw
  if [ -f "$NEWCLAW_DIR/bin/newclaw" ]; then
    info "Parando NewClaw via CLI..."
    node "$NEWCLAW_DIR/bin/newclaw" stop 2>/dev/null || true
    ok "Agente parado"
  fi

  # Parar via PID file
  if [ -f "$NEWCLAW_DIR/newclaw.pid" ]; then
    local pid
    pid=$(cat "$NEWCLAW_DIR/newclaw.pid")
    kill "$pid" 2>/dev/null || true
    rm -f "$NEWCLAW_DIR/newclaw.pid"
    ok "Processo $pid encerrado"
  fi

  # Fallback: matar por nome
  if pgrep -f "node.*dist/index.js" &>/dev/null; then
    pkill -f "node.*dist/index.js" 2>/dev/null || true
    ok "Processos restantes encerrados"
  fi

  # Remover serviço systemd
  if [ -f /etc/systemd/system/newclaw.service ]; then
    info "Removendo serviço systemd..."
    sudo systemctl stop newclaw 2>/dev/null || true
    sudo systemctl disable newclaw 2>/dev/null || true
    sudo rm -f /etc/systemd/system/newclaw.service
    sudo systemctl daemon-reload 2>/dev/null || true
    ok "Serviço systemd removido"
  fi
}

# ── Remover arquivos ─────────────────────────────────────────

remove_files() {
  step "4/4 — Removendo arquivos"

  if [ "$KEEP_DATA" -eq 1 ]; then
    info "Modo --keep-data: mantendo banco de dados, workspace e skills"

    # Remover apenas código e build
    local dirs_to_remove=("src" "dist" "node_modules" "bin" "docs" "specs" "scratch" "logs" ".git")
    local files_to_remove=("package.json" "package-lock.json" "tsconfig.json" ".gitignore" "LICENSE"
                           "install.sh" "install.ps1" "uninstall.sh" "uninstall.ps1"
                           "start.sh" "update.sh" "migrate_vps.sh"
                           "debug_loop.js" "fetch.js" ".env" "README.md")

    for d in "${dirs_to_remove[@]}"; do
      if [ -d "$NEWCLAW_DIR/$d" ]; then
        rm -rf "$NEWCLAW_DIR/$d"
        debug "Removido: $d/"
      fi
    done

    for f in "${files_to_remove[@]}"; do
      if [ -f "$NEWCLAW_DIR/$f" ]; then
        rm -f "$NEWCLAW_DIR/$f"
        debug "Removido: $f"
      fi
    done

    ok "Código removido (dados preservados em ${NEWCLAW_DIR})"

  else
    # Confirmação final antes de apagar tudo
    if [ "$NO_PROMPT" -eq 0 ]; then
      echo -e "  ${RED}${BOLD}⚠️  ÚLTIMA CHANCE: Isso vai remover TODO o diretório:${NC}"
      echo -e "  ${RED}  ${NEWCLAW_DIR}${NC}"
      echo ""
      if ! ask_yes "Tem certeza que deseja continuar?" "n"; then
        info "Desinstalação cancelada."
        exit 0
      fi
    fi

    rm -rf "$NEWCLAW_DIR"
    ok "Diretório ${NEWCLAW_DIR} removido completamente"
  fi

  # Remover regra de firewall (ufw)
  if command -v ufw &>/dev/null; then
    local port
    port=$(grep -oP 'DASHBOARD_PORT=\K\d+' "$NEWCLAW_DIR/.env" 2>/dev/null || echo "3090")
    if sudo ufw status 2>/dev/null | grep -q "$port"; then
      sudo ufw delete allow "${port}/tcp" 2>/dev/null || true
      ok "Regra de firewall removida (porta ${port})"
    fi
  fi
}

# ── Resumo final ─────────────────────────────────────────────

show_summary() {
  echo ""
  echo -e "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${BOLD}${GREEN}  🪐 NewClaw desinstalado com sucesso${NC}"
  echo -e "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo ""

  if [ -d "${BACKUP_DIR}/newclaw_${TIMESTAMP}" ]; then
    echo -e "  ${CYAN}Backup salvo em:${NC} ${BACKUP_DIR}/newclaw_${TIMESTAMP}"
    echo ""
    echo -e "  ${BOLD}Para reinstalar e restaurar:${NC}"
    echo -e "    ${CYAN}curl -fsSL .../install.sh | bash${NC}"
    echo -e "    ${CYAN}cp -r ${BACKUP_DIR}/newclaw_${TIMESTAMP}/data ~/NewClaw/data${NC}"
    echo -e "    ${CYAN}cp -r ${BACKUP_DIR}/newclaw_${TIMESTAMP}/workspace ~/NewClaw/workspace${NC}"
    echo -e "    ${CYAN}cp -r ${BACKUP_DIR}/newclaw_${TIMESTAMP}/skills ~/NewClaw/skills${NC}"
    echo -e "    ${CYAN}cp ${BACKUP_DIR}/newclaw_${TIMESTAMP}/.env ~/NewClaw/.env${NC}"
  fi

  if [ "$KEEP_DATA" -eq 1 ]; then
    echo -e "  ${YELLOW}Dados preservados em:${NC} ${NEWCLAW_DIR}"
  fi

  echo ""
  echo -e "  ${DIM}Obrigado por usar o NewClaw! 🪐${NC}"
  echo ""
}

# ── Main ─────────────────────────────────────────────────────

main() {
  parse_args "$@"
  banner

  show_inventory

  # Confirmação inicial
  if [ "$BACKUP_ONLY" -eq 0 ] && [ "$NO_PROMPT" -eq 0 ]; then
    if ! ask_yes "Deseja continuar com a desinstalação?" "n"; then
      info "Cancelado."
      exit 0
    fi
  fi

  do_backup
  if [ "$BACKUP_ONLY" -eq 1 ]; then exit 0; fi
  stop_services
  remove_files
  show_summary
}

main "$@"
