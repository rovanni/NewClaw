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

function Pause-Exit([int]$code = 0) {
    if (-not $NoPrompt) {
        Write-Host ""
        Read-Host "  Pressione Enter para fechar"
    }
    exit $code
}

function Invoke-WithSpinner([string]$Label, [scriptblock]$Block) {
    $frames = [char[]]@(0x280B, 0x2819, 0x2839, 0x2838, 0x283C, 0x2834, 0x2826, 0x2827, 0x2807, 0x280F)
    $result  = $null
    $err     = $null

    $job = Start-Job -ScriptBlock {
        param($bl, $wd)
        Set-Location $wd
        try {
            & ([scriptblock]::Create($bl))
            $ec = $LASTEXITCODE
            if ($ec) { throw "Command failed with exit code $ec" }
        }
        catch { throw $_ }
    } -ArgumentList $Block.ToString(), (Get-Location).Path

    $i = 0
    while ($job.State -eq 'Running') {
        $frame = $frames[$i % $frames.Length]
        Write-Host "`r    $frame  $Label..." -NoNewline -ForegroundColor Cyan
        Start-Sleep -Milliseconds 120
        $i++
    }

    $result = Receive-Job $job -Wait -ErrorVariable err 2>&1
    Remove-Job $job

    if ($job.State -eq 'Failed' -or $err) {
        Write-Host "`r    ❌ $Label falhou.              " -ForegroundColor Red
        throw ($err | Select-Object -First 1)
    }
    Write-Host "`r    ✅ $Label concluído.              " -ForegroundColor Green
    return $result
}

# ── Validações de canal ──────────────────────────────────────

function Test-TelegramToken([string]$tok, [string]$uid) {
    try {
        $resp = Invoke-RestMethod -Uri "https://api.telegram.org/bot${tok}/getMe" `
            -TimeoutSec 6 -ErrorAction Stop
        if ($resp.ok) {
            $name = $resp.result.first_name
            $user = $resp.result.username
            Write-Ok "Token Telegram válido — bot: $name (@$user)"
            return $true
        }
    } catch {
        $msg = $_.Exception.Message
        if ($msg -match "401") {
            Write-Fail "Token inválido (401 Unauthorized). Verifique com @BotFather."
        } elseif ($msg -match "timeout|connect") {
            Write-Warn "Sem conexão com a API do Telegram — token não verificado."
            return $true  # prosseguir offline
        } else {
            Write-Warn "Não foi possível verificar o token: $msg"
            return $true  # prosseguir mesmo assim
        }
    }
    return $false
}

function Test-DiscordToken([string]$tok) {
    if ([string]::IsNullOrWhiteSpace($tok)) { return $true }
    try {
        $headers = @{ Authorization = "Bot $tok" }
        $resp = Invoke-RestMethod -Uri "https://discord.com/api/v10/users/@me" `
            -Headers $headers -TimeoutSec 6 -ErrorAction Stop
        Write-Ok "Token Discord válido — bot: $($resp.username)"
        return $true
    } catch {
        $msg = $_.Exception.Message
        if ($msg -match "401") {
            Write-Fail "Token Discord inválido (401). Verifique no Developer Portal."
            return $false
        }
        Write-Warn "Não foi possível verificar token Discord: $msg"
        return $true
    }
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
    Pause-Exit 0
}

# ── Verificar privilégios ────────────────────────────────────

function Test-Admin {
    $id = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $p  = New-Object System.Security.Principal.WindowsPrincipal($id)
    return $p.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
}

# ── 1. Verificar sistema ─────────────────────────────────────

function Step-CheckSystem {
    Write-Step "1/9 — Verificando o sistema"

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
            Pause-Exit 1
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
    Write-Step "2/9 — Verificando winget (gerenciador de pacotes)"

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
            Pause-Exit 1
        }
    }
}

# ── 3. Node.js ───────────────────────────────────────────────

function Step-InstallNode {
    Write-Step "3/9 — Instalando Node.js"

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
    Write-Step "4/9 — Instalando Git"
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
    Write-Step "5/9 — Instalando Ollama"

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
    Write-Step "6/9 — Baixando o modelo de IA"

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

    if ($DryRun) { Write-Dry "ollama pull $Model"; return }
    $m = $script:Model
    Invoke-WithSpinner "Baixando modelo $m (pode demorar na 1ª vez)" (
        [scriptblock]::Create("ollama pull $m")
    )
    Write-Ok "Modelo $m pronto!"
}

# ── 7. NewClaw ───────────────────────────────────────────────

function Step-InstallNewClaw {
    Write-Step "7/9 — Baixando o NewClaw"

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
    Invoke-WithSpinner "Instalando dependências" {
        npm install --prefer-offline 2>&1
    }
    Invoke-WithSpinner "Compilando TypeScript e copiando assets do dashboard" {
        npm run build 2>&1
    }
    Pop-Location
}

# ── 8. Configuração ──────────────────────────────────────────

function Step-CheckForBackups {
    $BackupRoot = Join-Path $env:USERPROFILE "newclaw-backups"

    $Backups = @()
    if (Test-Path $BackupRoot) {
        $Backups += Get-ChildItem -Path $BackupRoot | Where-Object { $_.Name -like "newclaw_*" }
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

function Configure-Telegram {
    Write-Host ""
    Write-Host "    ── Telegram ─────────────────────────────────────" -ForegroundColor Yellow
    Write-Host "    Você vai precisar de 2 códigos:" -ForegroundColor Cyan
    Write-Host "      1. Bot Token  → Crie um bot com @BotFather no Telegram"
    Write-Host "         Exemplo: 123456789:AAFxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
    Write-Host "      2. Seu User ID → Envie /start para @userinfobot"
    Write-Host "         Exemplo: 987654321"
    Write-Host ""

    $tokenOk = $false
    while (-not $tokenOk) {
        while ([string]::IsNullOrWhiteSpace($script:Token)) {
            $script:Token = Read-Answer "  Cole o TOKEN do bot (ex: 123456:AAF...)" ""
            if ([string]::IsNullOrWhiteSpace($script:Token)) {
                Write-Fail "Token é obrigatório!"
            } elseif ($script:Token -notlike "*:*") {
                Write-Warn "Token inválido — deve conter ':'. Tente novamente."
                $script:Token = ""
            }
        }
        Write-Info "Verificando token com a API do Telegram..."
        if (Test-TelegramToken $script:Token "") {
            $tokenOk = $true
        } else {
            $script:Token = ""  # forçar nova entrada
        }
    }
    while ([string]::IsNullOrWhiteSpace($script:UserId)) {
        $script:UserId = Read-Answer "  Cole o seu USER ID (apenas números)" ""
        if ([string]::IsNullOrWhiteSpace($script:UserId)) {
            Write-Fail "User ID é obrigatório!"
        } elseif ($script:UserId -like "*:*") {
            Write-Warn "Isso parece um Token, não um ID! O ID vem do @userinfobot."
            $script:UserId = ""
        } elseif ($script:UserId -notmatch "^\d+$") {
            Write-Warn "O ID deve conter apenas números. Tente novamente."
            $script:UserId = ""
        }
    }
}

function Configure-Discord {
    Write-Host ""
    Write-Host "    ── Discord ──────────────────────────────────────" -ForegroundColor Yellow
    Write-Host "    Acesse: discord.com/developers → Applications → Bot → Token" -ForegroundColor Cyan
    Write-Host ""
    $discordOk = $false
    while (-not $discordOk) {
        $script:DiscordToken = Read-Answer "  Cole o Bot Token do Discord" ""
        if ([string]::IsNullOrWhiteSpace($script:DiscordToken)) { break }
        Write-Info "Verificando token com a API do Discord..."
        if (Test-DiscordToken $script:DiscordToken) { $discordOk = $true } else { $script:DiscordToken = "" }
    }
    $script:DiscordGuilds = Read-Answer "  IDs dos servidores permitidos (vírgula, vazio = todos)" ""
    $script:DiscordUsers  = Read-Answer "  IDs de usuários permitidos (vírgula, vazio = todos)" ""
}

function Configure-WhatsApp {
    Write-Host ""
    Write-Host "    ── WhatsApp ─────────────────────────────────────" -ForegroundColor Yellow
    Write-Host "    Usa a biblioteca Baileys — na 1ª execução aparecerá um QR code" -ForegroundColor Cyan
    Write-Host "    para escanear com o WhatsApp do celular." -ForegroundColor Cyan
    Write-Host ""
    $script:WaPhone = Read-Answer "  Número com código do país, sem + (ex: 5511999999999)" ""
    $script:WaJids  = Read-Answer "  JIDs autorizados (vírgula, vazio = todos os contatos)" ""
    if (-not [string]::IsNullOrWhiteSpace($script:WaPhone)) {
        Write-Ok "WhatsApp configurado! Escaneie o QR na 1ª execução."
    }
}

function Configure-Signal {
    Write-Host ""
    Write-Host "    ── Signal ───────────────────────────────────────" -ForegroundColor Yellow
    Write-Host "    Requer signal-cli instalado: github.com/AsamK/signal-cli" -ForegroundColor Cyan
    if (-not (Test-Command "signal-cli")) {
        Write-Warn "signal-cli não encontrado no PATH agora."
        Write-Info "  Windows: choco install signal-cli"
        Write-Info "  Linux/Mac: https://github.com/AsamK/signal-cli/releases"
        Write-Info "  Você pode instalar depois e configurar via 'newclaw channels enable signal'"
    }
    Write-Host ""
    $script:SignalPhone   = Read-Answer "  Número com código do país (ex: +5511999999999)" ""
    $script:SignalNumbers = Read-Answer "  Números autorizados (vírgula, vazio = todos)" ""
    if (-not [string]::IsNullOrWhiteSpace($script:SignalPhone)) {
        Write-Ok "Signal configurado!"
    }
}

function Step-Configure {
    Write-Step "8/9 — Configurando o NewClaw"

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

    # ── Variáveis de canal (scope script para as funções Configure-* ────────
    $script:Token         = $Token
    $script:UserId        = $UserId
    $script:DiscordToken  = ""
    $script:DiscordGuilds = ""
    $script:DiscordUsers  = ""
    $script:WaPhone       = ""
    $script:WaJids        = ""
    $script:SignalPhone   = ""
    $script:SignalNumbers = ""
    $DashboardPassword    = ""

    # ── Modo não-interativo: usa vars de ambiente / parâmetros passados ──────
    if ($NoPrompt) {
        if (-not [string]::IsNullOrWhiteSpace($Token)) { Configure-Telegram }
    } else {

        # ── Menu de escolha de canal ─────────────────────────────────────────
        Write-Host ""
        Write-Host "    ╔══════════════════════════════════════════════╗" -ForegroundColor Cyan
        Write-Host "    ║   Qual canal de mensagens você quer usar?    ║" -ForegroundColor Cyan
        Write-Host "    ╚══════════════════════════════════════════════╝" -ForegroundColor Cyan
        Write-Host ""
        Write-Host "    1) Telegram   — Bot via @BotFather              (recomendado)" -ForegroundColor White
        Write-Host "    2) Discord    — Bot via Developer Portal" -ForegroundColor White
        Write-Host "    3) WhatsApp   — Via Baileys (QR code na 1ª vez)" -ForegroundColor White
        Write-Host "    4) Signal     — Via signal-cli" -ForegroundColor White
        Write-Host "    5) Múltiplos  — Configurar mais de um canal agora" -ForegroundColor White
        Write-Host "    6) Pular      — Configurar depois via .env ou Dashboard" -ForegroundColor DarkGray
        Write-Host ""

        $channelChoice = Read-Answer "    Opção" "1"

        switch ($channelChoice) {
            "1" { Configure-Telegram }
            "2" { Configure-Discord }
            "3" { Configure-WhatsApp }
            "4" { Configure-Signal }
            "5" {
                Write-Host ""
                Write-Host "    Selecione os canais que deseja configurar agora:" -ForegroundColor Cyan
                if (Read-YesNo "    Telegram?" "s")  { Configure-Telegram }
                if (Read-YesNo "    Discord?"  "n")  { Configure-Discord }
                if (Read-YesNo "    WhatsApp?" "n")  { Configure-WhatsApp }
                if (Read-YesNo "    Signal?"   "n")  { Configure-Signal }
            }
            "6" {
                Write-Warn "Nenhum canal configurado agora."
                Write-Info "Configure depois com: newclaw channels enable <telegram|discord|whatsapp|signal>"
                Write-Info "Ou edite o arquivo: $envFile"
            }
            default {
                Write-Info "Opção não reconhecida — configurando Telegram (padrão)."
                Configure-Telegram
            }
        }

        # ── Provedor de IA ───────────────────────────────────────────────────
        Write-Host ""
        Write-Host "    ── Provedor de IA ───────────────────────────────" -ForegroundColor Yellow
        Write-Host "    1) Ollama (Local)      — 100% privado, roda na sua máquina" -ForegroundColor White
        Write-Host "    2) OpenRouter (Nuvem)  — Claude, GPT-4, Gemini, etc. (requer chave)" -ForegroundColor White
        Write-Host ""
    } # end !$NoPrompt

    $Provider = "ollama"
    if (-not $NoPrompt) {
        $pChoice = Read-Answer "    Opção" "1"
        if ($pChoice -eq "2") { $Provider = "openrouter" }
    }

    $OR_Key = ""
    if ($Provider -eq "openrouter") {
        while ([string]::IsNullOrWhiteSpace($OR_Key)) {
            $OR_Key = Read-Answer "    Cole sua API Key do OpenRouter (sk-or-...)" ""
            if ([string]::IsNullOrWhiteSpace($OR_Key)) { Write-Fail "API Key é necessária para OpenRouter!" }
        }
    }

    # ── Senha do Dashboard ───────────────────────────────────────────────────
    if (-not $NoPrompt) {
        Write-Host ""
        Write-Host "    ── Dashboard Web ────────────────────────────────" -ForegroundColor Yellow
        Write-Host "    Defina uma senha para proteger o painel (Enter = sem senha)." -ForegroundColor Cyan
        $securePw = Read-Host "    Nova senha (mín. 8 chars, Enter para pular)" -AsSecureString
        $DashboardPassword = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
            [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePw))
        if ($DashboardPassword.Length -gt 0 -and $DashboardPassword.Length -lt 8) {
            Write-Warn "Senha muito curta — dashboard ficará sem senha. Use 'newclaw passwd' depois."
            $DashboardPassword = ""
        }
    }

    # ── Gravar .env ──────────────────────────────────────────────────────────
    $timestamp = Get-Date -Format "yyyy-MM-ddTHH:mm:sszzz"
    $envContent = @"
# NewClaw — Gerado pelo instalador em $timestamp

# ─── Telegram ────────────────────────────────────────────────
TELEGRAM_BOT_TOKEN=$($script:Token)
TELEGRAM_ALLOWED_USER_IDS=$($script:UserId)

# ─── Discord ─────────────────────────────────────────────────
DISCORD_BOT_TOKEN=$($script:DiscordToken)
DISCORD_ALLOWED_GUILD_IDS=$($script:DiscordGuilds)
DISCORD_ALLOWED_USER_IDS=$($script:DiscordUsers)

# ─── WhatsApp ────────────────────────────────────────────────
WHATSAPP_PHONE_NUMBER=$($script:WaPhone)
WHATSAPP_ALLOWED_JIDS=$($script:WaJids)
WHATSAPP_AUTH_DIR=./data/whatsapp-auth

# ─── Signal ──────────────────────────────────────────────────
SIGNAL_PHONE_NUMBER=$($script:SignalPhone)
SIGNAL_ALLOWED_NUMBERS=$($script:SignalNumbers)
SIGNAL_CLI_PATH=signal-cli

# ─── Idioma ───────────────────────────────────────────────────
APP_LANG=pt-BR

# ─── Provider de IA ──────────────────────────────────────────
DEFAULT_PROVIDER=$Provider

# ─── API Keys ────────────────────────────────────────────────
GEMINI_API_KEY=
DEEPSEEK_API_KEY=
GROQ_API_KEY=
OPENROUTER_API_KEY=$OR_Key

# ─── Ollama (local / nuvem) ──────────────────────────────────
OLLAMA_URL=http://localhost:11434
OLLAMA_MODEL=$Model
OLLAMA_API_KEY=

# ─── Config ───────────────────────────────────────────────────
MAX_ITERATIONS=8
MEMORY_WINDOW_SIZE=20
SKILLS_DIR=./skills
TMP_DIR=./workspace/tmp

# ─── Dashboard Web ────────────────────────────────────────────
DASHBOARD_PORT=$Port
DASHBOARD_PASSWORD=$DashboardPassword

# ─── Whisper / TTS (opcional) ────────────────────────────────
WHISPER_API_URL=
WHISPER_API_FALLBACK=
WHISPER_PATH=
WHISPER_MODEL=tiny
"@
    Set-Content -Path $envFile -Value $envContent -Encoding UTF8
    Write-Ok "Arquivo .env configurado!"

    # ── Verificações pós-configuração ────────────────────────────────────────
    if (-not $DryRun) {
        if (-not [string]::IsNullOrWhiteSpace($script:DiscordToken)) {
            Write-Ok "Discord: configurado (discord.js já incluído)"
        }
        if (-not [string]::IsNullOrWhiteSpace($script:WaPhone)) {
            $waAuthDir = Join-Path $Dir "data\whatsapp-auth"
            if (-not (Test-Path $waAuthDir)) { New-Item -ItemType Directory -Path $waAuthDir | Out-Null }
            Write-Ok "WhatsApp: configurado — escaneie o QR na 1ª execução"
        }
        if (-not [string]::IsNullOrWhiteSpace($script:SignalPhone)) {
            if (Test-Command "signal-cli") {
                Write-Ok "Signal: configurado ($($script:SignalPhone), signal-cli encontrado)"
            } else {
                Write-Warn "Signal: signal-cli não encontrado — instale antes de iniciar"
                Write-Info "  Chocolatey: choco install signal-cli"
                Write-Info "  GitHub: https://github.com/AsamK/signal-cli/releases"
            }
        }

        # Resumo dos canais configurados
        $canaisOk = @()
        if (-not [string]::IsNullOrWhiteSpace($script:Token))        { $canaisOk += "Telegram" }
        if (-not [string]::IsNullOrWhiteSpace($script:DiscordToken)) { $canaisOk += "Discord" }
        if (-not [string]::IsNullOrWhiteSpace($script:WaPhone))      { $canaisOk += "WhatsApp" }
        if (-not [string]::IsNullOrWhiteSpace($script:SignalPhone))   { $canaisOk += "Signal" }

        if ($canaisOk.Count -gt 0) {
            Write-Ok "Canais ativos: $($canaisOk -join ', ')"
        } else {
            Write-Warn "Nenhum canal configurado. Use 'newclaw channels enable <canal>' depois."
        }
    }
}

# ── 8. Atalhos ───────────────────────────────────────────────

function Step-SetupCLI {
    Write-Step "9/9 — Configurando comando 'newclaw'"

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

# ── PM2 ──────────────────────────────────────────────────────

function Step-InstallPM2 {
    if ($DryRun) { Write-Dry "instalar PM2 globalmente"; return }

    # Verificar se já está instalado
    try {
        $pm2Prefix = (npm prefix -g 2>$null)
        $pm2Path = Join-Path $pm2Prefix "node_modules\pm2\bin\pm2"
        if (Test-Path $pm2Path) {
            Write-Ok "PM2 já instalado"
            return
        }
    } catch {}

    Write-Info "Instalando PM2 (gerenciador de processos com auto-restart)..."
    npm install -g pm2 2>&1 | Out-Null
    $ec = $LASTEXITCODE
    if ($ec -ne 0) {
        Write-Warn "Não foi possível instalar PM2 (exit code $ec)."
        Write-Warn "O bot iniciará via raw spawn — sem auto-restart em caso de crash."
        Write-Info "Para instalar manualmente depois: npm install -g pm2"
        return
    }
    Write-Ok "PM2 instalado com sucesso"
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
    $ec = $LASTEXITCODE
    if ($ec -ne 0) {
        Pop-Location
        throw "Falha ao iniciar o bot (exit code $ec). Execute 'newclaw logs' para diagnóstico."
    }

    # Verificação secundária: confirmar que o processo está vivo após o spawn
    Start-Sleep -Seconds 3
    $pidFile = Join-Path $Dir "newclaw.pid"
    if (Test-Path $pidFile) {
        $botPid = [int](Get-Content $pidFile -Raw).Trim()
        $proc = Get-Process -Id $botPid -ErrorAction SilentlyContinue
        if ($proc) {
            Write-Ok "Bot iniciado com sucesso (PID $botPid)"
        } else {
            Write-Warn "Bot iniciado mas processo (PID $botPid) já encerrou — pode ter falhado logo após o spawn."
            Write-Info "Verifique com: newclaw logs"
        }
    } else {
        Write-Warn "Bot iniciado mas PID file não encontrado — ainda pode estar inicializando."
        Write-Info "Verifique com: newclaw status"
    }
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
    Write-Host "      newclaw passwd    — alterar senha do Dashboard" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "    Abra seu canal configurado e mande 'Oi' para o agente! 🎉" -ForegroundColor Yellow
    Write-Host ""

    # Teste pós-instalação — Telegram (se configurado)
    if (-not $NoPrompt -and -not [string]::IsNullOrWhiteSpace($script:Token) -and -not [string]::IsNullOrWhiteSpace($script:UserId)) {
        Write-Host ""
        $testNow = Read-Host "  Quer enviar uma mensagem de teste ao bot agora? [S/n]"
        if ([string]::IsNullOrWhiteSpace($testNow) -or $testNow -match "^[sSyY]") {
            Write-Info "Enviando mensagem de teste via Telegram..."
            try {
                $msg = "Olá! 👋 Sou o NewClaw. Instalação concluída com sucesso! Estou online e pronto."
                $url = "https://api.telegram.org/bot$($script:Token)/sendMessage"
                $body = @{ chat_id = $script:UserId; text = $msg } | ConvertTo-Json
                $resp = Invoke-RestMethod -Uri $url -Method Post -Body $body -ContentType 'application/json' -TimeoutSec 8
                if ($resp.ok) {
                    Write-Ok "Mensagem enviada! Verifique o Telegram — o bot respondeu."
                } else {
                    Write-Warn "Bot não conseguiu enviar: $($resp.description)"
                }
            } catch {
                Write-Warn "Não foi possível enviar a mensagem de teste: $($_.Exception.Message)"
            }
        }
    }
}

# ── Main ─────────────────────────────────────────────────────

try {
    # Allow .ps1 wrappers (npm.ps1, etc.) to run when launched via irm|iex
    Set-ExecutionPolicy -ExecutionPolicy Bypass -Scope Process -Force -ErrorAction SilentlyContinue

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
    Step-InstallPM2
    Step-Start
    Step-SetupWindowsService
    Step-SetupFirewall
    Show-Summary
    Pause-Exit 0
} catch {
    Write-Fail "Instalação falhou: $_"
    Write-Info "Para mais detalhes, execute com -Verbose"
    Pause-Exit 1
}
