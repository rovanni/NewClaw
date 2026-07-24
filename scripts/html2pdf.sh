#!/bin/bash
# html2pdf.sh — Converte HTML para PDF com suporte a slides (JS-rendered)
# Uso: ./scripts/html2pdf.sh <arquivo.html|URL> [arquivo_saida.pdf] [--png]
# Detecta automaticamente: puppeteer-core+Chrome > puppeteer > Chrome headless > wkhtmltopdf
# Para slides: injeta CSS que força todos os slides visíveis e gera cada um em página separada
# (só no modo PDF — ver "Modo screenshot" abaixo).
#
# Modo screenshot (--png ou saída terminando em .png): tira um screenshot PNG em vez de
# gerar PDF. Aceita também URL (http/https) como entrada, além de arquivo local — usado pela
# revisão visual (Self Review), não só por documentos estáticos. Sem CSS de slides (não faz
# sentido forçar layout de apresentação num dashboard/webapp genérico) e sem fallback
# wkhtmltopdf (não tira screenshot, só gera PDF).

set -euo pipefail

INPUT=""
OUTPUT=""
MODE="pdf"

for ARG in "$@"; do
  case "$ARG" in
    --png) MODE="png" ;;
    *)
      if [ -z "$INPUT" ]; then INPUT="$ARG";
      elif [ -z "$OUTPUT" ]; then OUTPUT="$ARG";
      fi
      ;;
  esac
done

if [ -z "$INPUT" ]; then
  echo "ERRO: Uso: $0 <arquivo.html|URL> [arquivo_saida] [--png]" >&2
  exit 1
fi

# Entrada é URL (http/https) ou arquivo local?
IS_URL=0
if [[ "$INPUT" =~ ^https?:// ]]; then
  IS_URL=1
  PAGE_URL="$INPUT"
else
  if [ ! -f "$INPUT" ]; then
    echo "ERRO: Arquivo não encontrado: $INPUT" >&2
    exit 1
  fi
  INPUT="$(readlink -f "$INPUT")"
  PAGE_URL="file://$INPUT"
fi

# Saída termina em .png → modo screenshot, mesmo sem --png explícito
if [ -n "$OUTPUT" ] && [[ "$OUTPUT" == *.png ]]; then
  MODE="png"
fi

# Determinar saída
if [ -z "$OUTPUT" ]; then
  if [ "$IS_URL" -eq 1 ]; then
    echo "ERRO: informe o arquivo de saída explicitamente ao usar uma URL como entrada." >&2
    exit 1
  fi
  if [ "$MODE" = "png" ]; then
    OUTPUT="${INPUT%.html}.png"
  else
    OUTPUT="${INPUT%.html}.pdf"
  fi
else
  OUTPUT="$(readlink -f "$OUTPUT" 2>/dev/null || echo "$OUTPUT")"
fi

echo "INPUT: $INPUT"
echo "OUTPUT: $OUTPUT"
echo "MODE: $MODE"

export NODE_PATH="$(npm root -g 2>/dev/null):${NODE_PATH:-}"

# ── CSS para forçar slides visíveis no PDF — só faz sentido no modo PDF de apresentações,
#    nunca no modo screenshot (corromperia a captura de um dashboard/webapp genérico) ──
SLIDES_CSS='.slide,.step,section,[class*="slide"],[class*="step"]{display:block!important;visibility:visible!important;opacity:1!important;position:relative!important;page-break-after:always;}body,html{overflow:visible!important;height:auto!important;}*{animation:none!important;transition:none!important;}.slide.active,.slide:not(.active){display:block!important;}.progress-container,.progress-bar,.nav-buttons,.keyboard-hint{display:none!important;}'

# ── Método 1: puppeteer-core + Chrome instalado ──
convert_puppeteer_core() {
  node -e "
const puppeteer = require('puppeteer-core');
(async()=>{
  const browser = await puppeteer.launch({
    executablePath: '$(which google-chrome-stable 2>/dev/null || which google-chrome 2>/dev/null || which chromium 2>/dev/null || echo "")',
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--headless=new']
  });
  const page = await browser.newPage();
  await page.goto('$PAGE_URL',{waitUntil:'networkidle0',timeout:60000});
  if ('$MODE' === 'pdf') {
    await page.addStyleTag({content:'$SLIDES_CSS'});
    await page.pdf({path:'$OUTPUT',format:'A4',landscape:true,printBackground:true,
      margin:{top:'10mm',bottom:'10mm',left:'10mm',right:'10mm'}
    });
  } else {
    await page.setViewport({width:1920,height:1080});
    await page.screenshot({path:'$OUTPUT',fullPage:true});
  }
  await browser.close();
  console.log('ok');
})().catch(e=>{process.stderr.write(e.message+'\\n');process.exit(1)});
" 2>&1
}

# ── Método 2: puppeteer (com Chromium embutido) ──
convert_puppeteer() {
  node -e "
const puppeteer = require('puppeteer');
(async()=>{
  const browser = await puppeteer.launch({args:['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage']});
  const page = await browser.newPage();
  await page.goto('$PAGE_URL',{waitUntil:'networkidle0',timeout:60000});
  if ('$MODE' === 'pdf') {
    await page.addStyleTag({content:'$SLIDES_CSS'});
    await page.pdf({path:'$OUTPUT',format:'A4',landscape:true,printBackground:true,
      margin:{top:'10mm',bottom:'10mm',left:'10mm',right:'10mm'}});
  } else {
    await page.setViewport({width:1920,height:1080});
    await page.screenshot({path:'$OUTPUT',fullPage:true});
  }
  await browser.close();
  console.log('ok');
})().catch(e=>{process.stderr.write(e.message+'\\n');process.exit(1)});
" 2>&1
}

# ── Método 3: Chrome/Chromium headless direto ──
convert_chrome_headless() {
  local BIN=""
  for BIN in google-chrome-stable google-chrome chromium chromium-browser; do
    if command -v "$BIN" &>/dev/null; then
      if [ "$MODE" = "pdf" ]; then
        "$BIN" --headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage \
          --print-to-pdf="$OUTPUT" --print-to-pdf-no-header \
          "$PAGE_URL" 2>&1 && return 0
      else
        "$BIN" --headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage \
          --window-size=1920,1080 --screenshot="$OUTPUT" \
          "$PAGE_URL" 2>&1 && return 0
      fi
    fi
  done
  return 1
}

# ── Método 4: wkhtmltopdf (fallback, sem JS) — só existe para PDF, não tira screenshot ──
convert_wkhtmltopdf() {
  command -v wkhtmltopdf &>/dev/null || return 1
  local TMP="${OUTPUT%.pdf}_tmp.html"
  # Injetar CSS antes de </head> para forçar slides visíveis
  sed "s|</head>|<style>$SLIDES_CSS</style></head>|i" "$INPUT" > "$TMP"
  local RET=0
  wkhtmltopdf --orientation Landscape --quiet --enable-local-file-access "$TMP" "$OUTPUT" 2>&1 || RET=$?
  rm -f "$TMP"
  return $RET
}

# ── Tentar cada método em ordem de qualidade ──
USED_METHOD=""

# 1. puppeteer-core + Chrome (melhor qualidade, suporta JS)
if node -e "require('puppeteer-core')" 2>/dev/null && command -v google-chrome-stable &>/dev/null; then
  echo "Tentando: puppeteer-core + Chrome..."
  if convert_puppeteer_core; then
    SIZE=$(stat -c%s "$OUTPUT" 2>/dev/null || echo 0)
    if [ "$SIZE" -gt 1000 ]; then
      USED_METHOD="puppeteer-core+chrome"
    fi
  fi
fi

# 2. puppeteer com Chromium embutido
if [ -z "$USED_METHOD" ] && node -e "require('puppeteer')" 2>/dev/null; then
  echo "Tentando: puppeteer..."
  if convert_puppeteer; then
    SIZE=$(stat -c%s "$OUTPUT" 2>/dev/null || echo 0)
    if [ "$SIZE" -gt 1000 ]; then
      USED_METHOD="puppeteer"
    fi
  fi
fi

# 3. Chrome headless direto
if [ -z "$USED_METHOD" ]; then
  echo "Tentando: Chrome headless..."
  if convert_chrome_headless; then
    SIZE=$(stat -c%s "$OUTPUT" 2>/dev/null || echo 0)
    if [ "$SIZE" -gt 1000 ]; then
      USED_METHOD="chrome-headless"
    fi
  fi
fi

# 4. wkhtmltopdf (fallback, só no modo PDF)
if [ -z "$USED_METHOD" ] && [ "$MODE" = "pdf" ]; then
  echo "Tentando: wkhtmltopdf..."
  if convert_wkhtmltopdf; then
    SIZE=$(stat -c%s "$OUTPUT" 2>/dev/null || echo 0)
    if [ "$SIZE" -gt 1000 ]; then
      USED_METHOD="wkhtmltopdf"
      echo "AVISO: PDF gerado com wkhtmltopdf (sem JavaScript — slides animados podem não renderizar)"
    fi
  fi
fi

# ── Resultado final ──
if [ -n "$USED_METHOD" ] && [ -f "$OUTPUT" ] && [ "$(stat -c%s "$OUTPUT" 2>/dev/null || echo 0)" -gt 1000 ]; then
  FINAL_SIZE=$(stat -c%s "$OUTPUT")
  echo ""
  if [ "$MODE" = "png" ]; then
    echo "PNG_GERADO: $OUTPUT"
  else
    echo "PDF_GERADO: $OUTPUT"
  fi
  echo "METODO: $USED_METHOD"
  echo "TAMANHO: $FINAL_SIZE bytes"
  exit 0
else
  if [ "$MODE" = "png" ]; then
    echo "FALHA: cannot find puppeteer — nenhuma ferramenta de screenshot disponível. Instale com: npm install puppeteer" >&2
  else
    echo "FALHA: cannot find puppeteer — nenhuma ferramenta PDF disponível. Instale com: npm install puppeteer (ou wkhtmltopdf)." >&2
  fi
  exit 1
fi
