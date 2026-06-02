---
name: html-pdf-converter
description: Converte arquivos HTML para PDF usando o script html2pdf.sh. Suporta slides com JavaScript. Detecta automaticamente a melhor ferramenta disponível.
version: "3.0"
triggers: pdf, converter, gerar pdf, transformar em pdf, aula para pdf, slides para pdf, html para pdf, exportar pdf
tools: exec_command, send_document
tags: pdf, convert, export, html, document, print, publish, slides
---

# HTML to PDF Converter

Converte HTML para PDF usando o script dedicado `scripts/html2pdf.sh`.

## ⚠️ REGRAS ABSOLUTAS — VIOLAÇÃO = FALHA CRÍTICA

1. **USE APENAS** o comando `bash scripts/html2pdf.sh <arquivo.html>`. **NUNCA** improvise scripts npm/node inline.
2. **NUNCA** envie arquivos `.html` via `send_document`. Envie **APENAS** o `.pdf`.
3. **NUNCA** leia o conteúdo do HTML. Use `ls` apenas para confirmar o nome.
4. **NUNCA** instale pacotes npm (`npm install puppeteer` etc.). O script já detecta tudo.
5. O script imprime `PDF_GERADO: <caminho>`. Use EXATAMENTE esse caminho no `send_document`.

---

## Passo 1 — Converter (UM comando apenas)

Execute o script com o caminho do arquivo HTML:

```
exec_command: bash scripts/html2pdf.sh NOME.html
```

**Substitua `NOME.html` pelo arquivo real.** Exemplo: `bash scripts/html2pdf.sh Aula_Analise_Lexica_Completa_03.html`

O script detecta automaticamente a melhor ferramenta (puppeteer-core+Chrome > puppeteer > wkhtmltopdf) e imprime:
```
PDF_GERADO: /caminho/completo/NOME.pdf
METODO: puppeteer-core+chrome
TAMANHO: 12345 bytes
```

---

## Passo 2 — Enviar o PDF

Use `send_document` com EXATAMENTE o caminho da linha `PDF_GERADO:`:

```
send_document: file_path="/caminho/impresso/PDF_GERADO"
```

Se a linha disser `AVISO: wkhtmltopdf`, informe o usuário que JavaScript pode não ter renderizado.

---

## O que NÃO fazer

- ❌ `npm install puppeteer && node -e "..."` — NUNCA improvise
- ❌ `send_document(file_path="arquivo.html")` — NUNCA envie .html
- ❌ Tentar múltiplos métodos manualmente — o script já faz isso
- ❌ Ler o conteúdo do HTML — não é necessário