---
name: html-pdf-converter
description: Converte arquivos HTML para PDF. Detecta automaticamente a ferramenta disponível; em servidores Linux sem display usa Puppeteer com Chromium embutido.
version: "2.2"
triggers: pdf, converter, gerar pdf, transformar em pdf, aula para pdf, slides para pdf, html para pdf, exportar pdf
tools: exec_command, send_document
---

# HTML to PDF Converter Skill

Converte HTML para PDF detectando e instalando automaticamente a melhor ferramenta disponível.

## Contexto por ambiente

| Ambiente | Ferramenta recomendada |
|---|---|
| Ubuntu Server / VPS (sem display) | **Puppeteer** (Chromium embutido, via npm) |
| Desktop Linux com Chrome/Chromium | Chrome/Chromium headless |
| macOS | Chrome headless ou wkhtmltopdf |
| Windows | Chrome headless |

> **Ubuntu Server 24.04**: `chromium-browser` e `chromium` são wrappers Snap e não funcionam em muitas VPS (LXC/OpenVZ). Use Puppeteer.

---

## ⚠️ REGRAS GERAIS

1. **NUNCA improvise scripts npm/node.** Use APENAS o script de detecção automática abaixo.
2. **NUNCA envie o arquivo `.html`.** O `send_document` deve sempre usar o arquivo `.pdf`.
3. O script imprime `PDF_GERADO:` seguido do caminho completo. Use EXATAMENTE esse caminho no `send_document`.

<!-- TASK_ONLY_START -->
## ⚠️ REGRAS ADICIONAIS — APENAS durante conversão para PDF

4. **NÃO leia o conteúdo do arquivo HTML** — apenas confirme o nome com `ls`. A leitura do conteúdo é desnecessária para conversão e desperdiça contexto.
<!-- TASK_ONLY_END -->

---

## Passo 1 — Identificar o nome do arquivo HTML

```bash
ls *.html 2>/dev/null || ls workspace/*.html 2>/dev/null
```

Anote somente o nome base (sem extensão). Exemplo: se existir `slides.html`, o BASENAME é `slides`.

---

## Passo 2 — Converter (script de detecção automática)

Execute tudo em **uma única chamada** `exec_command`. Substitua `ARQUIVO` pelo nome base real (sem `.html`):

```bash
BASENAME="ARQUIVO"

# Detectar INPUT e OUTPUT
if [ -f "${BASENAME}.html" ]; then
  INPUT="$(pwd)/${BASENAME}.html"
  OUTPUT="$(pwd)/${BASENAME}.pdf"
elif [ -f "workspace/${BASENAME}.html" ]; then
  INPUT="$(pwd)/workspace/${BASENAME}.html"
  OUTPUT="$(pwd)/workspace/${BASENAME}.pdf"
else
  echo "ERRO: Arquivo ${BASENAME}.html não encontrado"
  exit 1
fi

echo "INPUT: $INPUT"
echo "OUTPUT: $OUTPUT"

convert_with_puppeteer() {
  local PDIR
  for PDIR in \
    "$(npm root -g 2>/dev/null)/puppeteer" \
    "$(npm root 2>/dev/null)/puppeteer" \
    "/usr/local/lib/node_modules/puppeteer" \
    "/usr/lib/node_modules/puppeteer"; do
    [ -d "$PDIR" ] || continue
    node -e "
const p=require('$PDIR');
(async()=>{
  const b=await p.launch({args:['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage']});
  const pg=await b.newPage();
  await pg.goto('file://$INPUT',{waitUntil:'networkidle0',timeout:30000});
  await pg.addStyleTag({content:[
    '.slide,.step,section,[class*=\"slide\"],[class*=\"step\"]{display:block!important;visibility:visible!important;opacity:1!important;position:relative!important;}',
    'body,html{overflow:visible!important;height:auto!important;}',
    '*{animation:none!important;transition:none!important;}'
  ].join('')});
  await pg.pdf({path:'$OUTPUT',format:'A4',landscape:true,printBackground:true,
    margin:{top:'10mm',bottom:'10mm',left:'10mm',right:'10mm'}});
  await b.close();
  console.log('ok');
})().catch(e=>{process.stderr.write(e.message+'\n');process.exit(1)});" 2>&1 && return 0
  done
  return 1
}

convert_with_chrome() {
  local BIN
  for BIN in google-chrome google-chrome-stable chromium chromium-browser; do
    command -v "$BIN" &>/dev/null || continue
    "$BIN" --headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage \
      --print-to-pdf="$OUTPUT" --print-to-pdf-no-header \
      "file://$INPUT" 2>&1 && return 0
  done
  return 1
}

convert_with_wkhtmltopdf() {
  command -v wkhtmltopdf &>/dev/null || return 1
  # wkhtmltopdf has no JavaScript — inject CSS to force all slides visible before converting
  local TMP="${OUTPUT%.pdf}_tmp_allslides.html"
  sed 's|</head>|<style>.slide,.step,section,[class*="slide"],[class*="step"]{display:block!important;visibility:visible!important;opacity:1!important;position:relative!important;}body,html{overflow:visible!important;height:auto!important;}*{animation:none!important;transition:none!important;}</style></head>|i' "$INPUT" > "$TMP"
  wkhtmltopdf --orientation Landscape --quiet "$TMP" "$OUTPUT" 2>&1
  local RET=$?
  rm -f "$TMP"
  return $RET
}

# Tentativa 1: Puppeteer instalado
if convert_with_puppeteer; then
  SIZE=$(stat -c%s "$OUTPUT" 2>/dev/null || echo 0)
  if [ "$SIZE" -gt 1000 ]; then
    echo "PDF_GERADO: $OUTPUT"
    exit 0
  fi
fi

# Tentativa 2: Chrome/Chromium do sistema
if convert_with_chrome; then
  SIZE=$(stat -c%s "$OUTPUT" 2>/dev/null || echo 0)
  if [ "$SIZE" -gt 1000 ]; then
    echo "PDF_GERADO: $OUTPUT"
    exit 0
  fi
fi

# Tentativa 3: wkhtmltopdf (sem suporte a JS — fallback)
if convert_with_wkhtmltopdf; then
  SIZE=$(stat -c%s "$OUTPUT" 2>/dev/null || echo 0)
  if [ "$SIZE" -gt 1000 ]; then
    echo "AVISO: PDF gerado com wkhtmltopdf (sem JavaScript — MathJax/KaTeX podem não renderizar)"
    echo "PDF_GERADO: $OUTPUT"
    exit 0
  fi
fi

# Nenhuma ferramenta encontrada — instalar Puppeteer automaticamente
echo "Nenhuma ferramenta PDF encontrada. Instalando Puppeteer (pode demorar ~2 min)..."
npm install -g puppeteer --loglevel=error 2>&1
if convert_with_puppeteer; then
  SIZE=$(stat -c%s "$OUTPUT" 2>/dev/null || echo 0)
  if [ "$SIZE" -gt 1000 ]; then
    echo "PDF_GERADO: $OUTPUT"
    exit 0
  fi
fi

echo "FALHA: Não foi possível gerar o PDF. Node.js/npm instalados? $(node --version 2>/dev/null || echo 'Node não encontrado')"
exit 1
```

---

## Passo 3 — Enviar o PDF

A linha `PDF_GERADO: <caminho>` no output acima indica o caminho exato do arquivo.

Use `send_document` com **EXATAMENTE** esse caminho:

```
send_document(file_path="<caminho da linha PDF_GERADO>")
```

**NÃO use o caminho do `.html`.**
**NÃO invente o caminho — use o que foi impresso.**

Se o `wkhtmltopdf` foi usado, avise o usuário que JavaScript (MathJax/KaTeX) pode não ter renderizado corretamente.

---

## Regras

- **NUNCA** improvise scripts npm inline (ex: `npm install puppeteer && node -e "..."`). Use o script acima integralmente.
- **NUNCA** envie o `.html` — envie APENAS o `.pdf` via `send_document`.
- **NUNCA** use `npm install puppeteer-core` ou `chromium-browser-headless` — esses pacotes não existem. O único correto é `puppeteer`.
- O flag `--no-sandbox` é necessário em servidores Linux sem display; é seguro em ambientes controlados.
- Se a instalação falhar, reporte claramente ao usuário o que está faltando.
