# ============================================================
#  NewClaw — Instalador Interativo para Windows
#
#  Uso:
#    irm https://raw.githubusercontent.com/rovanni/NewClaw/main/install.ps1 | iex
#    .\install.ps1
#    .\install.ps1 -Help
#    .\install.ps1 -DryRun
#    .\install.ps1 -NoPrompt -Token "SEU_TOKEN" -UserId "SEU_ID"
#
# ============================================================

[CmdletBinding()]
param(
    [string]$Token       = $env:NEWCLAW_TOKEN,
    [string]$UserId      = $env:NEWCLAW_USER_ID,
    [string]$Model       = $(if ($env:NEWCLAW_MODEL) { $env:NEWCLAW_MODEL } else { "glm-5:cloud" }),
    [string]$Dir         = $(if ($env:NEWCLAW_HOME)  { $env:NEWCLAW_HOME  } else { "$env:USERPROFILE\NewClaw" }),
    [int]$Port           = $(if ($env:NEWCLAW_DASHBOARD_PORT) { [int]$env:NEWCLAW_DASHBOARD_PORT } else { 3090 }),
    [switch]$NoPrompt,
    [switch]$NoOnboard,
    [switch]$NoService,
    [switch]$NoFirewall,
    [switch]$DryRun,
    [switch]$Help
)

$INSTALLER_VERSION = "1.0.0"

# ── Cores ────────────────────────────────────────────────────
function Write-Banner {
    Write-Host ""
    Write-Host "  ============================================" -ForegroundColor Cyan
    Write-Host "   🪐  NewClaw — Agente Cognitivo Local" -ForegroundColor Cyan
    Write-Host "       Instalador Windows v$INSTALLER_VERSION" -ForegroundColor Cyan
    Write-Host "  ============================================" -ForegroundColor Cyan
    Write-Host ""
}

function Write-Step([string]$msg) {
    Write-Host ""
    Write-Host "  ━━━ $msg ━━━" -ForegroundColor Green
    Write-Host ""
}

function Write-Info([string]$msg)  { Write-Host "    ℹ  $msg" -ForegroundColor Cyan }
function Write-Ok([string]$msg)    { Write-Host "    ✅ $msg" -ForegroundColor Green }
function Write-Warn([string]$msg)  { Write-Host "    ⚠️  $msg" -ForegroundColor Yellow }
function Write-Fail([string]$msg)  { Write-Host "    ❌ $msg" -ForegroundColor Red }
function Write-Dry([string]$msg)   { if ($DryRun) { Write-Host "    [dry-run] $msg" -ForegroundColor Yellow } }

function Invoke-Step([string]$cmd) {
    if ($DryRun) {
        Write-Dry "exec: $cmd"
    } else {
        Invoke-Expression $cmd
    }
}

function Read-Answer([string]$prompt, [string]$default = "") {
    if ($NoPrompt) { return $default }
    $shown = if ($default) { " [$default]" } else { "" }
    $answer = Read-Host "    $prompt$shown"
    if ([string]::IsNullOrWhiteSpace($answer)) { return $default }
    return $answer
}

function Read-YesNo([string]$prompt, [string]$default = "n") {
    if ($NoPrompt) {
        return ($default -in @("y", "Y", "s", "S"))
    }
    $hint = if ($default -eq "y") { "S/n" } else { "s/N" }
    $answer = Read-Host "    $prompt [$hint]"
    if ([string]::IsNullOrWhiteSpace($answer)) { $answer = $default }
    return ($answer -in @("s", "S", "y", "Y"))
}

function Test-Command([string]$cmd) {
    return [bool](Get-Command $cmd -ErrorAction SilentlyContinue)
}

# ── Ajuda ────────────────────────────────────────────────────

if ($Help) {
    Write-Host @"
🪐 NewClaw — Instalador Interativo para Windows

USO:
  irm https://raw.githubusercontent.com/rovanni/NewClaw/main/install.ps1 | iex
  .\install.ps1 [OPÇÕES]

OPÇÕES:
  -Token TOKEN       Token do bot do Telegram
  -UserId ID         Seu ID de usuário do Telegram
  -Model MODEL       Modelo Ollama (padrão: glm-5:cloud)
  -Dir PATH          Diretório de instalação (padrão: %USERPROFILE%\NewClaw)
  -Port PORT         Porta do dashboard (padrão: 3090)

  -NoPrompt          Modo não-interativo
  -NoOnboard         Pular configuração do Telegram
  -NoService         Pular criação de serviço Windows
  -NoFirewall        Pular configuração do firewall
  -DryRun            Simular sem executar
  -Help              Mostrar esta ajuda

VARIÁVEIS DE AMBIENTE:
  NEWCLAW_TOKEN              Token do bot Telegram
  NEWCLAW_USER_ID            ID do usuário Telegram
  NEWCLAW_MODEL              Modelo Ollama
  NEWCLAW_HOME               Diretório de instalação
  NEWCLAW_DASHBOARD_PORT     Porta do dashboard

EXEMPLOS:
  # Instalação interativa
  irm https://raw.githubusercontent.com/rovanni/NewClaw/main/install.ps1 | iex

  # Com token pré-definido
  .\install.ps1 -Token "123:ABC" -UserId "123456789" -NoPrompt

  # Dry run
  .\install.ps1 -DryRun
"@
    exit 0
}

# ── Verificar privilégios ────────────────────────────────────

function Test-Admin {
    $id = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $p  = New-Object System.Security.Principal.WindowsPrincipal($id)
    return $p.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
}

# ── 1. Verificar sistema ─────────────────────────────────────

function Step-CheckSystem {
    Write-Step "1/7 — Verificando o sistema"

    # OS
    $os = (Get-CimInstance Win32_OperatingSystem)
    Write-Info "Sistema: $($os.Caption) $($os.OSArchitecture)"

    # Versão mínima (Windows 10 build 17763+)
    $build = [int]$os.BuildNumber
    if ($build -lt 17763) {
        Write-Warn "Windows build $build detectado. Recomendado: Windows 10 1809+ ou Windows 11."
    } else {
        Write-Ok "Windows build $build — compatível"
    }

    # RAM
    $ramGB = [math]::Round($os.TotalVisibleMemorySize / 1MB, 1)
    if ($ramGB -lt 2) {
        Write-Warn "RAM: ${ramGB}GB — abaixo de 2GB, pode ficar lento"
    } else {
        Write-Ok "RAM: ${ramGB}GB"
    }

    # Disco
    $drive = Split-Path -Qualifier $Dir
    if (-not $drive) { $drive = "C:" }
    $disk = Get-PSDrive ($drive -replace ':','') -ErrorAction SilentlyContinue
    if ($disk) {
        $freeGB = [math]::Round($disk.Free / 1GB, 1)
        if ($freeGB -lt 5) {
            Write-Fail "Disco: ${freeGB}GB livres — precisa de pelo menos 5GB"
            exit 1
        }
        Write-Ok "Disco: ${freeGB}GB livres"
    }

    # Internet
    try {
        $null = Invoke-WebRequest -Uri "https://www.google.com" -TimeoutSec 5 -UseBasicParsing -ErrorAction Stop
        Write-Ok "Internet: conectada"
    } catch {
        Write-Warn "Internet: sem conexão — algumas etapas podem falhar"
    }
}

# ── 2. winget ────────────────────────────────────────────────

function Step-EnsureWinget {
    Write-Step "2/7 — Verificando winget (gerenciador de pacotes)"

    if (Test-Command "winget") {
        Write-Ok "winget disponível: $(winget --version)"
    } else {
        Write-Warn "winget não encontrado. Tentando instalar via Microsoft Store..."
        Write-Info "Alternativamente: https://aka.ms/getwinget"
        # Winget vem com App Installer — disponível no Windows 10 1809+
        try {
            Add-AppxPackage -RegisterByFamilyName -MainPackage Microsoft.DesktopAppInstaller_8wekyb3d8bbwe -ErrorAction Stop
            Write-Ok "winget instalado!"
        } catch {
            Write-Fail "Não foi possível instalar o winget automaticamente."
            Write-Info "Instale manualmente: https://aka.ms/getwinget"
            Write-Info "Depois execute este script novamente."
            exit 1
        }
    }
}

# ── 3. Node.js ───────────────────────────────────────────────

function Step-InstallNode {
    Write-Step "3/7 — Instalando Node.js"

    if (Test-Command "node") {
        $nodeVer = node --version 2>$null
        Write-Ok "Node.js encontrado: $nodeVer"
        $major = [int]($nodeVer -replace 'v','').Split('.')[0]
        if ($major -lt 18) {
            Write-Warn "Versão antiga ($nodeVer). Recomendado: v22+"
            if (Read-YesNo "Atualizar para Node.js 22?" "y") {
                Invoke-Step "winget upgrade --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements"
                Write-Ok "Node.js atualizado!"
            }
        }
    } else {
        Write-Info "Instalando Node.js 22 LTS..."
        Invoke-Step "winget install --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements"
        # Recarregar PATH
        $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("PATH","User")
        Write-Ok "Node.js instalado!"
    }

    if (Test-Command "npm") {
        Write-Ok "npm: $(npm --version)"
    }
}

# ── 4. Git ───────────────────────────────────────────────────

function Step-InstallGit {
    if (Test-Command "git") {
        Write-Ok "Git encontrado: $(git --version)"
        return
    }
    Write-Info "Instalando Git..."
    Invoke-Step "winget install --id Git.Git --silent --accept-package-agreements --accept-source-agreements"
    $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("PATH","User")
    Write-Ok "Git instalado!"
}

# ── 5. Ollama ────────────────────────────────────────────────

function Step-InstallOllama {
    Write-Step "4/8 — Instalando Ollama"

    if (Test-Command "ollama") {
        Write-Ok "Ollama encontrado!"
    } else {
        Write-Info "Instalando Ollama..."
        Invoke-Step "winget install --id Ollama.Ollama --silent --accept-package-agreements --accept-source-agreements"
        # Recarregar PATH
        $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("PATH","User")
        Write-Ok "Ollama instalado!"
    }

    # Iniciar Ollama se não estiver rodando
    $ollamaRunning = $false
    try {
        $null = Invoke-WebRequest -Uri "http://localhost:11434/api/tags" -TimeoutSec 3 -UseBasicParsing -ErrorAction Stop
        $ollamaRunning = $true
    } catch {}

    if ($ollamaRunning) {
        Write-Ok "Ollama rodando na porta 11434"
    } else {
        Write-Warn "Ollama não está rodando. Iniciando..."
        if (-not $DryRun) {
            Start-Process "ollama" -ArgumentList "serve" -WindowStyle Hidden
            $retries = 0
            while ($retries -lt 6) {
                Start-Sleep -Seconds 2
                try {
                    $null = Invoke-WebRequest -Uri "http://localhost:11434/api/tags" -TimeoutSec 2 -UseBasicParsing -ErrorAction Stop
                    Write-Ok "Ollama iniciado!"
                    $ollamaRunning = $true
                    break
                } catch {}
                $retries++
            }
            if (-not $ollamaRunning) {
                Write-Warn "Não foi possível verificar. Inicie o Ollama manualmente depois."
            }
        }
    }
}

# ── 6. Modelo ───────────────────────────────────────────────

function Step-DownloadModel {
    Write-Step "5/8 — Baixando o modelo de IA"

    if ($DryRun) { Write-Dry "baixar modelo $Model"; return }

    if (-not $NoPrompt) {
        Write-Host "    Escolha o modelo:" -ForegroundColor White
        Write-Host "    1) glm-5:cloud     — Recomendado (grátis, inferência remota)" -ForegroundColor Cyan
        Write-Host "    2) llama3.1:8b    — Rápido, uso geral (5GB local)" -ForegroundColor Cyan
        Write-Host "    3) mistral:7b     — Rápido, conversação (4GB local)" -ForegroundColor Cyan
        Write-Host "    4) qwen2.5:3b    — Leve, máquinas modestas (2GB local)" -ForegroundColor Cyan
        Write-Host "    5) Outro (digitar nome)" -ForegroundColor Cyan
        Write-Host ""

        $choice = Read-Answer "Qual modelo? (1-5)" "1"
        switch ($choice) {
            "2" { $script:Model = "llama3.1:8b" }
            "3" { $script:Model = "mistral:7b" }
            "4" { $script:Model = "qwen2.5:3b" }
            "5" { $script:Model = Read-Answer "Nome do modelo" "glm-5:cloud" }
            default { $script:Model = "glm-5:cloud" }
        }
    }

    Write-Info "Baixando modelo $Model..."
    Write-Info "Pode demorar alguns minutos na primeira vez..."
    Invoke-Step "ollama pull $Model"
    Write-Ok "Modelo $Model pronto!"
}

# ── 7. NewClaw ───────────────────────────────────────────────

function Step-InstallNewClaw {
    Write-Step "6/8 — Baixando o NewClaw"

    if (Test-Path $Dir) {
        Write-Warn "Pasta $Dir já existe!"
        if (Read-YesNo "Atualizar código do GitHub?" "y") {
            Push-Location $Dir

            # 1. Backup .env (always protected)
            $envPath = Join-Path $Dir ".env"
            $envBackup = Join-Path $Dir ".env.update-backup"
            if (Test-Path $envPath) {
                Copy-Item $envPath $envBackup -Force
            }

            # 2. Fetch remote
            git fetch origin main 2>&1 | Out-Null

            # 3. Stash local changes
            $hasStash = $false
            try {
                $stashOut = git stash --include-untracked 2>&1
                if ($stashOut -notmatch "No local changes") {
                    $hasStash = $true
                    Write-Info "Alterações locais salvas (git stash)"
                }
            } catch {}

            # 4. Pull with rebase
            $pullOk = $false
            try {
                git pull --rebase origin main 2>&1 | Out-Null
                if ($LASTEXITCODE -eq 0) { $pullOk = $true }
            } catch {}

            if (-not $pullOk) {
                Write-Warn "Pull falhou, fazendo sync forçado..."
                try { git rebase --abort 2>&1 | Out-Null } catch {}
                git reset --hard origin/main 2>&1 | Out-Null
            }

            # 5. Restore stash
            if ($hasStash) {
                try {
                    git stash pop 2>&1 | Out-Null
                    if ($LASTEXITCODE -eq 0) {
                        Write-Info "Alterações locais restauradas"
                    } else {
                        Write-Warn "Conflitos ao restaurar alterações locais (salvas em 'git stash list')"
                    }
                } catch {
                    Write-Warn "Conflitos ao restaurar alterações locais (salvas em 'git stash list')"
                }
            }

            # 6. Always restore .env
            if (Test-Path $envBackup) {
                Copy-Item $envBackup $envPath -Force
                Remove-Item $envBackup -Force
                Write-Info ".env restaurado com sucesso"
            }

            Write-Ok "Código atualizado!"
            Pop-Location
        } else {
            Write-Info "Mantendo código existente"
        }
    } else {
        Write-Info "Clonando repositório..."
        Invoke-Step "git clone https://github.com/rovanni/NewClaw.git `"$Dir`""
        Write-Ok "Código baixado!"
    }

    if ($DryRun) { Write-Dry "npm install && npm run build em $Dir"; return }

    Push-Location $Dir
    Write-Info "Instalando dependências..."
    npm install
    Write-Ok "Dependências instaladas!"

    Write-Info "Compilando código..."
    npm run build
    Write-Ok "Código compilado!"
    Pop-Location
}

# ── 8. Configuração ──────────────────────────────────────────

function Step-CheckForBackups {
    $BackupRoot = Join-Path $env:USERPROFILE "newclaw-backups"
    $AltBackupRoot = "C:\home\venus\backups"

    $SearchPaths = @($BackupRoot)
    if (Test-Path $AltBackupRoot) { $SearchPaths += $AltBackupRoot }

    $Backups = @()
    foreach ($path in $SearchPaths) {
        if (Test-Path $path) {
            $Backups += Get-ChildItem -Path $path | Where-Object { $_.Name -like "newclaw_*" }
        }
    }

    if ($Backups.Count -gt 0) {
        Write-Step "Bônus: Backups encontrados!"
        Write-Info "Detectamos $($Backups.Count) backup(s) disponível(is)."

        if (Read-YesNo "Deseja restaurar um backup agora em vez de fazer uma configuração limpa?" "n") {
            $RestoreScript = Join-Path $Dir "scripts\restore.ps1"
            if (Test-Path $RestoreScript) {
                & $RestoreScript
                # Se restaurou, podemos pular a configuração manual se o .env existir
                if (Test-Path (Join-Path $Dir ".env")) {
                    Write-Ok "Backup restaurado com sucesso. Pulando configuração manual."
                    $script:NoOnboard = $true
                }
            } else {
                Write-Warn "Script de restauração não encontrado em $RestoreScript"
            }
        }
    }
}

function Step-Configure {
    Write-Step "7/8 — Configurando o NewClaw"

    $envFile = Join-Path $Dir ".env"

    if ($DryRun) { Write-Dry "criar $envFile"; return }

    if (-not (Test-Path $envFile)) {
        $example = Join-Path $Dir ".env.example"
        if (Test-Path $example) { Copy-Item $example $envFile }
        else { New-Item $envFile -ItemType File | Out-Null }
    }

    if ($NoOnboard) {
        Write-Info "Onboarding pulado (-NoOnboard)"
        Write-Info "Configure o .env manualmente: $envFile"
        return
    }

    if ([string]::IsNullOrWhiteSpace($Token)) {
        Write-Host ""
        Write-Host "    ━━━ Configuração do Telegram ━━━" -ForegroundColor Yellow
        Write-Host ""
        Write-Host "    Você precisará de 2 códigos diferentes:" -ForegroundColor Cyan
        Write-Host "    1. Bot Token  → Pegue com o @BotFather (Ex: 12345:AAFF...)"
        Write-Host "    2. Seu User ID → Pegue com o @userinfobot (Ex: 987654321)"
        Write-Host ""

        while ([string]::IsNullOrWhiteSpace($Token)) {
            $Token = Read-Answer "1. Cole o TOKEN COMPLETO do bot" ""
            if ([string]::IsNullOrWhiteSpace($Token)) { 
                Write-Fail "Token é obrigatório!" 
            } elseif ($Token -notlike "*:*") {
                Write-Warn "Isso não parece um Token válido (falta o ':'). Tente novamente."
                $Token = ""
            }
        }
    }

    if ([string]::IsNullOrWhiteSpace($UserId)) {
        while ([string]::IsNullOrWhiteSpace($UserId)) {
            $UserId = Read-Answer "2. Cole o SEU ID de usuário (números)" ""
            if ([string]::IsNullOrWhiteSpace($UserId)) {
                Write-Fail "User ID é obrigatório!"
            } elseif ($UserId -like "*:*") {
                Write-Warn "Você colou o Token no lugar do ID! Use o ID do @userinfobot (apenas números)."
                $UserId = ""
            } elseif ($UserId -notmatch "^\d+$") {
                Write-Warn "O ID deve conter apenas números. Tente novamente."
                $UserId = ""
            }
        }
    }

    $timestamp = Get-Date -Format "yyyy-MM-ddTHH:mm:sszzz"
    $envContent = @"
# NewClaw — Gerado pelo instalador em $timestamp

# Telegram
TELEGRAM_BOT_TOKEN=$Token
TELEGRAM_ALLOWED_USER_IDS=$UserId

# Idioma
APP_LANG=pt-BR

# Provider padrão
DEFAULT_PROVIDER=ollama

# API Keys (opcional)
GEMINI_API_KEY=
DEEPSEEK_API_KEY=
GROQ_API_KEY=

# Ollama
OLLAMA_URL=http://localhost:11434
OLLAMA_MODEL=$Model
OLLAMA_API_KEY=

# Config
MAX_ITERATIONS=8
MEMORY_WINDOW_SIZE=20
SKILLS_DIR=./skills
TMP_DIR=./workspace/tmp

# Dashboard Web
DASHBOARD_PORT=$Port

# Whisper (opcional)
WHISPER_API_URL=
WHISPER_PATH=
"@
    Set-Content -Path $envFile -Value $envContent -Encoding UTF8
    Write-Ok "Arquivo .env configurado!"
}

# ── 8. Atalhos ───────────────────────────────────────────────

function Step-SetupCLI {
    Write-Step "8/8 — Configurando comando 'newclaw'"

    if ($DryRun) { Write-Dry "configurar comando global newclaw"; return }

    $binDir = Join-Path $Dir "bin"
    $wrapperPath = Join-Path $binDir "newclaw.cmd"

    # 1. Criar wrapper .cmd para Windows
    $cmdContent = "@echo off`r`nnode `"%~dp0newclaw`" %*"
    try {
        Set-Content -Path $wrapperPath -Value $cmdContent -Encoding Ascii -ErrorAction Stop
        Write-Ok "Arquivo de atalho 'newclaw.cmd' criado."
    } catch {
        Write-Warn "Não foi possível criar o wrapper em $wrapperPath"
    }

    # 2. Adicionar ao PATH do Usuário
    try {
        $oldPath = [Environment]::GetEnvironmentVariable("Path", "User")
        if ($oldPath -notlike "*$binDir*") {
            $newPath = "$oldPath;$binDir"
            [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
            Write-Ok "Pasta 'bin' adicionada ao PATH do usuário."
            Write-Info "Reinicie o terminal para usar o comando 'newclaw' de qualquer lugar."
        } else {
            Write-Info "Pasta 'bin' já está no PATH."
        }
    } catch {
        Write-Warn "Não foi possível atualizar o PATH automaticamente."
    }
}

# ── Serviço Windows ──────────────────────────────────────────

function Step-SetupWindowsService {
    if ($NoService) { return }
    if ($DryRun)    { Write-Dry "criar serviço Windows"; return }

    Write-Host ""
    if (Read-YesNo "Criar serviço Windows para auto-iniciar com o sistema?" "y") {
        if (-not (Test-Admin)) {
            Write-Warn "Privilégios de administrador necessários para criar serviço."
            Write-Info "Execute este script como Administrador e rode:"
            Write-Info "  .\install.ps1 -NoPrompt -NoOnboard -NoFirewall"
            return
        }

        $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
        $nodePath = if ($nodeCmd) { $nodeCmd.Source } else { "node" }

        $svcName = "NewClaw"
        $existing = Get-Service -Name $svcName -ErrorAction SilentlyContinue
        if ($existing) {
            Stop-Service -Name $svcName -ErrorAction SilentlyContinue
            sc.exe delete $svcName | Out-Null
        }

        # Usar sc.exe para criar serviço nativo
        $binPath = "`"$nodePath`" `"$Dir\bin\newclaw`" start"
        sc.exe create $svcName binPath= $binPath start= auto DisplayName= "NewClaw AI Agent" | Out-Null
        sc.exe description $svcName "NewClaw — Agente Cognitivo Local com Memória Semântica" | Out-Null
        sc.exe start $svcName | Out-Null

        Write-Ok "Serviço '$svcName' criado e iniciado!"
        Write-Info "Gerenciar: services.msc  ou  sc.exe query NewClaw"
    } else {
        Write-Info "Pulando criação de serviço"
    }
}

# ── Firewall ─────────────────────────────────────────────────

function Step-SetupFirewall {
    if ($NoFirewall) { return }
    if ($DryRun)     { Write-Dry "abrir porta $Port no firewall"; return }

    if (Read-YesNo "Abrir porta $Port no firewall do Windows?" "y") {
        if (-not (Test-Admin)) {
            Write-Warn "Requer privilégios de Administrador para configurar o firewall."
            return
        }
        $ruleName = "NewClaw Dashboard (TCP $Port)"
        New-NetFirewallRule -DisplayName $ruleName `
            -Direction Inbound -Protocol TCP -LocalPort $Port `
            -Action Allow -ErrorAction SilentlyContinue | Out-Null
        Write-Ok "Porta $Port aberta no firewall!"
    }
}

# ── Iniciar ──────────────────────────────────────────────────

function Step-Start {
    if ($DryRun) { Write-Dry "iniciar NewClaw em $Dir"; return }

    # Verificar porta
    $portInUse = Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue
    if ($portInUse) {
        Write-Warn "Porta $Port já está em uso! Verifique antes de continuar."
    }

    Push-Location $Dir
    Write-Info "Iniciando o bot..."
    node bin/newclaw start --daemon
    Start-Sleep -Seconds 2
    Pop-Location
}

# ── Resumo ───────────────────────────────────────────────────

function Show-Summary {
    Write-Host ""
    Write-Host "  ================================================" -ForegroundColor Green
    Write-Host "   🪐  NewClaw instalado com sucesso!" -ForegroundColor Green
    Write-Host "  ================================================" -ForegroundColor Green
    Write-Host ""
    Write-Host "    Pasta:      $Dir" -ForegroundColor Cyan
    Write-Host "    Modelo:     $Model" -ForegroundColor Cyan
    Write-Host "    Dashboard:  http://localhost:$Port" -ForegroundColor Cyan
    Write-Host "    Config URL: http://localhost:$Port/config" -ForegroundColor Cyan
    Write-Host "    Logs:       $Dir\logs\newclaw.log" -ForegroundColor Cyan
    Write-Host "    Config File:$Dir\.env" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "    Comandos úteis:" -ForegroundColor White
    Write-Host "      newclaw status    — ver status" -ForegroundColor Cyan
    Write-Host "      newclaw logs -f   — ver logs" -ForegroundColor Cyan
    Write-Host "      newclaw restart   — reiniciar" -ForegroundColor Cyan
    Write-Host "      newclaw stop      — parar" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "    Agora abra o Telegram e mande 'Oi' para seu bot! 🎉" -ForegroundColor Yellow
    Write-Host ""
}

# ── Main ─────────────────────────────────────────────────────

try {
    Write-Banner

    if ($DryRun) { Write-Warn "MODO DRY-RUN — nenhuma alteração será feita" }

    Step-CheckSystem
    Step-EnsureWinget
    Step-InstallNode
    Step-InstallGit
    Step-InstallOllama
    Step-DownloadModel
    Step-InstallNewClaw
    Step-CheckForBackups
    Step-Configure
    Step-SetupCLI
    Step-Start
    Step-SetupWindowsService
    Step-SetupFirewall
    Show-Summary
} catch {
    Write-Fail "Instalação falhou: $_"
    Write-Info "Para mais detalhes, execute com -Verbose"
    exit 1
}
