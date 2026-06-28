#!/bin/bash
# html2pdf.sh — Converte HTML para PDF com suporte a slides (JS-rendered)
# Uso: ./scripts/html2pdf.sh <arquivo.html> [arquivo_saida.pdf]
# Detecta automaticamente: puppeteer-core+Chrome > puppeteer > Chrome headless > wkhtmltopdf
# Para slides: injeta CSS que força todos os slides visíveis e gera cada um em página separada.

set -euo pipefail

INPUT="$1"
if [ -z "$INPUT" ]; then
  echo "ERRO: Uso: $0 <arquivo.html> [arquivo_saida.pdf]" >&2
  exit 1
fi

# Resolver caminho absoluto
if [ ! -f "$INPUT" ]; then
  echo "ERRO: Arquivo não encontrado: $INPUT" >&2
  exit 1
fi
INPUT="$(readlink -f "$INPUT")"

# Determinar saída
if [ -n "${2:-}" ]; then
  OUTPUT="$(readlink -f "$2" 2>/dev/null || echo "$2")"
else
  OUTPUT="${INPUT%.html}.pdf"
fi

echo "INPUT: $INPUT"
echo "OUTPUT: $OUTPUT"

export NODE_PATH="$(npm root -g 2>/dev/null):${NODE_PATH:-}"

# ── CSS para forçar slides visíveis no PDF ──
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
  await page.goto('file://$INPUT',{waitUntil:'networkidle0',timeout:60000});
  await page.addStyleTag({content:'$SLIDES_CSS'});
  await page.pdf({path:'$OUTPUT',format:'A4',landscape:true,printBackground:true,
    margin:{top:'10mm',bottom:'10mm',left:'10mm',right:'10mm'}
  });
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
  await page.goto('file://$INPUT',{waitUntil:'networkidle0',timeout:60000});
  await page.addStyleTag({content:'$SLIDES_CSS'});
  await page.pdf({path:'$OUTPUT',format:'A4',landscape:true,printBackground:true,
    margin:{top:'10mm',bottom:'10mm',left:'10mm',right:'10mm'}});
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
      "$BIN" --headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage \
        --print-to-pdf="$OUTPUT" --print-to-pdf-no-header \
        "file://$INPUT" 2>&1 && return 0
    fi
  done
  return 1
}

# ── Método 4: wkhtmltopdf (fallback, sem JS) ──
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

# 4. wkhtmltopdf (fallback)
if [ -z "$USED_METHOD" ]; then
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
  echo "PDF_GERADO: $OUTPUT"
  echo "METODO: $USED_METHOD"
  echo "TAMANHO: $FINAL_SIZE bytes"
  exit 0
else
  echo "FALHA: Nenhuma ferramenta PDF disponível. Instale puppeteer-core + google-chrome-stable ou wkhtmltopdf." >&2
  exit 1
fi