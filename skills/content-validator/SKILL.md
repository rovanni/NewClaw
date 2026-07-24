---
name: content-validator
description: Valida arquivos gerados (HTML, JS, Python, JSON) antes de enviar ao usuário, detectando erros de sintaxe e problemas comuns. Também faz revisão visual (Self Review) de artefatos renderizados — HTML, dashboards, slides, PDF — usando o modelo de visão já configurado.
version: "1.1"
triggers: erro, error, syntax error, não abre, não renderiza, diagrama, mermaid, broken, corrija, corrigir, verificar, validar, checar, revisar visualmente, ficou bom, qualidade visual, self review
tools: exec_command, read, edit, read_document
tags: validation, quality, syntax, check, debug, html, javascript, python, json, visual, screenshot, vision, self-review
---

# Content Validator Skill

Quando o usuário reportar erro em um arquivo gerado, ou quando você acabou de gerar um arquivo e quer verificá-lo antes de enviar, siga este protocolo.

## Protocolo de Validação Pós-Geração

Após salvar qualquer arquivo com `write`, execute a verificação correspondente ao tipo:

### Artefatos visuais (HTML renderizado, dashboard, slides, PDF, webapp) — Self Review

Quando o artefato gerado é algo que precisa ser *visto* pra saber se ficou bom — não só
sintaticamente válido — use este protocolo em vez de (ou além de) checar tags/sintaxe:

1. **Capturar screenshot** com o script já usado pra gerar PDF, em modo PNG:
   ```bash
   bash scripts/html2pdf.sh ARQUIVO.html screenshot.png --png
   # ou, para uma URL/webapp já rodando (ex: dashboard local):
   bash scripts/html2pdf.sh http://localhost:PORTA/caminho screenshot.png --png
   ```
   O script imprime `PNG_GERADO: <caminho>` quando funciona — use exatamente esse caminho no
   próximo passo.

2. **Pedir crítica ao modelo de visão** com `read_document`, passando um `prompt` — sem
   `prompt`, `read_document` faz OCR simples; com `prompt`, ele manda a imagem pro modelo de
   visão já configurado e devolve o texto da análise:
   ```
   read_document: filename="screenshot.png" prompt="Critique esta interface como um revisor de UI/UX exigente: layout, espaçamento, contraste, elementos cortados ou sobrepostos, texto ilegível, alinhamento quebrado. Se estiver bom o suficiente para entregar, diga 'APROVADO'. Se não, liste os problemas concretos a corrigir."
   ```

3. **Decidir com base na crítica.** Se a resposta indicar problemas reais (não só
   preferência estética menor), corrija o arquivo com `edit`/`write` e repita os passos 1-2.
   Se a resposta disser que está bom (ou os problemas apontados forem irrelevantes), finalize
   normalmente.

4. **Limite de rounds:** no máximo 3 ciclos de captura→crítica→correção para o mesmo artefato.
   Se depois de 3 rounds ainda não estiver aprovado, entregue o melhor resultado obtido e
   informe ao usuário quais problemas residuais o modelo de visão apontou — não trave o goal
   tentando atingir perfeição.

**Não usar este protocolo para:** validação de sintaxe (HTML com tags quebradas, JS/Python com
erro de sintaxe) — isso é mais rápido e mais barato com as checagens determinísticas abaixo.
Self Review é para julgamento de qualidade visual/layout, não para bugs estruturais.

### HTML com diagramas (Mermaid, KaTeX, etc.)

```bash
# Linux/macOS
# 1. Confirmar que o arquivo existe e tem tamanho razoável
ls -lh ARQUIVO.html

# 2. Verificar se tags principais estão fechadas
grep -c '</html>' ARQUIVO.html && grep -c '</body>' ARQUIVO.html

# 3. Contar blocos Mermaid e verificar sintaxe básica
grep -n 'class="mermaid"' ARQUIVO.html | head -20
```

```powershell
# Windows: grep/head/ls -lh não existem no shell padrão — use os cmdlets equivalentes
# (exec_command encaminha automaticamente comandos com cmdlets Verbo-Substantivo para powershell.exe)
Get-Item ARQUIVO.html | Select-Object Name, Length
(Select-String -Path ARQUIVO.html -Pattern '</html>').Count
(Select-String -Path ARQUIVO.html -Pattern '</body>').Count
Select-String -Path ARQUIVO.html -Pattern 'class="mermaid"' | Select-Object -First 20
```

Se o usuário reportar "Syntax error in text" do Mermaid, extraia o bloco problemático:

```bash
# Linux/macOS
grep -n -A 20 'class="mermaid"' ARQUIVO.html | head -100
```

```powershell
# Windows
Select-String -Path ARQUIVO.html -Pattern 'class="mermaid"' -Context 0,20 | Select-Object -First 100
```

<!-- TASK_ONLY_START -->
## Regras de Sintaxe por Tipo de Diagrama

### stateDiagram-v2 (autômatos, máquinas de estado)

**Correto:**
```
stateDiagram-v2
    [*] --> q0
    q0 --> q1 : 0
    q1 --> q2 : 1
    q2 --> [*]
```

**Proibido — causa "Syntax error in text":**
- Nomes com subscripts Unicode: `q₀`, `q₁` → use `q0`, `q1`
- Nomes com parênteses: `(q0)` → use `q0`
- Palavras reservadas como nomes: `end`, `state`, `note` → use `q_end`, `s_state`
- Caracteres matemáticos em identificadores: `δ`, `Σ`, `ε` → use `delta`, `Sigma`, `eps`
- Labels com setas textuais: `: →` → escreva só o símbolo (`: 0`, `: 1`)

**Estado inicial:** `[*] --> q0`
**Estado de aceitação:** `q_final --> [*]`

### graph LR / graph TD (fluxogramas)

**Correto:**
```
graph LR
    A["Texto com espaços"] -->|label| B
    B --> C["Outro nó"]
```

**Proibido:**
- Texto com parênteses sem aspas: `A(texto)` é um nó com bordas arredondadas — se o texto tiver caracteres especiais, use `A["texto"]`
- Labels de arestas com caracteres especiais: use texto simples em `|label|`

### Sequência (sequenceDiagram)

```
sequenceDiagram
    Alice->>Bob: mensagem
    Bob-->>Alice: resposta
```

- Participantes: apenas ASCII sem espaços ou use `participant "Nome Com Espaço" as alias`

## Correção de Erros Mermaid

Para corrigir um bloco com erro sem ler o arquivo inteiro:

```bash
# Linux/macOS
# 1. Localizar a linha do bloco com problema
grep -n 'class="mermaid"' ARQUIVO.html

# 2. Ver o conteúdo do bloco (substituir NNN pelo número da linha)
sed -n 'NNN,+30p' ARQUIVO.html
```

```powershell
# Windows
Select-String -Path ARQUIVO.html -Pattern 'class="mermaid"'
Get-Content ARQUIVO.html | Select-Object -Skip (NNN-1) -First 30
```

Depois use `edit` com `oldText`/`newText` para corrigir apenas o bloco problemático.
<!-- TASK_ONLY_END -->

### JavaScript / TypeScript

```bash
node --check arquivo.js
```

### Python

```bash
# Linux/macOS: binário costuma ser python3. Windows: costuma ser python (sem o "3").
# Se um comando falhar com "não é reconhecido"/"command not found", tente o outro nome.
python3 -m py_compile arquivo.py && echo "OK" || echo "ERRO DE SINTAXE"
```

### JSON

```bash
node -e "JSON.parse(require('fs').readFileSync('arquivo.json','utf8')); console.log('JSON válido')"
```

## Regra Geral

**NUNCA declare incapacidade de ler ou editar arquivos do workspace.** Se um arquivo existe no workspace, `read` e `edit` funcionam. Se não souber o caminho, use `exec_command` para localizá-lo: no Linux/macOS, `find . -iname "*nome*"`; no Windows, `Get-ChildItem -Recurse -Filter "*nome*"`.
