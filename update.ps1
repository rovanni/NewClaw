# ============================================================
#  NewClaw — Script de Atualização para Windows
#
#  Uso:
#    .\update.ps1
#    .\update.ps1 -Restart
#    .\update.ps1 -Force
#
#  Equivalente ao update.sh para Linux
# ============================================================

[CmdletBinding()]
param(
    [switch]$Restart,
    [switch]$Force,
    [switch]$Help
)

$ErrorActionPreference = "Stop"
$DIR = Split-Path -Parent $MyInvocation.MyCommand.Path

# ── Helpers ──────────────────────────────────────────────────

function Write-Ok([string]$msg)   { Write-Host "  ✅ $msg" -ForegroundColor Green }
function Write-Info([string]$msg) { Write-Host "  ℹ  $msg" -ForegroundColor Cyan }
function Write-Warn([string]$msg) { Write-Host "  ⚠️  $msg" -ForegroundColor Yellow }
function Write-Fail([string]$msg) { Write-Host "  ❌ $msg" -ForegroundColor Red }

# ── Ajuda ────────────────────────────────────────────────────

if ($Help) {
    Write-Host @"
🪐 NewClaw — Atualizador para Windows

USO:
  .\update.ps1 [OPÇÕES]

OPÇÕES:
  -Restart    Reiniciar o NewClaw após a atualização
  -Force      Forçar atualização mesmo com mudanças locais
  -Help       Mostrar esta ajuda

O QUE FAZ:
  1. Verifica se há atualizações no GitHub
  2. Salva .env e alterações locais (git stash)
  3. Baixa as atualizações (git pull --rebase)
  4. Se falhar, faz sync forçado (git reset --hard)
  5. Restaura .env e alterações locais
  6. Instala dependências se necessário
  7. Recompila o projeto

EXEMPLOS:
  .\update.ps1                # Atualizar e compilar
  .\update.ps1 -Restart       # Atualizar e reiniciar
"@
    exit 0
}

# ── Main ─────────────────────────────────────────────────────

Write-Host ""
Write-Host "  🔄 NewClaw Auto-Update (Windows)" -ForegroundColor Cyan
Write-Host "  =================================" -ForegroundColor Cyan
Write-Host ""

# Determine .env path
$EnvFile = Join-Path $DIR ".env"
if (Test-Path (Join-Path $DIR "newclaw.env")) {
    $EnvFile = Join-Path $DIR "newclaw.env"
}

try {
    Push-Location $DIR

    # 1. Fetch remote
    Write-Info "Verificando atualizações..."
    git fetch origin main 2>&1 | Out-Null
    $local = (git rev-parse HEAD).Trim()
    $remote = (git rev-parse origin/main).Trim()

    if ($local -eq $remote) {
        Write-Ok "Sistema já está na versão mais recente ($($local.Substring(0,7)))"
        Pop-Location
        exit 0
    }

    Write-Info "Atualizando: $($local.Substring(0,7)) → $($remote.Substring(0,7))"
    Write-Host ""

    # Show new commits
    git log --oneline "$local..$remote" 2>&1 | ForEach-Object { Write-Host "    $_" -ForegroundColor Gray }
    Write-Host ""

    # 2. Backup .env (always protected)
    $EnvBackup = Join-Path $DIR ".env.update-backup"
    if (Test-Path $EnvFile) {
        Copy-Item $EnvFile $EnvBackup -Force
        Write-Info ".env salvo em backup"
    }

    # 3. Stash local changes
    $hasStash = $false
    try {
        $stashOut = (git stash --include-untracked 2>&1) -join "`n"
        if ($stashOut -notmatch "No local changes") {
            $hasStash = $true
            Write-Info "Alterações locais salvas (git stash)"
        }
    } catch {}

    # 4. Pull with rebase
    $pullOk = $false
    try {
        $pullOut = git pull --rebase origin main 2>&1
        if ($LASTEXITCODE -eq 0) { $pullOk = $true }
    } catch {}

    if (-not $pullOk) {
        # 5. Fallback: hard reset
        Write-Warn "Pull falhou, fazendo sync forçado..."
        try { git rebase --abort 2>&1 | Out-Null } catch {}
        git reset --hard origin/main 2>&1 | Out-Null
        $pullOk = $true
    }

    # 6. Restore stash
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

    # 7. Always restore .env
    if (Test-Path $EnvBackup) {
        Copy-Item $EnvBackup $EnvFile -Force
        Remove-Item $EnvBackup -Force
        Write-Ok ".env restaurado"
    }

    # 8. Install deps if changed
    try {
        $diff = git diff "$local..$remote" --name-only 2>&1
        if ($diff -match "package(-lock)?\.json") {
            Write-Info "Dependências alteradas, instalando..."
            npm install --production
        }
    } catch {}

    # 9. Build
    Write-Info "Compilando projeto..."
    npm run build
    Write-Ok "Build concluído!"

    # 10. Restart if requested
    if ($Restart) {
        Write-Info "Reiniciando NewClaw..."
        $cliPath = Join-Path $DIR "bin\newclaw"
        if (Test-Path $cliPath) {
            node $cliPath restart --daemon
        }
        Write-Ok "NewClaw reiniciado!"
    } else {
        Write-Warn "Execute 'newclaw restart --daemon' para aplicar as mudanças."
    }

    Write-Host ""
    Write-Host "  =================================" -ForegroundColor Green
    Write-Ok "Atualização concluída!"
    Write-Host ""

} catch {
    # Emergency: restore .env
    $EnvBackup = Join-Path $DIR ".env.update-backup"
    if (Test-Path $EnvBackup) {
        try {
            Copy-Item $EnvBackup $EnvFile -Force
            Remove-Item $EnvBackup -Force
        } catch {}
    }
    Write-Fail "Falha na atualização: $_"
    Write-Info "Tente: .\update.ps1 -Force"
} finally {
    Pop-Location
}
