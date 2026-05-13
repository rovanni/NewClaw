---
name: html-pdf-converter
description: Converte arquivos HTML e slides (Marp ou custom) para PDF usando Puppeteer Headless.
version: "1.0"
triggers: pdf, converter, gerar pdf, transformar em pdf, aula para pdf, slides para pdf, gerar slides
tools: exec_command, send_document, read_tool
---

# HTML to PDF Converter Skill (Puppeteer)

Esta skill permite que o NewClaw gere PDFs perfeitos de slides e documentos HTML, preservando fórmulas matemáticas e blocos de código.

## Fluxo de Execução

Quando o usuário pedir para gerar um PDF:

1. **Identificar o Arquivo**: Confirme o caminho do arquivo HTML no workspace. Se o usuário acabou de enviar, ele estará na raiz ou em `workspace/`.
2. **Análise de Formato**:
   - Se o HTML contém classes como `.slide` ou `display: none` (slides tradicionais), use o script `/tmp/html2pdf.cjs`.
   - Se o HTML for gerado pelo Marp (presença de tags `<svg>` grandes ou estilos Marp), use o script `/tmp/html2pdf-marp.cjs`.
3. **Execução do Puppeteer**:
   Execute o comando via `exec_command` (exemplo para slides tradicionais):
   ```bash
   node /tmp/html2pdf.cjs "workspace/seu-arquivo.html" "workspace/seu-arquivo.pdf"
   ```
4. **Tratamento de Erros**:
   - Se o comando falhar por falta do `puppeteer`, use a skill `system-provisioner` para instalar: `npm install -g puppeteer`.
   - Se os scripts em `/tmp` não forem encontrados, use `find /tmp -name "html2pdf*"` para localizá-los.
5. **Entrega**:
   Após a geração bem-sucedida, use a ferramenta `send_document` com o caminho do PDF gerado.

## Regras Críticas
- **NUNCA** envie o código do PDF ou HTML como texto.
- **MODO PAISAGEM**: O script Puppeteer já deve estar configurado para `landscape: true`.
- **WAIT FOR RENDER**: Certifique-se de que o script aguarda o carregamento total (networkidle0 ou timeout) para que fórmulas matemáticas apareçam.
