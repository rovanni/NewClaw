#!/usr/bin/env bash
# ============================================================
#  NewClaw — Instalador Interativo
#
#  Uso:
#    curl -fsSL https://raw.githubusercontent.com/rovanni/NewClaw/main/install.sh | bash
#    ./install.sh
#    ./install.sh --help
#    ./install.sh --dry-run
#    ./install.sh --no-prompt --token TOKEN --user-id 123
#
#  Inspirado no instalador do OpenClaw (openclaw.ai/install.sh)
# ============================================================

set -e

# ── Tratamento global de erros ───────────────────────────────
trap 'fail "Instalação falhou na linha $LINENO. Rode com --verbose para mais detalhes."; exit 1' ERR

# ── Versão ───────────────────────────────────────────────────
INSTALLER_VERSION="1.0.0"

# ── Cores ────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

# ── Variáveis padrão ─────────────────────────────────────────
NEWCLAW_DIR="${NEWCLAW_HOME:-$HOME/newclaw}"
ENV_FILE=""
BOT_TOKEN="${NEWCLAW_TOKEN:-}"
USER_ID="${NEWCLAW_USER_ID:-}"
OLLAMA_MODEL="${NEWCLAW_MODEL:-glm-5:cloud}"
DASHBOARD_PORT="${NEWCLAW_DASHBOARD_PORT:-3090}"
INSTALL_DIR=""

# Flags
DRY_RUN=0
NO_PROMPT=0
NO_ONBOARD=0
VERBOSE=0
SKIP_UPDATE=0
SKIP_SYSTEMD=0
SKIP_FIREWALL=0

# ── Funções de output ────────────────────────────────────────

banner() {
  echo ""
  echo -e "${CYAN}🪐 NewClaw — Agente Cognitivo Local${NC}"
  echo -e "${CYAN}   Instalador v${INSTALLER_VERSION}${NC}"
  echo ""
}

step() {
  echo ""
  echo -e "${BOLD}${GREEN}━━━ $1 ━━━${NC}"
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

die() {
  fail "$1"
  exit 1
}

debug() {
  [ "$VERBOSE" -eq 1 ] && echo -e "  ${DIM}[debug] $1${NC}" || true
}

dry() {
  [ "$DRY_RUN" -eq 1 ] && echo -e "  ${YELLOW}[dry-run] $1${NC}"
}

# ── Perguntas interativas ────────────────────────────────────

ask() {
  local prompt="$1"
  local var="$2"
  local default="${3:-}"
  local default_show=""
  [ -n "$default" ] && default_show=" [${default}]"

  if [ "$NO_PROMPT" -eq 1 ]; then
    eval "$var=\$default"
    debug "NO_PROMPT: ${var}=${default}"
    return
  fi

  echo -ne "  ${BOLD}${prompt}${default_show}:${NC} "
  # Tenta ler do TTY, se falhar usa stdin, se falhar usa default
  if ! read -r answer < /dev/tty 2>/dev/null; then
    read -r answer 2>/dev/null || answer="$default"
  fi
  [ -z "$answer" ] && answer="$default"
  eval "$var=\$answer"
}

ask_yes() {
  local prompt="$1"
  local default="${2:-n}"

  if [ "$NO_PROMPT" -eq 1 ]; then
    debug "NO_PROMPT: auto ${default}"
    case "$default" in
      y|Y|s|S) return 0 ;;
      *) return 1 ;;
    esac
  fi

  local default_show="s/N"
  [[ "$default" == "y" || "$default" == "Y" || "$default" == "s" || "$default" == "S" ]] && default_show="S/n"
  echo -ne "  ${BOLD}${prompt} [${default_show}]:${NC} "
  if ! read -r answer < /dev/tty 2>/dev/null; then
    read -r answer 2>/dev/null || answer="$default"
  fi
  answer="${answer:-$default}"
  case "$answer" in
    y|Y|s|S) return 0 ;;
    *) return 1 ;;
  esac
}

check_cmd() {
  command -v "$1" &>/dev/null
}

# ── Ajuda ────────────────────────────────────────────────────

show_help() {
  cat << 'EOF'
🪐 NewClaw — Instalador Interativo

USO:
  curl -fsSL https://raw.githubusercontent.com/rovanni/NewClaw/main/install.sh | bash
  ./install.sh [OPÇÕES]

OPÇÕES:
  --token TOKEN         Token do bot do Telegram
  --user-id ID          Seu ID de usuário do Telegram
  --model MODEL         Modelo Ollama (padrão: glm-5:cloud)
  --dir PATH            Diretório de instalação (padrão: ~/NewClaw)
  --port PORT           Porta do dashboard (padrão: 3090)

  --no-prompt           Modo não-interativo (usa defaults ou variáveis de ambiente)
  --no-onboard          Pular configuração interativa (Token/ID)
  --no-update           Pular atualização do sistema (apt)
  --no-systemd          Pular criação do serviço systemd
  --no-firewall         Pular configuração do firewall
  --dry-run             Simular instalação sem executar
  --verbose             Mostrar saída de debug
  -h, --help            Mostrar esta ajuda

VARIÁVEIS DE AMBIENTE:
  NEWCLAW_TOKEN         Token do bot Telegram
  NEWCLAW_USER_ID       ID do usuário Telegram
  NEWCLAW_MODEL         Modelo Ollama (padrão: glm-5:cloud)
  NEWCLAW_HOME          Diretório de instalação (padrão: ~/NewClaw)
  NEWCLAW_DASHBOARD_PORT  Porta do dashboard (padrão: 3090)

EXEMPLOS:
  # Instalação interativa (recomendado)
  curl -fsSL .../install.sh | bash

  # Com token pré-definido
  NEWCLAW_TOKEN=123:ABC NEWCLAW_USER_ID=123456789 ./install.sh --no-prompt

  # Dry run (simular)
  ./install.sh --dry-run --verbose

  # Modelo específico
  ./install.sh --model llama3.1:8b
EOF
  exit 0
}

# ── Parse de argumentos ──────────────────────────────────────

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --token)        BOT_TOKEN="$2"; shift 2 ;;
      --user-id)      USER_ID="$2"; shift 2 ;;
      --model)        OLLAMA_MODEL="$2"; shift 2 ;;
      --dir)          NEWCLAW_DIR="$2"; shift 2 ;;
      --port)         DASHBOARD_PORT="$2"; shift 2 ;;
      --no-prompt)    NO_PROMPT=1; shift ;;
      --no-onboard)   NO_ONBOARD=1; shift ;;
      --no-update)    SKIP_UPDATE=1; shift ;;
      --no-systemd)   SKIP_SYSTEMD=1; shift ;;
      --no-firewall)  SKIP_FIREWALL=1; shift ;;
      --dry-run)      DRY_RUN=1; shift ;;
      --verbose|-v)   VERBOSE=1; shift ;;
      --help|-h)      show_help ;;
      *) warn "Opção desconhecida: $1"; shift ;;
    esac
  done
}

# ── Dry run wrapper ──────────────────────────────────────────

run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    dry "exec: $*"
  else
    debug "exec: $*"
    "$@"
  fi
}

# ── 1. Verificar sistema ─────────────────────────────────────

check_system() {
  step "1/9 — Verificando o sistema"

  # OS
  if [ ! -f /etc/os-release ]; then
    fail "Sistema operacional não identificado."
    info "Este instalador suporta Ubuntu/Debian Linux."
    if [ "$NO_PROMPT" -eq 0 ]; then
      ask_yes "Continuar mesmo assim?" "n" || exit 1
    else
      exit 1
    fi
  fi

  source /etc/os-release 2>/dev/null
  info "Sistema: ${PRETTY_NAME:-Linux}"

  # RAM
  local ram_mb
  ram_mb=$(free -m 2>/dev/null | awk '/Mem:/{print $2}')
  if [ -n "$ram_mb" ]; then
    if [ "$ram_mb" -lt 2048 ]; then
      warn "RAM: ${ram_mb}MB — abaixo de 2GB, pode ficar lento"
    else
      ok "RAM: ${ram_mb}MB"
    fi
  fi

  # Disco
  local disk_gb
  disk_gb=$(df -BG "$HOME" 2>/dev/null | awk 'NR==2{print $4}' | tr -d 'G')
  if [ -n "$disk_gb" ]; then
    if [ "$disk_gb" -lt 5 ]; then
      die "Disco: ${disk_gb}GB livres — precisa de pelo menos 5GB"
    fi
    ok "Disco: ${disk_gb}GB livres"
  fi

  # Internet
  if ping -c 1 -W 3 google.com &>/dev/null; then
    ok "Internet: conectada"
  else
    warn "Internet: sem conexão — algumas etapas podem falhar"
  fi
}

# ── 2. Atualizar sistema ─────────────────────────────────────

update_system() {
  step "2/9 — Atualizando o sistema"

  if [ "$SKIP_UPDATE" -eq 1 ]; then
    info "Pulando (flag --no-update)"
    return
  fi

  if ask_yes "Atualizar pacotes do sistema? (apt update + upgrade)" "y"; then
    info "Atualizando... isso pode demorar alguns minutos"
    run sudo apt update -y
    run sudo apt upgrade -y
    ok "Sistema atualizado!"
  else
    info "Pulando atualização"
  fi

  info "Instalando dependências básicas (curl, git, build-essential)..."
  run sudo apt install -y curl git build-essential
  ok "Dependências básicas instaladas!"

  # w3m é opcional — não aborta a instalação se falhar
  if run sudo apt install -y w3m 2>/dev/null; then
    ok "w3m instalado (navegação web aprimorada)"
  else
    warn "w3m não instalado — o agente usará fallback HTML (funcional)"
  fi
}

# ── 3. Node.js ───────────────────────────────────────────────

install_node() {
  step "3/9 — Instalando o Node.js"

  if check_cmd node; then
    local node_ver
    node_ver=$(node --version 2>/dev/null)
    ok "Node.js encontrado: ${node_ver}"

    local major
    major=$(echo "$node_ver" | sed 's/v//' | cut -d. -f1)
    if [ "$major" -lt 18 ]; then
      warn "Versão antiga (${node_ver}). Recomendado: v22+"
      if ask_yes "Atualizar para Node.js 22?" "y"; then
        run curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
        run sudo apt install -y nodejs
        ok "Node.js atualizado: $(node --version)"
      fi
    fi
  else
    info "Instalando Node.js 22..."
    run curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    run sudo apt install -y nodejs
    ok "Node.js instalado: $(node --version)"
  fi

  ok "npm: $(npm --version)"
}

# ── 4. Ollama ────────────────────────────────────────────────

install_ollama() {
  step "4/9 — Instalando o Ollama"

  if check_cmd ollama; then
    ok "Ollama encontrado: $(ollama --version 2>/dev/null || echo 'instalado')"
  else
    info "Baixando Ollama..."
    run curl -fsSL https://ollama.com/install.sh | sh
    ok "Ollama instalado!"
  fi

  # Verificar se está rodando (com retry)
  if curl -s http://localhost:11434/api/tags &>/dev/null; then
    ok "Ollama rodando na porta 11434"
  else
    warn "Ollama não está rodando. Iniciando..."
    if [ "$DRY_RUN" -eq 0 ]; then
      ollama serve &>/dev/null &
      local retries=0
      while [ $retries -lt 6 ]; do
        sleep 2
        if curl -s http://localhost:11434/api/tags &>/dev/null; then
          ok "Ollama iniciado!"
          break
        fi
        retries=$((retries + 1))
      done
      if ! curl -s http://localhost:11434/api/tags &>/dev/null; then
        warn "Não foi possível verificar. Rode 'ollama serve' manualmente depois."
      fi
    fi
  fi
}

# ── 5. Modelo ───────────────────────────────────────────────

download_model() {
  step "5/9 — Baixando o modelo de IA"

  if [ "$DRY_RUN" -eq 1 ]; then
    dry "baixar modelo ${OLLAMA_MODEL}"
    return
  fi

  if [ "$NO_PROMPT" -eq 0 ]; then
    echo -e "  ${BOLD}Escolha o modelo:${NC}"
    echo -e "  ${CYAN}1)${NC} glm-5:cloud     — Recomendado (grátis, inferência remota)"
    echo -e "  ${CYAN}2)${NC} llama3.1:8b    — Rápido, uso geral (5GB local)"
    echo -e "  ${CYAN}3)${NC} mistral:7b     — Rápido, conversação (4GB local)"
    echo -e "  ${CYAN}4)${NC} qwen2.5:3b    — Leve, servidores fracos (2GB local)"
    echo -e "  ${CYAN}5)${NC} Outro (digitar nome)"
    echo ""

    local model_choice
    ask "Qual modelo? (1-5)" model_choice "1"

    case "$model_choice" in
      2) OLLAMA_MODEL="llama3.1:8b" ;;
      3) OLLAMA_MODEL="mistral:7b" ;;
      4) OLLAMA_MODEL="qwen2.5:3b" ;;
      5) ask "Nome do modelo" OLLAMA_MODEL "glm-5:cloud" ;;
      *) OLLAMA_MODEL="glm-5:cloud" ;;
    esac
  fi

  info "Baixando modelo ${OLLAMA_MODEL}..."
  info "Pode demorar alguns minutos na primeira vez..."
  run ollama pull "$OLLAMA_MODEL"
  ok "Modelo ${OLLAMA_MODEL} pronto!"
}

# ── 6. NewClaw ───────────────────────────────────────────────

install_newclaw() {
  step "6/9 — Baixando o NewClaw"

  if [ -d "$NEWCLAW_DIR" ]; then
    warn "Pasta ${NEWCLAW_DIR} já existe!"
    if ask_yes "Atualizar com git pull?" "y"; then
      cd "$NEWCLAW_DIR"
      if git pull origin main 2>/dev/null; then
        ok "Código atualizado!"
      else
        warn "Conflito detectado: Você tem mudanças locais que impedem a atualização."
        if ask_yes "Deseja descartar suas mudanças locais e forçar a atualização?" "n"; then
          run git reset --hard HEAD
          run git pull origin main
          ok "Código atualizado (mudanças locais descartadas)!"
        else
          info "Mantendo versão local para preservar suas alterações."
        fi
      fi
    else
      info "Mantendo código existente"
    fi
  else
    info "Clonando repositório..."
    run git clone https://github.com/rovanni/NewClaw.git "$NEWCLAW_DIR"
    ok "Código baixado!"
  fi

  if [ "$DRY_RUN" -eq 1 ]; then
    dry "npm install && npm run build em ${NEWCLAW_DIR}"
    return
  fi

  # Instalar deps e build
  cd "$NEWCLAW_DIR" || fail "Não foi possível entrar na pasta $NEWCLAW_DIR"

  info "Instalando dependências (npm install)..."
  npm install
  ok "Dependências instaladas!"

  info "Compilando código..."
  npm run build
  ok "Código compilado!"

  # Garantir permissão de execução em todos os scripts
  info "Configurando permissões de execução..."
  run chmod +x bin/newclaw
  run chmod +x uninstall.sh
  run chmod +x scripts/*.sh 2>/dev/null || true
  ok "Permissões configuradas!"
}

# ── 7. Configuração ──────────────────────────────────────────

check_for_backups() {
  local backup_count=0
  local backup_path=""

  if [ -d "${HOME}/newclaw-backups" ]; then
    backup_path="${HOME}/newclaw-backups"
    backup_count=$(find "$backup_path" -maxdepth 1 \( -type d -name "newclaw_*" -o -type f -name "newclaw_*.db" \) 2>/dev/null | wc -l)
  fi


  if [ "$backup_count" -gt 0 ]; then
    echo ""
    step "Bônus: Backups encontrados!"
    info "Detectamos ${backup_count} backup(s) em ${backup_path}"

    if ask_yes "Deseja restaurar um backup agora em vez de fazer uma configuração limpa?" "n"; then
      if [ -f "${NEWCLAW_DIR}/scripts/restore.sh" ]; then
        bash "${NEWCLAW_DIR}/scripts/restore.sh"
        # Se restaurou, podemos pular a configuração manual do .env se ele já existir
        if [ -f "${NEWCLAW_DIR}/.env" ]; then
          ok "Backup restaurado com sucesso. Pulando configuração manual."
          NO_ONBOARD=1
        fi
      else
        warn "Script de restauração não encontrado. Por favor, restaure manualmente depois."
      fi
    fi
  fi
}

configure() {
  step "7/9 — Configurando o NewClaw"

  ENV_FILE="${NEWCLAW_DIR}/.env"

  if [ "$DRY_RUN" -eq 1 ]; then
    dry "criar ${ENV_FILE}"
    if [ "$NO_ONBOARD" -eq 1 ]; then
      info "Onboarding pulado (flag --no-onboard)"
    else
      dry "configurar token=${BOT_TOKEN:0:10}... user_id=${USER_ID} model=${OLLAMA_MODEL}"
    fi
    return
  fi

  # Criar .env
  if [ ! -f "$ENV_FILE" ]; then
    [ -f "${NEWCLAW_DIR}/.env.example" ] && cp "${NEWCLAW_DIR}/.env.example" "$ENV_FILE"
    [ ! -f "$ENV_FILE" ] && touch "$ENV_FILE"
  fi

  if [ "$NO_ONBOARD" -eq 1 ]; then
    info "Onboarding pulado (flag --no-onboard)"
    info "Configure o .env manualmente: ${ENV_FILE}"
    return
  fi

  # ── Funções auxiliares de canal ─────────────────────────────
  _configure_telegram() {
    echo ""
    echo -e "  ${BOLD}${YELLOW}── Telegram ─────────────────────────────────────${NC}"
    echo -e "  ${CYAN}Você vai precisar de 2 códigos:${NC}"
    echo -e "    1. ${BOLD}Bot Token${NC}  → Crie um bot com @BotFather no Telegram"
    echo -e "       Exemplo: 123456789:AAFxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
    echo -e "    2. ${BOLD}Seu User ID${NC} → Envie /start para @userinfobot"
    echo -e "       Exemplo: 987654321"
    echo ""
    while [ -z "$BOT_TOKEN" ]; do
      ask "  Cole o TOKEN do bot (ex: 123456:AAF...)" BOT_TOKEN
      if [ -n "$BOT_TOKEN" ] && [[ "$BOT_TOKEN" != *":"* ]]; then
        warn "Token inválido — deve conter ':'. Tente novamente."
        BOT_TOKEN=""
      fi
    done
    while [ -z "$USER_ID" ]; do
      ask "  Cole o seu USER ID (apenas números)" USER_ID
      if [[ "$USER_ID" == *":"* ]]; then
        warn "Isso parece um Token, não um ID! O ID vem do @userinfobot."
        USER_ID=""
      elif [[ -n "$USER_ID" && ! "$USER_ID" =~ ^[0-9]+$ ]]; then
        warn "O ID deve conter apenas números. Tente novamente."
        USER_ID=""
      fi
    done
    ok "Telegram configurado!"
  }

  _configure_discord() {
    echo ""
    echo -e "  ${BOLD}${YELLOW}── Discord ──────────────────────────────────────${NC}"
    echo -e "  ${CYAN}Acesse: discord.com/developers → Applications → Bot → Token${NC}"
    echo ""
    ask "  Cole o Bot Token do Discord" discord_token
    ask "  IDs dos servidores permitidos (vírgula, vazio = todos)" discord_guilds
    ask "  IDs de usuários permitidos (vírgula, vazio = todos)" discord_users
    [ -n "$discord_token" ] && ok "Discord configurado!"
  }

  _configure_whatsapp() {
    echo ""
    echo -e "  ${BOLD}${YELLOW}── WhatsApp ─────────────────────────────────────${NC}"
    echo -e "  ${CYAN}Usa a biblioteca Baileys — na 1ª execução aparecerá um QR code${NC}"
    echo -e "  ${CYAN}para escanear com o WhatsApp do celular.${NC}"
    echo ""
    ask "  Número com código do país, sem + (ex: 5511999999999)" wa_phone
    ask "  JIDs autorizados (vírgula, vazio = todos os contatos)" wa_jids
    [ -n "$wa_phone" ] && ok "WhatsApp configurado! Escaneie o QR na 1ª execução."
  }

  _configure_signal() {
    echo ""
    echo -e "  ${BOLD}${YELLOW}── Signal ───────────────────────────────────────${NC}"
    echo -e "  ${CYAN}Requer signal-cli: github.com/AsamK/signal-cli${NC}"
    if ! command -v signal-cli &>/dev/null; then
      warn "signal-cli não encontrado no PATH agora."
      info "  Ubuntu/Debian: sudo apt install signal-cli"
      info "  macOS: brew install signal-cli"
      info "  GitHub: https://github.com/AsamK/signal-cli/releases"
      info "  Você pode instalar depois e configurar via 'newclaw channels enable signal'"
    fi
    echo ""
    ask "  Número com código do país (ex: +5511999999999)" signal_phone
    ask "  Números autorizados (vírgula, vazio = todos)" signal_numbers
    [ -n "$signal_phone" ] && ok "Signal configurado!"
  }

  # ── Variáveis de canal ───────────────────────────────────────
  local discord_token="" discord_guilds="" discord_users=""
  local wa_phone="" wa_jids=""
  local signal_phone="" signal_numbers=""

  # ── Modo não-interativo: usa vars de ambiente / flags passadas ───────────
  if [ "$NO_PROMPT" -eq 1 ]; then
    [ -n "$BOT_TOKEN" ] && _configure_telegram
  else
    # ── Menu de escolha de canal ──────────────────────────────────────────
    echo ""
    echo -e "  ${BOLD}${CYAN}╔══════════════════════════════════════════════╗${NC}"
    echo -e "  ${BOLD}${CYAN}║   Qual canal de mensagens você quer usar?    ║${NC}"
    echo -e "  ${BOLD}${CYAN}╚══════════════════════════════════════════════╝${NC}"
    echo ""
    echo -e "  ${BOLD}1)${NC} Telegram   — Bot via @BotFather              ${CYAN}(recomendado)${NC}"
    echo -e "  ${BOLD}2)${NC} Discord    — Bot via Developer Portal"
    echo -e "  ${BOLD}3)${NC} WhatsApp   — Via Baileys (QR code na 1ª vez)"
    echo -e "  ${BOLD}4)${NC} Signal     — Via signal-cli"
    echo -e "  ${BOLD}5)${NC} Múltiplos  — Configurar mais de um canal agora"
    echo -e "  ${BOLD}6)${NC} Pular      — Configurar depois via .env ou Dashboard"
    echo ""

    local channel_choice
    ask "  Opção" channel_choice "1"

    case "$channel_choice" in
      1) _configure_telegram ;;
      2) _configure_discord ;;
      3) _configure_whatsapp ;;
      4) _configure_signal ;;
      5)
        echo ""
        echo -e "  ${CYAN}Selecione os canais que deseja configurar agora:${NC}"
        ask_yes "  Telegram?" "s" && _configure_telegram
        ask_yes "  Discord?"  "n" && _configure_discord
        ask_yes "  WhatsApp?" "n" && _configure_whatsapp
        ask_yes "  Signal?"   "n" && _configure_signal
        ;;
      6)
        warn "Nenhum canal configurado agora."
        info "Configure depois com: newclaw channels enable <telegram|discord|whatsapp|signal>"
        info "Ou edite o arquivo: ${ENV_FILE}"
        ;;
      *)
        info "Opção não reconhecida — configurando Telegram (padrão)."
        _configure_telegram
        ;;
    esac

    # ── Provedor de IA ────────────────────────────────────────────────────
    echo ""
    echo -e "  ${BOLD}${YELLOW}── Provedor de IA ───────────────────────────────${NC}"
    echo -e "  ${BOLD}1)${NC} Ollama (Local)      — 100% privado, roda na sua máquina"
    echo -e "  ${BOLD}2)${NC} OpenRouter (Nuvem)  — Claude, GPT-4, Gemini, etc. (requer chave)"
    echo ""
  fi # end NO_PROMPT

  local provider="ollama"
  local or_key=""
  if [ "$NO_PROMPT" -eq 0 ]; then
    local p_choice
    ask "  Opção" p_choice "1"
    [ "$p_choice" = "2" ] && provider="openrouter"
  fi

  if [ "$provider" = "openrouter" ]; then
    while [ -z "$or_key" ]; do
      ask "  Cole sua API Key do OpenRouter (sk-or-...)" or_key
      [ -z "$or_key" ] && warn "API Key é necessária para OpenRouter!"
    done
  fi

  # ── Senha do Dashboard ────────────────────────────────────────────────────
  local dashboard_password=""
  if [ "$NO_PROMPT" -eq 0 ]; then
    echo ""
    echo -e "  ${BOLD}${YELLOW}── Dashboard Web ────────────────────────────────${NC}"
    echo -e "  ${CYAN}Defina uma senha para proteger o painel (Enter = sem senha).${NC}"
    echo -ne "  Nova senha (mín. 8 caracteres, Enter para pular): "
    stty -echo 2>/dev/null || true
    read -r dashboard_password < /dev/tty 2>/dev/null || read -r dashboard_password 2>/dev/null || dashboard_password=""
    stty echo 2>/dev/null || true
    echo ""
    if [ -n "$dashboard_password" ] && [ ${#dashboard_password} -lt 8 ]; then
      warn "Senha muito curta — dashboard ficará sem senha. Use 'newclaw passwd' depois."
      dashboard_password=""
    fi
  fi

  # Escrever .env
  if [ "$DRY_RUN" -eq 0 ]; then
    cat > "$ENV_FILE" << EOF
# NewClaw — Gerado pelo instalador em $(date -Iseconds)

# ─── Telegram (canal principal) ──────────────────────────────
TELEGRAM_BOT_TOKEN=${BOT_TOKEN}
TELEGRAM_ALLOWED_USER_IDS=${USER_ID}

# ─── Discord (opcional) ───────────────────────────────────────
DISCORD_BOT_TOKEN=${discord_token}
DISCORD_ALLOWED_GUILD_IDS=${discord_guilds}
DISCORD_ALLOWED_USER_IDS=${discord_users}

# ─── WhatsApp (opcional) ─────────────────────────────────────
WHATSAPP_PHONE_NUMBER=${wa_phone}
WHATSAPP_ALLOWED_JIDS=${wa_jids}
WHATSAPP_AUTH_DIR=./data/whatsapp-auth

# ─── Signal (opcional) ───────────────────────────────────────
SIGNAL_PHONE_NUMBER=${signal_phone}
SIGNAL_ALLOWED_NUMBERS=${signal_numbers}
SIGNAL_CLI_PATH=signal-cli

# ─── Idioma ───────────────────────────────────────────────────
APP_LANG=pt-BR

# ─── Provider padrão ─────────────────────────────────────────
DEFAULT_PROVIDER=${provider}

# ─── API Keys (opcional — preencha depois se quiser usar outros providers)
GEMINI_API_KEY=
DEEPSEEK_API_KEY=
GROQ_API_KEY=
OPENROUTER_API_KEY=${or_key}

# ─── Ollama (local / nuvem) ─────────────────────────────────
OLLAMA_URL=http://localhost:11434
OLLAMA_MODEL=${OLLAMA_MODEL}
OLLAMA_API_KEY=

# ─── Config ───────────────────────────────────────────────────
MAX_ITERATIONS=8
MEMORY_WINDOW_SIZE=20
SKILLS_DIR=./skills
TMP_DIR=./workspace/tmp

# ─── Dashboard Web ────────────────────────────────────────────
DASHBOARD_PORT=${DASHBOARD_PORT}
DASHBOARD_PASSWORD=${dashboard_password}

# ─── Whisper / TTS (opcional) ────────────────────────────────
WHISPER_API_URL=
WHISPER_API_FALLBACK=
WHISPER_PATH=
WHISPER_MODEL=tiny
EOF
  else
    dry "criar ${ENV_FILE} com token=${BOT_TOKEN:0:10}... user_id=${USER_ID} provider=${provider}"
  fi

  ok "Arquivo .env configurado!"

  # ── Instalar dependências de canais ─────────────────────────
  if [ "$DRY_RUN" -eq 0 ]; then
    cd "$NEWCLAW_DIR"

    # Discord — discord.js já está no package.json
    if [ -n "$discord_token" ]; then
      ok "Discord: configurado (discord.js já incluído)"
    fi

    # WhatsApp — Baileys já está no package.json
    if [ -n "$wa_phone" ]; then
      ok "WhatsApp: configurado (${wa_phone})"
      mkdir -p "${NEWCLAW_DIR}/data/whatsapp-auth"
      info "Na primeira execução, escaneie o QR code no terminal"
    fi

    # Signal — verificar signal-cli
    if [ -n "$signal_phone" ]; then
      if command -v signal-cli &>/dev/null; then
        ok "Signal: configurado (${signal_phone}, signal-cli encontrado)"
      else
        warn "Signal: signal-cli não encontrado! Instale: https://github.com/AsamK/signal-cli"
        info "  Ubuntu/Debian: sudo apt install signal-cli"
        info "  macOS: brew install signal-cli"
        info "  Ou baixe de: https://github.com/AsamK/signal-cli/releases"
      fi
    fi
  fi
}

# ── 8. Atalhos ───────────────────────────────────────────────

setup_cli() {
  step "8/9 — Configurando comando 'newclaw'"

  if [ "$DRY_RUN" -eq 1 ]; then
    dry "configurar comando global newclaw"
    return
  fi

  # 1. Tornar executável
  chmod +x "${NEWCLAW_DIR}/bin/newclaw"

  # 2. Tentar symlink (mais profissional)
  if sudo ln -sf "${NEWCLAW_DIR}/bin/newclaw" /usr/local/bin/newclaw 2>/dev/null; then
    ok "Comando 'newclaw' instalado em /usr/local/bin"
  else
    # 3. Fallback para alias se symlink falhar
    local shell_rc="$HOME/.bashrc"
    [ -n "$ZSH_VERSION" ] && shell_rc="$HOME/.zshrc"
    [ -f "$HOME/.zshrc" ] && shell_rc="$HOME/.zshrc"

    if ! grep -q "alias newclaw=" "$shell_rc" 2>/dev/null; then
      echo -e "\n# NewClaw CLI Alias\nalias newclaw='node ${NEWCLAW_DIR}/bin/newclaw'" >> "$shell_rc"
      ok "Atalho 'newclaw' adicionado a $shell_rc"
      info "Use 'source $shell_rc' para ativar agora."
    else
      info "Atalho 'newclaw' já existe em $shell_rc"
    fi
  fi
}

# ── 9. Iniciar ───────────────────────────────────────────────

start_newclaw() {
  step "9/9 — Iniciando o NewClaw"

  if [ "$DRY_RUN" -eq 1 ]; then
    dry "iniciar NewClaw em ${NEWCLAW_DIR}"
    return
  fi

  cd "$NEWCLAW_DIR"

  # Verificar se a porta já está em uso
  if command -v ss &>/dev/null && ss -tlnp | grep -q ":${DASHBOARD_PORT}"; then
    warn "Porta ${DASHBOARD_PORT} já em uso! Verifique antes de continuar."
  fi

  info "Iniciando o bot..."
  run node bin/newclaw start --daemon
  sleep 2

  if [ "$DRY_RUN" -eq 0 ]; then
    if node bin/newclaw status &>/dev/null; then
      ok "NewClaw está rodando!"
    else
      warn "Verifique com: node bin/newclaw status"
    fi
  else
    dry "verificar status do NewClaw"
  fi
}

# ── Autostart via PM2 ────────────────────────────────────────

setup_pm2_startup() {
  if [ "$SKIP_SYSTEMD" -eq 1 ]; then
    debug "Pulando autostart (flag --no-systemd)"
    return
  fi

  if [ "$DRY_RUN" -eq 1 ]; then
    dry "configurar PM2 autostart no boot"
    return
  fi

  echo ""
  if ask_yes "Configurar início automático no boot? (via PM2)" "y"; then
    # Instalar PM2 globalmente se não estiver disponível
    if ! check_cmd pm2; then
      info "Instalando PM2 globalmente..."
      run npm install -g pm2
      ok "PM2 instalado!"
    fi

    info "Configurando PM2 para iniciar com o sistema..."

    # Captura o comando sudo gerado pelo 'pm2 startup' e executa automaticamente
    local startup_cmd
    startup_cmd=$(pm2 startup 2>/dev/null | grep -E "^sudo env" | head -1)

    if [ -n "$startup_cmd" ]; then
      debug "Executando: $startup_cmd"
      run eval "$startup_cmd"
    else
      warn "Não foi possível capturar o comando de startup do PM2."
      warn "Execute manualmente: pm2 startup && pm2 save"
      return
    fi

    # Salva a lista de processos ativos para restaurar no boot
    run pm2 save
    ok "Autostart configurado! NewClaw iniciará automaticamente após cada reboot."
  else
    info "Pulando autostart"
  fi
}

# ── Firewall ─────────────────────────────────────────────────

setup_firewall() {
  if [ "$SKIP_FIREWALL" -eq 1 ]; then
    debug "Pulando firewall (flag --no-firewall)"
    return
  fi

  if [ "$DRY_RUN" -eq 1 ]; then
    dry "abrir porta ${DASHBOARD_PORT} no firewall"
    return
  fi

  if check_cmd ufw; then
    if ask_yes "Abrir porta ${DASHBOARD_PORT} no firewall (ufw)?" "y"; then
      run sudo ufw allow "${DASHBOARD_PORT}/tcp"
      ok "Porta ${DASHBOARD_PORT} aberta!"
    fi
  else
    debug "ufw não encontrado, pulando firewall"
  fi
}

# ── Resumo final ─────────────────────────────────────────────

show_summary() {
  echo ""
  echo -e "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${BOLD}${GREEN}  🪐 NewClaw instalado com sucesso!${NC}"
  echo -e "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo ""
  echo -e "  ${CYAN}Pasta:${NC}       ${NEWCLAW_DIR}"
  echo -e "  ${CYAN}Modelo:${NC}      ${OLLAMA_MODEL}"
  echo -e "  ${CYAN}Dashboard:${NC}   http://localhost:${DASHBOARD_PORT}"
  echo -e "  ${CYAN}Config URL:${NC}  http://localhost:${DASHBOARD_PORT}/config"
  echo -e "  ${CYAN}Logs:${NC}        ${NEWCLAW_DIR}/logs/newclaw.log"
  echo -e "  ${CYAN}Config File:${NC} ${ENV_FILE}"
  echo ""
  echo -e "  ${BOLD}Comandos úteis:${NC}"
  echo -e "    ${CYAN}cd ${NEWCLAW_DIR}${NC}"
  echo -e "    ${CYAN}newclaw status${NC}           — ver status"
  echo -e "    ${CYAN}newclaw logs -f${NC}          — ver logs em tempo real"
  echo -e "    ${CYAN}newclaw restart${NC}          — reiniciar"
  echo -e "    ${CYAN}newclaw stop${NC}             — parar"
  echo -e "    ${CYAN}newclaw passwd${NC}           — alterar senha do Dashboard"
  echo ""
  echo -e "  ${YELLOW}Abra seu canal configurado e mande 'Oi' para o agente! 🎉${NC}"
  echo -e "  ${CYAN}Dica: ${NC}newclaw channels  — ver status de todos os canais"
  echo ""
}

# ── Main ─────────────────────────────────────────────────────

main() {
  parse_args "$@"

  [ "$VERBOSE" -eq 1 ] && set -x

  banner

  if [ "$DRY_RUN" -eq 1 ]; then
    warn "MODO DRY-RUN — nenhuma alteração será feita"
  fi

  check_system
  update_system
  install_node
  install_ollama
  download_model
  install_newclaw
  check_for_backups
  configure
  setup_cli
  start_newclaw
  setup_pm2_startup
  setup_firewall
  show_summary
}

main "$@"
