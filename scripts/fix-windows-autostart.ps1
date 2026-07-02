# ============================================================
#  NewClaw — Corrige auto-início no Windows (Tarefa Agendada)
#
#  Para instalações EXISTENTES que ainda usam o Serviço Windows
#  nativo quebrado (ver install.ps1, Step-SetupWindowsService —
#  fix de 02/07/2026). Remove o serviço antigo (se existir) e
#  cria a Tarefa Agendada correta, sem precisar reinstalar do zero.
#
#  Por que o serviço antigo não funcionava: sc.exe create exige
#  que o processo lançado implemente o protocolo de controle de
#  serviço do Win32 (StartServiceCtrlDispatcher) e fique
#  residente respondendo ao SCM. `newclaw start` é um CLI comum
#  — dispara o PM2 (ou um processo destacado) e retorna — então
#  o SCM sempre marcava o serviço como "parou inesperadamente"
#  segundos depois de criado. O bot nunca voltava sozinho depois
#  de reiniciar o Windows.
#
#  Uso:
#    .\scripts\fix-windows-autostart.ps1
#    .\scripts\fix-windows-autostart.ps1 -Dir "C:\Users\SeuUsuario\NewClaw"
# ============================================================

[CmdletBinding()]
param(
    [string]$Dir = $(if ($env:NEWCLAW_HOME) { $env:NEWCLAW_HOME } else { "$env:USERPROFILE\NewClaw" })
)

function Write-Info([string]$msg)  { Write-Host "    ℹ  $msg" -ForegroundColor Cyan }
function Write-Ok([string]$msg)    { Write-Host "    ✅ $msg" -ForegroundColor Green }
function Write-Warn([string]$msg)  { Write-Host "    ⚠️  $msg" -ForegroundColor Yellow }
function Write-Fail([string]$msg)  { Write-Host "    ❌ $msg" -ForegroundColor Red }

Write-Host ""
Write-Host "  ━━━ NewClaw — Corrigir auto-início no Windows ━━━" -ForegroundColor Green
Write-Host ""

if (-not (Test-Path $Dir)) {
    Write-Fail "Diretório de instalação não encontrado: $Dir"
    Write-Info 'Informe o caminho correto: .\fix-windows-autostart.ps1 -Dir "C:\caminho\pro\NewClaw"'
    exit 1
}

$binPath = Join-Path $Dir "bin\newclaw"
if (-not (Test-Path $binPath)) {
    Write-Fail "bin\newclaw não encontrado em $Dir — não parece ser uma instalação válida do NewClaw."
    exit 1
}

$taskName = "NewClaw"

# Remove o Serviço Windows nativo, se existir (mecanismo quebrado, anterior a este fix).
$existingSvc = Get-Service -Name $taskName -ErrorAction SilentlyContinue
if ($existingSvc) {
    Write-Info "Removendo Serviço Windows antigo (quebrado)..."
    Stop-Service -Name $taskName -Force -ErrorAction SilentlyContinue
    sc.exe delete $taskName | Out-Null
    Write-Ok "Serviço antigo removido"
} else {
    Write-Info "Nenhum Serviço Windows antigo encontrado (ok)"
}

# Remove tarefa agendada pré-existente, se este script já tiver sido rodado antes (idempotente).
$existingTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existingTask) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
}

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    Write-Fail "node não encontrado no PATH — instale o Node.js antes de continuar."
    exit 1
}
$nodePath = $nodeCmd.Source

try {
    $action    = New-ScheduledTaskAction -Execute $nodePath -Argument "`"$binPath`" start" -WorkingDirectory $Dir
    $trigger   = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
    $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive
    $settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
        -Principal $principal -Settings $settings `
        -Description "NewClaw — Agente Cognitivo Local com Memória Semântica (inicia ao fazer logon)" `
        -ErrorAction Stop | Out-Null

    Write-Ok "Tarefa agendada '$taskName' criada!"
    Write-Info "NewClaw vai iniciar automaticamente no próximo logon."
    Write-Info "Gerenciar: taskschd.msc  ou  Get-ScheduledTask -TaskName $taskName"
    Write-Host ""
    Write-Info "Quer testar agora sem reiniciar? Rode: node `"$binPath`" start"
} catch {
    Write-Fail "Não foi possível criar a tarefa agendada: $($_.Exception.Message)"
    exit 1
}
