# ============================================================
#  newclaw — Instalador do Suplemento PowerPoint
#
#  Automatiza tudo que normalmente seria feito na mão:
#    1. npm install + build de produção
#    2. Confiar no certificado de desenvolvimento (uma vez por máquina)
#    3. Registrar o suplemento no PowerPoint (sem precisar de "Upload My Add-in")
#    4. Login no dashboard do newclaw e gravação do token localmente
#    5. Subir o servidor estático (dist/) via PM2, para não depender de terminal aberto
#
#  Uso:
#    .\install.ps1
#    .\install.ps1 -ServerUrl "http://127.0.0.1:3090"
#    .\install.ps1 -NoPm2      # não gerencia o servidor via PM2 (use "npm run serve" manualmente)
#    .\install.ps1 -Help
# ============================================================

[CmdletBinding()]
param(
    [string]$ServerUrl = "http://127.0.0.1:3090",
    [string]$Token = "",
    [switch]$NoPm2,
    [switch]$NonInteractive,
    [switch]$Help
)

if ([string]::IsNullOrEmpty($Token) -and -not [string]::IsNullOrEmpty($env:NEWCLAW_TOKEN)) {
    $Token = $env:NEWCLAW_TOKEN
}

$ErrorActionPreference = "Stop"
$AddinDir = $PSScriptRoot
$Pm2Name  = "newclaw-pptx-addin"

function Write-Banner {
    Write-Host ""
    Write-Host "  ============================================" -ForegroundColor Cyan
    Write-Host "   newclaw — Suplemento PowerPoint" -ForegroundColor Cyan
    Write-Host "       Instalador" -ForegroundColor Cyan
    Write-Host "  ============================================" -ForegroundColor Cyan
    Write-Host ""
}

function Write-Step([string]$msg) {
    Write-Host ""
    Write-Host "  --- $msg ---" -ForegroundColor Green
    Write-Host ""
}

function Write-Info([string]$msg) { Write-Host "    i  $msg" -ForegroundColor Cyan }
function Write-Ok([string]$msg)   { Write-Host "    OK $msg" -ForegroundColor Green }
function Write-Warn([string]$msg) { Write-Host "    !! $msg" -ForegroundColor Yellow }
function Write-Fail([string]$msg) { Write-Host "    XX $msg" -ForegroundColor Red }

function Test-Command([string]$cmd) {
    return [bool](Get-Command $cmd -ErrorAction SilentlyContinue)
}

function Pause-Exit([int]$code = 0) {
    Write-Host ""
    if (-not $NonInteractive) {
        Read-Host "  Pressione Enter para fechar"
    }
    exit $code
}

if ($Help) {
    Write-Host @"
newclaw — Instalador do Suplemento PowerPoint

USO:
  .\install.ps1 [OPÇÕES]

OPÇÕES:
  -ServerUrl URL   Endereço do dashboard do newclaw (padrão: http://127.0.0.1:3090)
  -Token TOKEN     Token de autenticação (evita prompt de senha)
  -NoPm2           Não gerenciar o servidor estático via PM2
  -NonInteractive  Não pausar a execução ao final
  -Help            Mostrar esta ajuda
"@
    exit 0
}

# ── Obter token de login (funciona também se o dashboard não tiver senha) ──
function Get-DashboardToken([string]$Url) {
    if ($Token) {
        Write-Ok "Usando token fornecido via parâmetro."
        return $Token
    }

    $maxAttempts = 3
    for ($i = 1; $i -le $maxAttempts; $i++) {
        if ($NonInteractive) {
            Write-Warn "Modo não interativo e sem token fornecido. Prosseguindo sem token."
            return ""
        }
        $securePw = Read-Host "    Senha do dashboard (Enter se o dashboard não tiver senha)" -AsSecureString
        $plainPw = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
            [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePw))

        try {
            $body = @{ password = $plainPw } | ConvertTo-Json
            $resp = Invoke-RestMethod -Uri "$Url/api/auth/login" -Method Post -Body $body `
                -ContentType "application/json" -TimeoutSec 10 -ErrorAction Stop

            if ($resp.success -and $resp.token) {
                if ($resp.token -eq "no-auth-required") {
                    Write-Ok "Dashboard sem senha configurada — nenhum token necessário."
                    return ""
                }
                Write-Ok "Login bem-sucedido — token obtido."
                return $resp.token
            }
        } catch {
            $statusCode = $null
            if ($_.Exception.Response) { $statusCode = [int]$_.Exception.Response.StatusCode }
            if ($statusCode -eq 401) {
                Write-Fail "Senha incorreta. Tente novamente ($i/$maxAttempts)."
            } else {
                Write-Fail "Não foi possível conectar em $Url ($($_.Exception.Message))"
                Write-Info "O newclaw está rodando? Confira com 'pm2 list'."
            }
        }
    }
    Write-Warn "Não foi possível obter um token. Configure depois manualmente na engrenagem do painel do suplemento."
    return ""
}

function Write-JsonNoBom([string]$Path, [string]$Content) {
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Content, $utf8NoBom)
}

# ── Main ─────────────────────────────────────────────────────

try {
    Write-Banner
    Push-Location $AddinDir

    # 1/6 — Node.js
    Write-Step "1/6 — Verificando Node.js"
    if (-not (Test-Command "node")) {
        Write-Fail "Node.js não encontrado no PATH. Instale antes de continuar: https://nodejs.org"
        Pause-Exit 1
    }
    Write-Ok "Node.js: $(node --version)"

    # 2/6 — Dependências + build de produção
    Write-Step "2/6 — Instalando dependências e compilando"
    Write-Info "npm install (pode demorar na 1ª vez)..."
    npm install
    if ($LASTEXITCODE -ne 0) { throw "npm install falhou (exit code $LASTEXITCODE)" }
    Write-Ok "Dependências instaladas."

    Write-Info "npm run build..."
    npm run build
    if ($LASTEXITCODE -ne 0) { throw "npm run build falhou (exit code $LASTEXITCODE)" }
    Write-Ok "Build de produção pronto em dist/."

    # 3/6 — Certificado de desenvolvimento
    Write-Step "3/6 — Certificado de desenvolvimento (https://localhost:3000)"
    Write-Info "Se esta for a 1ª vez nesta máquina, o Windows pode pedir para confirmar a instalação do certificado."
    npx office-addin-dev-certs install
    if ($LASTEXITCODE -ne 0) { throw "Falha ao confiar no certificado de desenvolvimento (exit code $LASTEXITCODE)" }
    Write-Ok "Certificado confiado."

    # 4/6 — Registrar o suplemento no PowerPoint
    Write-Step "4/6 — Registrando o suplemento no PowerPoint"
    Write-Info "Isso faz o botão 'newclaw' aparecer na guia HOME sem precisar de Upload My Add-in."
    npm run register
    if ($LASTEXITCODE -ne 0) {
        Write-Warn "Não foi possível registrar automaticamente (exit code $LASTEXITCODE)."
        Write-Info "Alternativa manual: PowerPoint > Inserir > Suplementos > Carregar Meu Suplemento > manifest.xml"
    } else {
        Write-Ok "Suplemento registrado. Feche e reabra o PowerPoint para ver o botão 'newclaw'."
    }

    # 5/6 — Login no dashboard e gravação do token
    Write-Step "5/6 — Conectando ao dashboard do newclaw"
    Write-Info "Servidor: $ServerUrl"
    $token = Get-DashboardToken $ServerUrl
    $configPath = Join-Path $AddinDir "config.local.json"
    $configJson = (@{ serverUrl = $ServerUrl; token = $token } | ConvertTo-Json)
    Write-JsonNoBom $configPath $configJson
    Write-Ok "Configuração salva em config.local.json."

    # Reempacota o build para incluir o config.local.json recém-gerado
    Write-Info "Recompilando para incluir a configuração..."
    npm run build
    if ($LASTEXITCODE -ne 0) { throw "npm run build (2ª passada) falhou (exit code $LASTEXITCODE)" }

    # 6/6 — Servidor estático via PM2
    Write-Step "6/6 — Subindo o servidor do suplemento"
    if ($NoPm2) {
        Write-Info "Pulado (-NoPm2). Rode manualmente com: npm run serve"
    } elseif (-not (Test-Command "pm2")) {
        Write-Warn "PM2 não encontrado no PATH. Instale com 'npm install -g pm2' ou rode manualmente: npm run serve"
    } else {
        pm2 delete $Pm2Name 2>&1 | Out-Null
        pm2 start server.js --name $Pm2Name --cwd $AddinDir
        if ($LASTEXITCODE -ne 0) {
            Write-Warn "Não foi possível subir o servidor via PM2 (exit code $LASTEXITCODE)."
            Write-Info "Verifique se a porta 3000 já está em uso por outro processo (ex: 'npm run dev-server' rodando em outro terminal)."
        } else {
            pm2 save | Out-Null
            Write-Ok "Servidor rodando via PM2 como '$Pm2Name' em https://localhost:3000."
        }
    }

    Write-Host ""
    Write-Host "  ================================================" -ForegroundColor Green
    Write-Host "   Suplemento newclaw instalado!" -ForegroundColor Green
    Write-Host "  ================================================" -ForegroundColor Green
    Write-Host ""
    Write-Host "    Abra (ou reabra) o PowerPoint e procure o botão 'newclaw' na guia HOME." -ForegroundColor Cyan
    Write-Host "    Gerenciar o servidor: pm2 logs $Pm2Name  /  pm2 restart $Pm2Name" -ForegroundColor Cyan
    Write-Host ""
    Pop-Location
} catch {
    Pop-Location -ErrorAction SilentlyContinue
    Write-Fail "Instalação falhou: $_"
    Pause-Exit 1
}
