# ============================================================
#  NewClaw — Script de Restauração Inteligente para Windows
#
#  Fontes de backup suportadas:
#    1. data/backups/        ← backups gerados pelo Dashboard
#    2. ~/newclaw-backups    ← backups gerados pelo instalador
# ============================================================

[CmdletBinding()]
param()

# ── Configurações ────────────────────────────────────────────
$ScriptDir       = Split-Path -Parent $MyInvocation.MyCommand.Path
$NewClawDir      = Resolve-Path (Join-Path $ScriptDir "..")
$DashboardBackups = Join-Path $NewClawDir "data\backups"
$BackupRoot      = Join-Path $env:USERPROFILE "newclaw-backups"
$AltBackupRoot   = "C:\home\venus\backups"

function Write-Banner {
    Write-Host ""
    Write-Host "  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Cyan
    Write-Host "    🪐 NewClaw — Restaurador de Backup"       -ForegroundColor Cyan
    Write-Host "  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Cyan
    Write-Host ""
}

# Valida se um arquivo .db é um SQLite íntegro usando better-sqlite3 via Node.js
function Test-SqliteFile([string]$FilePath) {
    $safe = $FilePath.Replace('\', '\\').Replace('"', '\"')
    $code = "try{var db=require('better-sqlite3')(`"$safe`",{readonly:true});var r=db.prepare('PRAGMA integrity_check').get();db.close();process.stdout.write(r&&r.integrity_check||'error');}catch(e){process.stdout.write('error');}"
    Push-Location $NewClawDir
    try {
        $result = node -e $code 2>$null
    } finally {
        Pop-Location
    }
    return $result -eq 'ok'
}

# ── 1. Localizar Backups ─────────────────────────────────────
function Get-BackupSelection {
    Write-Host "  Buscando backups disponíveis...`n" -ForegroundColor White

    $Entries = [System.Collections.Generic.List[PSObject]]::new()

    # ── Fonte 1: data/backups/ (Dashboard) ──────────────────
    if (Test-Path $DashboardBackups) {
        $dbFiles = Get-ChildItem -Path $DashboardBackups -File |
            Where-Object { $_.Name -match '^database-' -and $_.Extension -eq '.db' } |
            Sort-Object LastWriteTime -Descending

        foreach ($f in $dbFiles) {
            $isPreRestore = $f.Name -match 'pre-restore'
            $label = if ($isPreRestore) { "[Safety backup — antes de restore]" } else { "[Backup do Dashboard]" }
            $Entries.Add([PSCustomObject]@{
                DisplayName = $f.Name
                FullPath    = $f.FullName
                Source      = "Dashboard"
                Label       = $label
                IsDir       = $false
                ModTime     = $f.LastWriteTime
                SizeMB      = [math]::Round($f.Length / 1MB, 1)
            })
        }
    }

    # ── Fonte 2: ~/newclaw-backups (Instalador) ──────────────
    $ExtraPaths = @($BackupRoot)
    if (Test-Path $AltBackupRoot) { $ExtraPaths += $AltBackupRoot }

    foreach ($searchPath in $ExtraPaths) {
        if (-not (Test-Path $searchPath)) { continue }
        $items = Get-ChildItem -Path $searchPath |
            Where-Object { $_.Name -like "newclaw_*" } |
            Sort-Object LastWriteTime -Descending

        foreach ($item in $items) {
            $label = if ($item.PSIsContainer) { "[Backup completo — Instalador]" } else { "[Banco de dados — Instalador]" }
            $Entries.Add([PSCustomObject]@{
                DisplayName = $item.Name
                FullPath    = $item.FullName
                Source      = "Instalador"
                Label       = $label
                IsDir       = $item.PSIsContainer
                ModTime     = $item.LastWriteTime
                SizeMB      = if ($item.PSIsContainer) { 0 } else { [math]::Round($item.Length / 1MB, 1) }
            })
        }
    }

    if ($Entries.Count -eq 0) {
        Write-Host "  ⚠️  Nenhum backup encontrado em:" -ForegroundColor Yellow
        Write-Host "       $DashboardBackups" -ForegroundColor Gray
        foreach ($p in $ExtraPaths) { Write-Host "       $p" -ForegroundColor Gray }
        Write-Host ""
        Write-Host "  Dica: crie um backup pelo Dashboard (Configurações → Backup → Backup Manual)" -ForegroundColor Cyan
        exit 1
    }

    # Mostra lista com validação para arquivos .db
    Write-Host "  #   Arquivo / Pasta                              Fonte        Tamanho   Data" -ForegroundColor DarkGray
    Write-Host "  ─── ─────────────────────────────────────────── ──────────── ───────── ──────────────" -ForegroundColor DarkGray

    for ($i = 0; $i -lt $Entries.Count; $i++) {
        $e    = $Entries[$i]
        $num  = "[$($i + 1)]".PadRight(4)
        $name = $e.DisplayName.PadRight(48)
        $src  = $e.Source.PadRight(13)
        $size = if ($e.SizeMB -gt 0) { "$($e.SizeMB) MB".PadRight(10) } else { "—".PadRight(10) }
        $date = $e.ModTime.ToString("dd/MM/yy HH:mm")

        # Valida arquivos .db antes de exibir
        $valid = $true
        $validIcon = "✅"
        if (-not $e.IsDir -and $e.FullPath.EndsWith('.db')) {
            $valid = Test-SqliteFile $e.FullPath
            $validIcon = if ($valid) { "✅" } else { "❌" }
        }

        $color = if ($valid) { "White" } else { "DarkGray" }
        Write-Host "  $num $validIcon $name $src $size $date" -ForegroundColor $color

        if (-not $valid) {
            Write-Host "       └─ corrompido — não pode ser restaurado" -ForegroundColor DarkRed
        }
    }

    Write-Host ""
    $Choice = Read-Host "  Escolha o número (ou 'q' para sair)"

    if ($Choice -eq 'q') { exit 0 }

    $Index = 0
    if (-not [int]::TryParse($Choice, [ref]$Index)) { $Index = 0 }
    $Index -= 1

    if ($Index -lt 0 -or $Index -ge $Entries.Count) {
        Write-Host "  ❌ Opção inválida." -ForegroundColor Red
        exit 1
    }

    $selected = $Entries[$Index]

    # Bloqueia seleção de arquivo corrompido
    if (-not $selected.IsDir -and $selected.FullPath.EndsWith('.db')) {
        if (-not (Test-SqliteFile $selected.FullPath)) {
            Write-Host ""
            Write-Host "  ❌ O backup selecionado está corrompido. Escolha outro." -ForegroundColor Red
            exit 1
        }
    }

    return $selected
}

# ── 2. Preparar Restauração ──────────────────────────────────
function Prepare-Restore {
    Write-Host ""
    Write-Host "  ⚠️  A restauração irá sobrescrever os dados atuais em:" -ForegroundColor Yellow
    Write-Host "     $NewClawDir" -ForegroundColor Gray
    $Confirm = Read-Host "`n  Tem certeza que deseja continuar? [s/N]"
    if ($Confirm -notmatch "^[sSyY]$") { Write-Host "  Cancelado."; exit 0 }

    # Para o processo — funciona mesmo em crash loop (PM2 daemon continua, app para)
    Write-Host ""
    Write-Host "  🛑 Parando NewClaw..." -ForegroundColor Yellow
    try {
        $pm2 = Get-Command pm2 -ErrorAction SilentlyContinue
        if ($pm2) {
            pm2 stop newclaw 2>$null
        } else {
            $CliPath = Join-Path $NewClawDir "bin\newclaw"
            if (Test-Path $CliPath) { node $CliPath stop 2>$null }
        }
    } catch {}

    # Mata processos node residuais que possam estar segurando o .db
    Get-Process -Name "node" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -match "dist[\\/]index\.js" } |
        Stop-Process -Force -ErrorAction SilentlyContinue

    Start-Sleep -Milliseconds 500

    # Remove WAL/SHM para evitar corrupção na cópia
    Write-Host "  🧹 Limpando arquivos temporários do banco..." -ForegroundColor Gray
    @("data\newclaw.db-wal", "data\newclaw.db-shm") | ForEach-Object {
        $f = Join-Path $NewClawDir $_
        if (Test-Path $f) { Remove-Item $f -Force }
    }
}

# ── 3. Executar Restauração ──────────────────────────────────
function Invoke-Restore($Entry) {
    Write-Host ""
    Write-Host "  🚚 Restaurando: $($Entry.DisplayName)" -ForegroundColor Cyan
    $dataDir = Join-Path $NewClawDir "data"
    if (-not (Test-Path $dataDir)) { New-Item $dataDir -ItemType Directory | Out-Null }

    if ($Entry.IsDir) {
        # Backup completo (pasta do instalador)
        $map = @(
            @{ Src = "data\newclaw.db"; Dst = "data\newclaw.db"; Label = "Banco de dados" }
            @{ Src = "workspace";       Dst = "workspace";       Label = "Workspace" }
            @{ Src = "skills";          Dst = "skills";          Label = "Skills" }
            @{ Src = ".env";            Dst = ".env";            Label = "Configurações (.env)" }
        )
        foreach ($item in $map) {
            $src = Join-Path $Entry.FullPath $item.Src
            $dst = Join-Path $NewClawDir $item.Dst
            if (Test-Path $src) {
                if ((Get-Item $src).PSIsContainer) {
                    if (Test-Path $dst) { Remove-Item $dst -Recurse -Force }
                    Copy-Item $src -Destination $dst -Recurse -Force
                } else {
                    Copy-Item $src -Destination $dst -Force
                }
                Write-Host "    ✅ $($item.Label) restaurado." -ForegroundColor Green
            }
        }
    } else {
        # Arquivo .db simples (Dashboard ou instalador)
        $dst = Join-Path $dataDir "newclaw.db"
        Copy-Item $Entry.FullPath -Destination $dst -Force
        Write-Host "    ✅ Banco de dados restaurado." -ForegroundColor Green
    }
}

# ── Execução ─────────────────────────────────────────────────
Write-Banner
$Selected = Get-BackupSelection
Prepare-Restore
Invoke-Restore $Selected

Write-Host ""
Write-Host "  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Green
Write-Host "    ✨ Restauração concluída com sucesso!"     -ForegroundColor Green
Write-Host "  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Green
Write-Host ""
Write-Host "  🚀 Iniciando NewClaw..." -ForegroundColor Cyan

try {
    $pm2 = Get-Command pm2 -ErrorAction SilentlyContinue
    if ($pm2) {
        pm2 start (Join-Path $NewClawDir "ecosystem.config.cjs") 2>$null
        if ($LASTEXITCODE -ne 0) { pm2 restart newclaw 2>$null }
    } else {
        node (Join-Path $NewClawDir "bin\newclaw") start --daemon
    }
    Write-Host "  ✅ Sistema online. Verifique o dashboard." -ForegroundColor Green
} catch {
    Write-Host "  ⚠️  Inicie manualmente: pm2 restart newclaw" -ForegroundColor Yellow
}
Write-Host ""
