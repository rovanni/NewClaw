# ============================================================
#  NewClaw — Script de Restauração Inteligente para Windows
#
#  Este script automatiza a restauração de backups criados
#  pelo desinstalador ou pelo script de backup automático.
# ============================================================

[CmdletBinding()]
param()

# ── Configurações ────────────────────────────────────────────
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$NewClawDir = Resolve-Path (Join-Path $ScriptDir "..")
$BackupRoot = Join-Path $env:USERPROFILE "newclaw-backups"
$AltBackupRoot = "C:\home\venus\backups" # Caso mapeado ou similar

function Write-Banner {
    Write-Host "  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Cyan
    Write-Host "    🪐 NewClaw — Restaurador de Backup" -ForegroundColor Cyan
    Write-Host "  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Cyan
}

# ── 1. Localizar Backups ─────────────────────────────────────
function Get-BackupSelection {
    $SearchPaths = @($BackupRoot)
    if (Test-Path $AltBackupRoot) { $SearchPaths += $AltBackupRoot }

    Write-Host "`nBuscando backups disponíveis...`n" -ForegroundColor White
    
    $Backups = @()
    foreach ($path in $SearchPaths) {
        if (Test-Path $path) {
            $Backups += Get-ChildItem -Path $path | Where-Object { $_.Name -like "newclaw_*" }
        }
    }
    
    $Backups = $Backups | Sort-Object LastWriteTime -Descending

    if ($Backups.Count -eq 0) {
        Write-Host "⚠️ Nenhum backup encontrado em:" -ForegroundColor Yellow
        foreach ($p in $SearchPaths) { Write-Host "  - $p" -ForegroundColor Gray }
        exit 1
    }

    for ($i = 0; $i -lt $Backups.Count; $i++) {
        $item = $Backups[$i]
        $type = if ($item.PSIsContainer) { "[Pasta - Completo]" } else { "[Arquivo - Apenas DB]" }
        Write-Host "  [$($i + 1)] $($item.Name) $type" -ForegroundColor Gray
    }

    Write-Host ""
    $Choice = Read-Host "  Escolha o número do backup para restaurar (ou 'q' para sair)"

    if ($Choice -eq 'q') { exit 0 }

    $Index = [int]$Choice - 1
    if ($Index -lt 0 -or $Index -ge $Backups.Count) {
        Write-Host "❌ Opção inválida." -ForegroundColor Red
        exit 1
    }

    return $Backups[$Index]
}

# ── 2. Preparar Restauração ──────────────────────────────────
function Prepare-Restore {
    Write-Host "`n⚠️ A restauração irá sobrescrever os dados atuais em $NewClawDir." -ForegroundColor Yellow
    $Confirm = Read-Host "  Tem certeza que deseja continuar? [s/N]"
    if ($Confirm -notmatch "^[sSyY]$") {
        Write-Host "Cancelado."
        exit 0
    }

    # Parar NewClaw
    $CliPath = Join-Path $NewClawDir "bin\newclaw"
    if (Test-Path $CliPath) {
        Write-Host "`n🛑 Parando NewClaw..." -ForegroundColor Red
        try { node $CliPath stop } catch {}
    }
    
    # Matar processos node residuais
    Get-Process -Name "node" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match "dist[\\/]index\.js" } | Stop-Process -Force -ErrorAction SilentlyContinue
    
    # Limpar arquivos WAL
    Write-Host "🧹 Limpando arquivos temporários do banco..." -ForegroundColor Gray
    $WalFile = Join-Path $NewClawDir "data\newclaw.db-wal"
    $ShmFile = Join-Path $NewClawDir "data\newclaw.db-shm"
    if (Test-Path $WalFile) { Remove-Item $WalFile -Force }
    if (Test-Path $ShmFile) { Remove-Item $ShmFile -Force }
}

# ── 3. Executar Restauração ──────────────────────────────────
function Invoke-Restore($SelectedBackup) {
    Write-Host "🚚 Restaurando: $($SelectedBackup.Name)..." -ForegroundColor Cyan

    if ($SelectedBackup.PSIsContainer) {
        # Backup completo (Pasta)
        
        # DB
        $SourceDb = Join-Path $SelectedBackup.FullName "data\newclaw.db"
        if (Test-Path $SourceDb) {
            $TargetData = Join-Path $NewClawDir "data"
            if (-not (Test-Path $TargetData)) { New-Item $TargetData -ItemType Directory }
            Copy-Item $SourceDb -Destination (Join-Path $TargetData "newclaw.db") -Force
            Write-Host "  ✅ Banco de dados restaurado." -ForegroundColor Green
        }
        
        # Workspace
        $SourceWs = Join-Path $SelectedBackup.FullName "workspace"
        if (Test-Path $SourceWs) {
            $TargetWs = Join-Path $NewClawDir "workspace"
            if (Test-Path $TargetWs) { Remove-Item $TargetWs -Recurse -Force }
            Copy-Item $SourceWs -Destination $TargetWs -Recurse -Force
            Write-Host "  ✅ Workspace restaurado." -ForegroundColor Green
        }
        
        # Skills
        $SourceSk = Join-Path $SelectedBackup.FullName "skills"
        if (Test-Path $SourceSk) {
            $TargetSk = Join-Path $NewClawDir "skills"
            if (Test-Path $TargetSk) { Remove-Item $TargetSk -Recurse -Force }
            Copy-Item $SourceSk -Destination $TargetSk -Recurse -Force
            Write-Host "  ✅ Skills restauradas." -ForegroundColor Green
        }
        
        # .env
        $SourceEnv = Join-Path $SelectedBackup.FullName ".env"
        if (Test-Path $SourceEnv) {
            Copy-Item $SourceEnv -Destination (Join-Path $NewClawDir ".env") -Force
            Write-Host "  ✅ Configurações (.env) restauradas." -ForegroundColor Green
        }
    } else {
        # Backup simples (.db)
        $TargetData = Join-Path $NewClawDir "data"
        if (-not (Test-Path $TargetData)) { New-Item $TargetData -ItemType Directory }
        Copy-Item $SelectedBackup.FullName -Destination (Join-Path $TargetData "newclaw.db") -Force
        Write-Host "  ✅ Banco de dados restaurado." -ForegroundColor Green
    }
}

# ── Execução ─────────────────────────────────────────────────
Write-Banner
$Selected = Get-BackupSelection
Prepare-Restore
Invoke-Restore $Selected

Write-Host "`n✨ Restauração concluída com sucesso!" -ForegroundColor Green
Write-Host "`n🚀 Iniciando NewClaw..." -ForegroundColor Cyan
$CliPath = Join-Path $NewClawDir "bin\newclaw"
node $CliPath start --daemon
Write-Host "✅ Sistema online. Verifique o dashboard."
Write-Host ""
