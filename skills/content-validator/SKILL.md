---
name: content-validator
description: Valida arquivos gerados (HTML, JS, Python, JSON) antes de enviar ao usuário, detectando erros de sintaxe e problemas comuns.
version: "1.0"
triggers: erro, error, syntax error, não abre, não renderiza, diagrama, mermaid, broken, corrija, corrigir, verificar, validar, checar
tools: exec_command, read, edit
tags: validation, quality, syntax, check, debug, html, javascript, python, json
---

# Content Validator Skill

Quando o usuário reportar erro em um arquivo gerado, ou quando você acabou de gerar um arquivo e quer verificá-lo antes de enviar, siga este protocolo.

## Protocolo de Validação Pós-Geração

Após salvar qualquer arquivo com `write`, execute a verificação correspondente ao tipo:

### HTML com diagramas (Mermaid, KaTeX, etc.)

```bash
# 1. Confirmar que o arquivo existe e tem tamanho razoável
ls -lh ARQUIVO.html

# 2. Verificar se tags principais estão fechadas
grep -c '</html>' ARQUIVO.html && grep -c '</body>' ARQUIVO.html

# 3. Contar blocos Mermaid e verificar sintaxe básica
grep -n 'class="mermaid"' ARQUIVO.html | head -20
```

Se o usuário reportar "Syntax error in text" do Mermaid, extraia o bloco problemático:

```bash
# Encontrar e exibir os blocos mermaid do arquivo
grep -n -A 20 'class="mermaid"' ARQUIVO.html | head -100
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
# 1. Localizar a linha do bloco com problema
grep -n 'class="mermaid"' ARQUIVO.html

# 2. Ver o conteúdo do bloco (substituir NNN pelo número da linha)
sed -n 'NNN,+30p' ARQUIVO.html
```

Depois use `edit` com `oldText`/`newText` para corrigir apenas o bloco problemático.
<!-- TASK_ONLY_END -->

### JavaScript / TypeScript

```bash
node --check arquivo.js
```

### Python

```bash
python3 -m py_compile arquivo.py && echo "OK" || echo "ERRO DE SINTAXE"
```

### JSON

```bash
node -e "JSON.parse(require('fs').readFileSync('arquivo.json','utf8')); console.log('JSON válido')"
```

## Regra Geral

**NUNCA declare incapacidade de ler ou editar arquivos do workspace.** Se um arquivo existe no workspace, `read` e `edit` funcionam. Se não souber o caminho, use `find . -iname "*nome*"` para localizá-lo.
