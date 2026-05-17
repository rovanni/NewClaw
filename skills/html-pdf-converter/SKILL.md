---
name: html-pdf-converter
description: Converte arquivos HTML para PDF usando a melhor ferramenta disponível no ambiente (Chromium, Puppeteer, wkhtmltopdf).
version: "2.0"
triggers: pdf, converter, gerar pdf, transformar em pdf, aula para pdf, slides para pdf, html para pdf, exportar pdf
tools: exec_command, send_document
---

# HTML to PDF Converter Skill

Converte HTML para PDF detectando automaticamente a ferramenta disponível no ambiente.

## Passo 1 — Identificar o arquivo HTML

Confirme o caminho exato do arquivo. Arquivos enviados pelo usuário ficam em `workspace/`.

```bash
ls workspace/*.html
```

## Passo 2 — Detectar ferramenta disponível e converter

Execute o script de detecção automática abaixo em **uma única chamada** de `exec_command`. Substitua `INPUT` e `OUTPUT` pelos caminhos reais:

```bash
INPUT="workspace/nome-do-arquivo.html"
OUTPUT="workspace/nome-do-arquivo.pdf"
ABS_INPUT="$(cd "$(dirname "$INPUT")" && pwd)/$(basename "$INPUT")"
ABS_OUTPUT="$(cd "$(dirname "$OUTPUT")" && pwd)/$(basename "$OUTPUT")"

# Opção 1: Chromium headless (mais comum em servidores Linux)
for BIN in google-chrome chromium-browser chromium google-chrome-stable; do
  if command -v "$BIN" &>/dev/null; then
    "$BIN" --headless --no-sandbox --disable-gpu \
      --print-to-pdf="$ABS_OUTPUT" \
      --print-to-pdf-no-header \
      "file://$ABS_INPUT" 2>&1 && echo "PDF gerado via $BIN" && exit 0
  fi
done

# Opção 2: Puppeteer (se instalado globalmente ou em node_modules)
for PDIR in "$(npm root -g 2>/dev/null)" "$(npm root 2>/dev/null)" "/usr/lib/node_modules"; do
  if [ -d "$PDIR/puppeteer" ]; then
    node -e "
const puppeteer = require('$PDIR/puppeteer');
const path = require('path');
(async () => {
  const b = await puppeteer.launch({args:['--no-sandbox','--disable-setuid-sandbox']});
  const p = await b.newPage();
  await p.goto('file://$ABS_INPUT', {waitUntil:'networkidle0', timeout:30000});
  await p.pdf({path:'$ABS_OUTPUT', format:'A4', landscape:true, printBackground:true,
    margin:{top:'10mm',bottom:'10mm',left:'10mm',right:'10mm'}});
  await b.close();
  console.log('PDF gerado via puppeteer');
})().catch(e=>{console.error(e.message);process.exit(1)});" && exit 0
  fi
done

# Opção 3: wkhtmltopdf
if command -v wkhtmltopdf &>/dev/null; then
  wkhtmltopdf --orientation Landscape "$ABS_INPUT" "$ABS_OUTPUT" 2>&1 && echo "PDF gerado via wkhtmltopdf" && exit 0
fi

echo "ERRO: Nenhuma ferramenta de PDF encontrada."
echo "Instale uma das opções: chromium-browser, puppeteer (npm install -g puppeteer), ou wkhtmltopdf"
exit 1
```

## Passo 3 — Verificar o resultado

```bash
ls -lh workspace/*.pdf
```

Se o arquivo PDF foi criado com tamanho > 0, prossiga para o envio.

## Passo 4 — Enviar

Use `send_document` com o caminho do PDF gerado.

## Tratamento de erros

| Erro | Solução |
|------|---------|
| "Nenhuma ferramenta encontrada" | Use a skill `system-provisioner` para instalar `chromium-browser` ou `puppeteer` |
| "Cannot find module 'puppeteer'" | `npm install -g puppeteer` via `system-provisioner` |
| PDF gerado mas vazio (0 bytes) | Tente outra ferramenta da lista ou aumente o timeout |
| "file not found" | Confirme o caminho exato com `ls workspace/` antes de converter |

## Regras

- **NUNCA** envie o conteúdo HTML ou PDF como texto — use sempre `send_document`.
- Se a conversão falhar, **informe o usuário** qual ferramenta está faltando e como instalar.
- Execute o script de detecção completo antes de desistir.
