# ============================================================
#  NewClaw — Script de Atualização para Windows
#
#  Uso:
#    .\update.ps1
#    .\update.ps1 -Restart
#    .\update.ps1 -Force
#    .\update.ps1 -Channel preview
#    .\update.ps1 -Channel dev -Branch experimental/artifact-pipeline-refactor
#    .\update.ps1 -Check
#
#  Encaminhador fino: toda a lógica de atualização (fetch, canais, stash, build,
#  guard de self-update) vive em bin/newclaw (fonte única de verdade — ver
#  resolveUpdateChannel() lá). Este script só existe para quem já tinha o hábito
#  de rodar .\update.ps1 diretamente; ele nunca reimplementa git por conta própria.
# ============================================================

[CmdletBinding()]
param(
    [switch]$Restart,
    [switch]$Force,
    [switch]$Check,
    [string]$Channel,
    [string]$Branch,
    [switch]$Help
)

$DIR = Split-Path -Parent $MyInvocation.MyCommand.Path

if ($Help) {
    Write-Host @"
🪐 NewClaw — Atualizador para Windows

USO:
  .\update.ps1 [OPÇÕES]

OPÇÕES:
  -Restart              Reiniciar o NewClaw após a atualização
  -Force                Forçar atualização mesmo com mudanças locais
  -Check                Só verifica se há atualização (JSON, não muda nada)
  -Channel <canal>      stable | preview | dev
  -Branch <nome>        Branch a usar quando -Channel dev
  -Help                 Mostrar esta ajuda

Este script apenas encaminha para "node bin\newclaw update" — a lógica real
vive lá (fonte única de verdade, compartilhada com o Dashboard).

EXEMPLOS:
  .\update.ps1                                     # Atualizar e compilar (canal atual)
  .\update.ps1 -Restart                            # Atualizar e reiniciar
  .\update.ps1 -Channel dev -Branch minha-branch    # Trocar de canal e atualizar
"@
    exit 0
}

$cliArgs = @('update')
if ($Restart) { $cliArgs += 'restart' }
if ($Force)   { $cliArgs += '--force' }
if ($Check)   { $cliArgs += '--check' }
if ($Channel) { $cliArgs += "--channel=$Channel" }
if ($Branch)  { $cliArgs += "--branch=$Branch" }

& node (Join-Path $DIR 'bin\newclaw') @cliArgs
exit $LASTEXITCODE
