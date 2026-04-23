# ============================================================
#  NewClaw — Desinstalador Interativo para Windows
#
#  Uso:
#    .\uninstall.ps1
#    .\uninstall.ps1 -Help
#    .\uninstall.ps1 -NoPrompt           # Remove tudo com backup automático
#    .\uninstall.ps1 -BackupOnly         # Apenas cria backup
#    .\uninstall.ps1 -KeepData           # Remove código, mantém dados
#
# ============================================================

[CmdletBinding()]
param(
    [string]$Dir         = $(if ($env:NEWCLAW_HOME) { $env:NEWCLAW_HOME } else { "$env:USERPROFILE\NewClaw" }),
    [string]$BackupDir   = "$env:USERPROFILE\newclaw-backups",
    [switch]$NoPrompt,
    [switch]$BackupOnly,
    [switch]$KeepData,
    [switch]$Help
)

$Timestamp = Get-Date -Format "yyyyMMdd_HHmmss"

# ── Cores ────────────────────────────────────────────────────
function Write-Banner {
    Write-Host ""
    Write-Host "  ============================================" -ForegroundColor Red
    Write-Host "   🪐  NewClaw — Desinstalador" -ForegroundColor Red
    Write-Host "  ============================================" -ForegroundColor Red
    Write-Host ""
}

function Write-Step([string]$msg) {
    Write-Host ""
    Write-Host "  ━━━ $msg ━━━" -ForegroundColor Cyan
    Write-Host ""
}

function Write-Info([string]$msg)  { Write-Host "    ℹ  $msg" -ForegroundColor Cyan }
function Write-Ok([string]$msg)    { Write-Host "    ✅ $msg" -ForegroundColor Green }
function Write-Warn([string]$msg)  { Write-Host "    ⚠️  $msg" -ForegroundColor Yellow }
function Write-Fail([string]$msg)  { Write-Host "    ❌ $msg" -ForegroundColor Red }

function Read-YesNo([string]$prompt, [string]$default = "n") {
    if ($NoPrompt) {
        return ($default -in @("y", "Y", "s", "S"))
    }
    $hint = if ($default -eq "y") { "S/n" } else { "s/N" }
    $answer = Read-Host "    $prompt [$hint]"
    if ([string]::IsNullOrWhiteSpace($answer)) { $answer = $default }
    return ($answer -in @("s", "S", "y", "Y"))
}

function Get-FolderSize([string]$path) {
    if (Test-Path $path) {
        $bytes = (Get-ChildItem $path -Recurse -File -ErrorAction SilentlyContinue |
                  Measure-Object -Property Length -Sum).Sum
        if ($bytes -gt 1GB) { return "{0:N1} GB" -f ($bytes / 1GB) }
        if ($bytes -gt 1MB) { return "{0:N1} MB" -f ($bytes / 1MB) }
        if ($bytes -gt 1KB) { return "{0:N1} KB" -f ($bytes / 1KB) }
        return "$bytes bytes"
    }
    return "0 bytes"
}

function Get-FileSize([string]$path) {
    if (Test-Path $path) {
        $bytes = (Get-Item $path).Length
        if ($bytes -gt 1GB) { return "{0:N1} GB" -f ($bytes / 1GB) }
        if ($bytes -gt 1MB) { return "{0:N1} MB" -f ($bytes / 1MB) }
        if ($bytes -gt 1KB) { return "{0:N1} KB" -f ($bytes / 1KB) }
        return "$bytes bytes"
    }
    return "0 bytes"
}

# ── Ajuda ────────────────────────────────────────────────────

if ($Help) {
    Write-Host @"
🪐 NewClaw — Desinstalador Interativo para Windows

USO:
  .\uninstall.ps1 [OPÇÕES]

OPÇÕES:
  -Dir PATH          Diretório do NewClaw (padrão: %USERPROFILE%\NewClaw)
  -BackupDir PATH    Diretório para backups (padrão: %USERPROFILE%\newclaw-backups)
  -NoPrompt          Modo não-interativo (backup automático + remoção)
  -BackupOnly        Apenas cria backup sem desinstalar
  -KeepData          Remove código mas mantém banco de dados e workspace
  -Help              Mostrar esta ajuda

O QUE SERÁ REMOVIDO:
  • Código fonte e build (src\, dist\, node_modules\)
  • Configuração (.env)
  • Serviço Windows (se existir)
  • Logs (logs\)

DADOS QUE PODEM SER PRESERVADOS (com backup):
  • Banco de dados semântico (data\newclaw.db)
  • Workspace e arquivos de trabalho (workspace\)
  • Skills aprendidas (skills\)
  • Snapshots de memória

EXEMPLOS:
  .\uninstall.ps1                   # Interativo (recomendado)
  .\uninstall.ps1 -BackupOnly       # Só backup
  .\uninstall.ps1 -KeepData         # Remove código, mantém dados
  .\uninstall.ps1 -NoPrompt         # Remove tudo com backup automático
"@
    exit 0
}

# ── 1. Inventário ────────────────────────────────────────────

function Step-ShowInventory {
    Write-Step "1/4 — Analisando instalação"

    if (-not (Test-Path $Dir)) {
        Write-Fail "Pasta do NewClaw não encontrada: $Dir"
        exit 1
    }

    Write-Info "Pasta: $Dir"

    # Banco de dados
    $dbFile = Join-Path $Dir "data\newclaw.db"
    if (Test-Path $dbFile) {
        $dbSize = Get-FileSize $dbFile
        Write-Info "Banco de dados: $dbFile ($dbSize)"

        # Contar nós se sqlite3 disponível
        if (Get-Command sqlite3 -ErrorAction SilentlyContinue) {
            try {
                $nodeCount = sqlite3 $dbFile "SELECT COUNT(*) FROM memory_nodes;" 2>$null
                $edgeCount = sqlite3 $dbFile "SELECT COUNT(*) FROM memory_edges;" 2>$null
                Write-Info "  → $nodeCount nós de memória, $edgeCount relações"
            } catch {}
        }
    } else {
        Write-Info "Banco de dados: não encontrado"
    }

    # Workspace
    $wsPath = Join-Path $Dir "workspace"
    if (Test-Path $wsPath) {
        $wsSize = Get-FolderSize $wsPath
        $wsFiles = (Get-ChildItem $wsPath -Recurse -File -ErrorAction SilentlyContinue).Count
        Write-Info "Workspace: $wsFiles arquivos ($wsSize)"
    } else {
        Write-Info "Workspace: vazio"
    }

    # Skills
    $skillsPath = Join-Path $Dir "skills"
    if (Test-Path $skillsPath) {
        $skillCount = (Get-ChildItem $skillsPath -Recurse -File -Include "*.md","*.json" -ErrorAction SilentlyContinue).Count
        Write-Info "Skills: $skillCount habilidades aprendidas"
    } else {
        Write-Info "Skills: nenhuma"
    }

    # Logs
    $logsPath = Join-Path $Dir "logs"
    if (Test-Path $logsPath) {
        $logSize = Get-FolderSize $logsPath
        Write-Info "Logs: $logSize"
    }

    # Snapshots
    $snapPath = Join-Path $Dir "data\snapshots"
    if (Test-Path $snapPath) {
        $snapCount = (Get-ChildItem $snapPath -ErrorAction SilentlyContinue).Count
        Write-Info "Snapshots: $snapCount versões salvas"
    }

    # .env
    $envFile = Join-Path $Dir ".env"
    if (Test-Path $envFile) {
        Write-Info "Configuração: .env presente"
    }

    # Serviço Windows
    $svc = Get-Service -Name "NewClaw" -ErrorAction SilentlyContinue
    if ($svc) {
        Write-Info "Serviço Windows: instalado (Status: $($svc.Status))"
    }

    Write-Host ""
    Write-Host "    ⚠️  ATENÇÃO: A desinstalação é irreversível sem backup!" -ForegroundColor Yellow
    Write-Host ""
}

# ── 2. Backup ────────────────────────────────────────────────

function Step-DoBackup {
    Write-Step "2/4 — Backup dos dados"

    $dbFile      = Join-Path $Dir "data\newclaw.db"
    $dumpFile    = Join-Path $Dir "data\newclaw_dump.sql"
    $wsPath      = Join-Path $Dir "workspace"
    $skillsPath  = Join-Path $Dir "skills"
    $envFile     = Join-Path $Dir ".env"
    $snapPath    = Join-Path $Dir "data\snapshots"

    $hasData = (Test-Path $dbFile) -or (Test-Path $wsPath) -or (Test-Path $skillsPath)

    if (-not $hasData) {
        Write-Info "Nenhum dado para backup."
        return
    }

    $doDb    = $false
    $doWs    = $false
    $doSk    = $false
    $doEnv   = $false
    $doSnap  = $false

    if ($NoPrompt) {
        $doDb   = $true
        $doWs   = $true
        $doSk   = $true
        $doEnv  = $true
        $doSnap = $true
        Write-Info "Modo automático: fazendo backup completo"
    } else {
        Write-Host "    Escolha o que salvar antes de desinstalar:" -ForegroundColor White
        Write-Host ""

        if (Test-Path $dbFile) {
            $doDb = Read-YesNo "💾 Banco de dados (memória semântica, grafo, conversas)?" "y"
        }
        if (Test-Path $wsPath) {
            $doWs = Read-YesNo "📁 Workspace (arquivos de trabalho, sites, dados)?" "y"
        }
        if (Test-Path $skillsPath) {
            $doSk = Read-YesNo "🎓 Skills (habilidades aprendidas pelo agente)?" "y"
        }
        if (Test-Path $envFile) {
            $doEnv = Read-YesNo "🔑 Configuração (.env com tokens e API keys)?" "y"
        }
        if (Test-Path $snapPath) {
            $doSnap = Read-YesNo "📸 Snapshots (versões salvas do grafo de memória)?" "y"
        }
    }

    $total = @($doDb, $doWs, $doSk, $doEnv, $doSnap) | Where-Object { $_ } | Measure-Object | Select-Object -ExpandProperty Count

    if ($total -eq 0) {
        Write-Warn "Nenhum item selecionado para backup."
        if ($BackupOnly) { Write-Info "Nada a fazer."; exit 0 }
        return
    }

    # Criar diretório de backup
    $backupPath = Join-Path $BackupDir "newclaw_$Timestamp"
    New-Item -Path $backupPath -ItemType Directory -Force | Out-Null
    Write-Info "Salvando em: $backupPath"
    Write-Host ""

    # Banco de dados
    if ($doDb -and (Test-Path $dbFile)) {
        $dataBackup = Join-Path $backupPath "data"
        New-Item -Path $dataBackup -ItemType Directory -Force | Out-Null

        if (Get-Command sqlite3 -ErrorAction SilentlyContinue) {
            Write-Info "Exportando banco de dados (backup atômico via sqlite3)..."
            sqlite3 $dbFile ".backup '$dataBackup\newclaw.db'"
        } else {
            Write-Info "Copiando banco de dados..."
            Copy-Item $dbFile -Destination "$dataBackup\newclaw.db"
        }

        if (Test-Path $dumpFile) {
            Copy-Item $dumpFile -Destination $dataBackup
        }

        $dbBakSize = Get-FileSize "$dataBackup\newclaw.db"
        Write-Ok "Banco de dados salvo ($dbBakSize)"
    }

    # Workspace
    if ($doWs -and (Test-Path $wsPath)) {
        Write-Info "Copiando workspace..."
        Copy-Item $wsPath -Destination (Join-Path $backupPath "workspace") -Recurse
        Write-Ok "Workspace salvo"
    }

    # Skills
    if ($doSk -and (Test-Path $skillsPath)) {
        Write-Info "Copiando skills..."
        Copy-Item $skillsPath -Destination (Join-Path $backupPath "skills") -Recurse
        Write-Ok "Skills salvas"
    }

    # .env
    if ($doEnv -and (Test-Path $envFile)) {
        Copy-Item $envFile -Destination $backupPath
        Write-Ok "Configuração salva"
    }

    # Snapshots
    if ($doSnap -and (Test-Path $snapPath)) {
        Write-Info "Copiando snapshots..."
        $snapBackup = Join-Path $backupPath "data\snapshots"
        New-Item -Path $snapBackup -ItemType Directory -Force | Out-Null
        Copy-Item "$snapPath\*" -Destination $snapBackup -Recurse -ErrorAction SilentlyContinue
        Write-Ok "Snapshots salvos"
    }

    # Resumo
    $backupTotalSize = Get-FolderSize $backupPath
    Write-Host ""
    Write-Ok "Backup completo: $backupPath ($backupTotalSize)"

    if ($BackupOnly) {
        Write-Host ""
        Write-Host "    Backup criado com sucesso!" -ForegroundColor Green
        Write-Host "    Local: $backupPath" -ForegroundColor Cyan
        Write-Host ""
        Write-Host "    Para restaurar depois:" -ForegroundColor White
        Write-Host "      Copy-Item $backupPath\data\newclaw.db $Dir\data\" -ForegroundColor Cyan
        Write-Host "      Copy-Item $backupPath\workspace $Dir\workspace -Recurse" -ForegroundColor Cyan
        Write-Host "      Copy-Item $backupPath\skills $Dir\skills -Recurse" -ForegroundColor Cyan
        Write-Host "      Copy-Item $backupPath\.env $Dir\" -ForegroundColor Cyan
        Write-Host ""
        exit 0
    }
}

# ── 3. Parar serviços ───────────────────────────────────────

function Step-StopServices {
    Write-Step "3/4 — Parando serviços"

    # Parar via CLI
    $cliPath = Join-Path $Dir "bin\newclaw"
    if (Test-Path $cliPath) {
        Write-Info "Parando NewClaw via CLI..."
        try { node $cliPath stop 2>$null } catch {}
        Write-Ok "Agente parado"
    }

    # Matar processos
    $procs = Get-Process -Name "node" -ErrorAction SilentlyContinue |
             Where-Object { $_.CommandLine -match "dist[\\/]index\.js" -or $_.CommandLine -match "newclaw" }
    if ($procs) {
        $procs | Stop-Process -Force -ErrorAction SilentlyContinue
        Write-Ok "Processos restantes encerrados"
    }

    # Remover serviço Windows
    $svc = Get-Service -Name "NewClaw" -ErrorAction SilentlyContinue
    if ($svc) {
        Write-Info "Removendo serviço Windows..."
        Stop-Service -Name "NewClaw" -Force -ErrorAction SilentlyContinue
        sc.exe delete "NewClaw" | Out-Null
        Write-Ok "Serviço Windows removido"
    }
}

# ── 4. Remover arquivos ─────────────────────────────────────

function Step-RemoveFiles {
    Write-Step "4/4 — Removendo arquivos"

    if ($KeepData) {
        Write-Info "Modo -KeepData: mantendo banco de dados, workspace e skills"

        $dirsToRemove = @("src", "dist", "node_modules", "bin", "docs", "specs", "scratch", "logs", ".git")
        $filesToRemove = @("package.json", "package-lock.json", "tsconfig.json", ".gitignore", "LICENSE",
                           "install.sh", "install.ps1", "uninstall.sh", "uninstall.ps1",
                           "start.sh", "update.sh", "migrate_vps.sh",
                           "debug_loop.js", "fetch.js", ".env", "README.md")

        foreach ($d in $dirsToRemove) {
            $path = Join-Path $Dir $d
            if (Test-Path $path) {
                Remove-Item $path -Recurse -Force -ErrorAction SilentlyContinue
            }
        }

        foreach ($f in $filesToRemove) {
            $path = Join-Path $Dir $f
            if (Test-Path $path) {
                Remove-Item $path -Force -ErrorAction SilentlyContinue
            }
        }

        Write-Ok "Código removido (dados preservados em $Dir)"
    } else {
        # Confirmação final
        if (-not $NoPrompt) {
            Write-Host "    ⚠️  ÚLTIMA CHANCE: Isso vai remover TODO o diretório:" -ForegroundColor Red
            Write-Host "       $Dir" -ForegroundColor Red
            Write-Host ""
            if (-not (Read-YesNo "Tem certeza que deseja continuar?" "n")) {
                Write-Info "Desinstalação cancelada."
                exit 0
            }
        }

        Remove-Item $Dir -Recurse -Force
        Write-Ok "Diretório $Dir removido completamente"
    }

    # Remover regra de firewall
    $fwRules = Get-NetFirewallRule -DisplayName "NewClaw*" -ErrorAction SilentlyContinue
    if ($fwRules) {
        $fwRules | Remove-NetFirewallRule -ErrorAction SilentlyContinue
        Write-Ok "Regras de firewall removidas"
    }
}

# ── Resumo ───────────────────────────────────────────────────

function Show-Summary {
    Write-Host ""
    Write-Host "  ================================================" -ForegroundColor Green
    Write-Host "   🪐  NewClaw desinstalado com sucesso" -ForegroundColor Green
    Write-Host "  ================================================" -ForegroundColor Green
    Write-Host ""

    $backupPath = Join-Path $BackupDir "newclaw_$Timestamp"
    if (Test-Path $backupPath) {
        Write-Host "    Backup salvo em: $backupPath" -ForegroundColor Cyan
        Write-Host ""
        Write-Host "    Para reinstalar e restaurar:" -ForegroundColor White
        Write-Host "      irm .../install.ps1 | iex" -ForegroundColor Cyan
        Write-Host "      Copy-Item $backupPath\data\newclaw.db ~\NewClaw\data\" -ForegroundColor Cyan
        Write-Host "      Copy-Item $backupPath\workspace ~\NewClaw\workspace -Recurse" -ForegroundColor Cyan
        Write-Host "      Copy-Item $backupPath\skills ~\NewClaw\skills -Recurse" -ForegroundColor Cyan
        Write-Host "      Copy-Item $backupPath\.env ~\NewClaw\" -ForegroundColor Cyan
    }

    if ($KeepData) {
        Write-Host "    Dados preservados em: $Dir" -ForegroundColor Yellow
    }

    Write-Host ""
    Write-Host "    Obrigado por usar o NewClaw! 🪐" -ForegroundColor DarkGray
    Write-Host ""
}

# ── Main ─────────────────────────────────────────────────────

try {
    Write-Banner

    Step-ShowInventory

    # Confirmação inicial
    if (-not $BackupOnly -and -not $NoPrompt) {
        if (-not (Read-YesNo "Deseja continuar com a desinstalação?" "n")) {
            Write-Info "Cancelado."
            exit 0
        }
    }

    Step-DoBackup
    if ($BackupOnly) { exit 0 }
    Step-StopServices
    Step-RemoveFiles
    Show-Summary
} catch {
    Write-Fail "Erro durante a desinstalação: $_"
    exit 1
}
