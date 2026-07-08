# ============================================================
#  newclaw - Desinstalador do Suplemento PowerPoint
#
#  Desfaz o que foi feito na instalacao:
#    1. Remove o registro do suplemento no PowerPoint
#    2. Para e deleta o processo do PM2
# ============================================================

$ErrorActionPreference = "Stop"
$AddinDir = $PSScriptRoot
$Pm2Name  = "newclaw-pptx-addin"

Write-Host "Desinstalando o suplemento PowerPoint..." -ForegroundColor Cyan

Push-Location $AddinDir

try {
    Write-Host "Removendo registro do PowerPoint..." -ForegroundColor Green
    npx office-addin-dev-settings unregister manifest.xml
} catch {
    Write-Host "Aviso: Falha ao remover registro (pode ja estar removido)." -ForegroundColor Yellow
}

try {
    Write-Host "Parando o processo PM2 ($Pm2Name)..." -ForegroundColor Green
    try { pm2 delete $Pm2Name 2>&1 | Out-Null } catch { }
    pm2 save | Out-Null
} catch {
    Write-Host "Aviso: Falha ao remover do PM2 (pode nao estar rodando)." -ForegroundColor Yellow
}

Write-Host "Desinstalacao concluida." -ForegroundColor Cyan
Pop-Location
exit 0



