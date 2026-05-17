---
name: html-pdf-converter
description: Converte arquivos HTML e slides (Marp ou custom) para PDF usando Puppeteer Headless.
version: "1.1"
triggers: pdf, converter, gerar pdf, transformar em pdf, aula para pdf, slides para pdf, gerar slides
tools: exec_command, send_document, read_tool
---

# HTML to PDF Converter Skill (Puppeteer)

Esta skill converte slides e documentos HTML para PDF preservando fórmulas matemáticas e blocos de código.

## Fluxo de Execução

### 1. Identificar o Arquivo

Confirme o caminho do HTML no workspace (ex: `workspace/02-Teoria_Computacao_AF.html`).

### 2. Criar o Script Puppeteer (se não existir)

**SEMPRE execute isso primeiro.** O script precisa existir em `/tmp/html2pdf.cjs`:

```bash
cat > /tmp/html2pdf.cjs << 'PUPPETEER_EOF'
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

(async () => {
  const [,, input, output] = process.argv;
  if (!input || !output) { console.error('Usage: node html2pdf.cjs <input.html> <output.pdf>'); process.exit(1); }
  const absInput = path.resolve(input);
  if (!fs.existsSync(absInput)) { console.error('File not found: ' + absInput); process.exit(1); }
  const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  await page.goto('file://' + absInput, { waitUntil: 'networkidle0', timeout: 30000 });
  await page.pdf({
    path: path.resolve(output),
    format: 'A4',
    landscape: true,
    printBackground: true,
    margin: { top: '10mm', bottom: '10mm', left: '10mm', right: '10mm' }
  });
  await browser.close();
  console.log('PDF gerado: ' + path.resolve(output));
})();
PUPPETEER_EOF
```

### 3. Verificar Puppeteer

```bash
node -e "require('puppeteer')" 2>&1 || npm install -g puppeteer
```

### 4. Executar a Conversão

```bash
node /tmp/html2pdf.cjs "workspace/02-Teoria_Computacao_AF.html" "workspace/02-Teoria_Computacao_AF.pdf"
```

### 5. Verificar e Enviar

```bash
ls -lh workspace/*.pdf
```

Então use `send_document` com o caminho completo do PDF gerado.

## Regras Críticas

- **CRIE o script antes de executar** — `/tmp` é limpo em reboots, o script pode não existir.
- **NUNCA** envie o conteúdo HTML/PDF como texto.
- Se puppeteer falhar (`Cannot find module`), use a skill `system-provisioner` para instalar: `npm install -g puppeteer`.
- O script já configura `landscape: true` e `printBackground: true`.
- Use `networkidle0` para garantir que fórmulas matemáticas (MathJax/KaTeX) sejam renderizadas.
