---
name: html-pdf-converter
description: Converte arquivos HTML para PDF. Detecta automaticamente a ferramenta disponível; em servidores Linux sem display usa Puppeteer com Chromium embutido.
version: "2.1"
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

## Passo 1 — Identificar o arquivo HTML

```bash
ls workspace/*.html
```

Anote o nome exato do arquivo.

---

## Passo 2 — Converter (script de detecção automática)

Execute tudo em **uma única chamada** `exec_command`. Substitua `ARQUIVO` pelo nome real:

```bash
BASENAME="ARQUIVO"
INPUT="$(pwd)/../workspace/${BASENAME}.html"
OUTPUT="$(pwd)/../workspace/${BASENAME}.pdf"

# Se exec_command já roda dentro do workspace, ajuste:
[ -f "${BASENAME}.html" ] && INPUT="$(pwd)/${BASENAME}.html" && OUTPUT="$(pwd)/${BASENAME}.pdf"

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
  wkhtmltopdf --orientation Landscape --quiet "$INPUT" "$OUTPUT" 2>&1
}

# Tentativa 1: Puppeteer instalado
if convert_with_puppeteer; then
  echo "PDF gerado com Puppeteer: $OUTPUT"
  exit 0
fi

# Tentativa 2: Chrome/Chromium do sistema
if convert_with_chrome; then
  echo "PDF gerado com Chrome headless: $OUTPUT"
  exit 0
fi

# Tentativa 3: wkhtmltopdf (sem suporte a JS — fallback)
if convert_with_wkhtmltopdf; then
  echo "PDF gerado com wkhtmltopdf (sem JavaScript): $OUTPUT"
  exit 0
fi

# Nenhuma ferramenta encontrada — instalar Puppeteer automaticamente
echo "Nenhuma ferramenta PDF encontrada. Instalando Puppeteer (pode demorar ~2 min)..."
npm install -g puppeteer --loglevel=error 2>&1
if convert_with_puppeteer; then
  echo "PDF gerado com Puppeteer (recém instalado): $OUTPUT"
  exit 0
fi

echo "FALHA: Não foi possível gerar o PDF. Verifique se Node.js e npm estão instalados."
exit 1
```

---

## Passo 3 — Verificar resultado

```bash
ls -lh workspace/*.pdf
```

O PDF deve existir com tamanho > 0. Se o arquivo for 0 bytes, a conversão falhou silenciosamente.

---

## Passo 4 — Enviar

Use `send_document` com o caminho completo do PDF.

---

## Regras

- **NUNCA** envie o conteúdo HTML ou texto do PDF — use sempre `send_document`.
- Se a instalação automática falhar, reporte claramente ao usuário o que falta instalar e como instalar.
- `wkhtmltopdf` não executa JavaScript — evite usá-lo para HTML com MathJax, KaTeX ou CSS moderno. Informe o usuário caso seja a única opção disponível.
- O flag `--no-sandbox` é necessário em servidores Linux sem display; é seguro em ambientes controlados.
