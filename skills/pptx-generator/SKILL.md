---
name: pptx-generator
description: Converte apresentações HTML ou Markdown em arquivos PowerPoint (.pptx) editáveis usando Marp CLI. Use quando o usuário pedir slides editáveis, PowerPoint, .pptx ou conversão de apresentação.
version: "1.0"
triggers: powerpoint, pptx, slides editáveis, apresentação editável, converter slides, marp, exportar pptx
tools: exec_command, write, read, send_document
tags: presentation, slides, export, office, document-generation, powerpoint, marp, convert
---

# PPTX Generator Skill

Converte conteúdo em arquivos PowerPoint (.pptx) editáveis usando **Marp CLI**.

## Passo 0 — Verificar Marp

Antes de qualquer conversão, verificar se o Marp está disponível:

```bash
marp --version
```

Se não estiver instalado, tentar instalar silenciosamente:

```bash
npm install -g @marp-team/marp-cli 2>/dev/null && marp --version
```

**Se a instalação falhar:** não mencionar o erro ao usuário e não revelar detalhes de infraestrutura (como "no servidor", "no ambiente", caminhos internos ou comandos de instalação). Usar automaticamente o fallback via `python-pptx` (Passo 0B) sem comentários.

## Passo 0B — Fallback via python-pptx (quando Marp indisponível)

Se o Marp não estiver disponível, gerar o `.pptx` diretamente via script Python usando `python-pptx`. Executar tudo em um único comando encadeado:

```bash
pip install python-pptx -q 2>/dev/null || pip install --break-system-packages python-pptx -q 2>/dev/null
python3 -c "
from pptx import Presentation
from pptx.util import Inches, Pt
# ... gerar slides a partir do conteúdo lido
"
```

**Nunca informar ao usuário que o Marp não estava disponível ou que foi usado um método alternativo** — simplesmente entregar o arquivo gerado.

## Passo 1 — Identificar o conteúdo fonte

Verificar o que está disponível no workspace:

```bash
ls -lh *.html *.md 2>/dev/null
```

### Caso A — Arquivo HTML de slides já existe no workspace

Extrair o conteúdo textual dos slides e converter para Markdown Marp:
- Identificar títulos (`<h1>`, `<h2>`, seções `<section>`)
- Separar slides por `---`
- Preservar listas, tabelas e destaques

### Caso B — Usuário fornece conteúdo novo

Estruturar diretamente como Markdown Marp (ver Passo 2).

## Passo 2 — Criar arquivo Markdown Marp

Salvar um arquivo `.md` no workspace com frontmatter Marp:

```markdown
---
marp: true
theme: gaia
paginate: true
size: 16:9
---

<!-- _class: lead -->

# Título da Apresentação

## Subtítulo

---

# Slide 2

- Ponto 1
- Ponto 2
- Ponto 3

---

# Slide 3 — Tabela

| Coluna A | Coluna B |
|----------|----------|
| Dado 1   | Dado 2   |
```

**Temas disponíveis:** `default` (limpo), `gaia` (colorido/moderno), `uncover` (negrito)

**Dica para aulas:** usar `theme: gaia` com `paginate: true`

## Passo 3 — Converter para .pptx

> **REGRA ABSOLUTA:** o arquivo de entrada (`.md`) deve vir ANTES de qualquer flag.
> O arquivo de entrada é OBRIGATÓRIO e deve preceder `--no-stdin`, `--pdf`, `-o` e demais opções.
> Formato correto: `marp entrada.md --no-stdin -o saida.pptx`
> Formato ERRADO: `marp --no-stdin -o saida.pptx` (sem arquivo) ou `marp --pdf entrada.md` (flag antes)

```bash
# Converter Markdown para PowerPoint (arquivo ANTES das flags)
marp slides.md -o apresentacao.pptx

# Com tema específico
marp slides.md --theme gaia -o apresentacao.pptx

# Verificar que o arquivo foi criado
ls -lh apresentacao.pptx
```

## Passo 4 — Verificar e enviar

```bash
# Confirmar tamanho razoável (deve ser > 10KB para ter conteúdo)
ls -lh apresentacao.pptx
```

Se o arquivo existir e tiver tamanho adequado, usar `send_document` para enviar ao usuário.

<!-- TASK_ONLY_START -->
## Referência de Sintaxe Marp

### Slide de título com destaque
```markdown
---
marp: true
theme: gaia
---

<!-- _class: lead -->
<!-- _backgroundColor: #2d3748 -->
<!-- _color: white -->

# Título Principal

## Subtítulo da apresentação

Nome do Autor — Data
```

### Duas colunas
```markdown
---
marp: true
style: |
  .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
---

# Layout em Colunas

<div class="cols">
<div>

## Esquerda
- Ponto A
- Ponto B

</div>
<div>

## Direita
- Ponto X
- Ponto Y

</div>
</div>
```

### Slide de código
```markdown
# Exemplo de Código

\`\`\`python
def saudacao(nome):
    return f"Olá, {nome}!"

print(saudacao("Turma"))
\`\`\`
```

### Directives por slide (aplica só a 1 slide)
```markdown
<!-- _backgroundColor: #f0f0f0 -->
<!-- _color: black -->
<!-- _paginate: false -->

# Slide Especial
```

## Conversão de HTML existente para Markdown Marp

Quando o arquivo HTML usa Reveal.js ou estrutura de seções:

```bash
# Ver estrutura do HTML
grep -n '<section\|<h1\|<h2\|<h3\|<li\|<p' arquivo.html | head -80
```

Extrair o conteúdo relevante e montar o .md manualmente, slide a slide.

## Erros comuns

| Erro | Solução |
|------|---------|
| `marp: command not found` | Usar fallback python-pptx (Passo 0B) sem informar o usuário |
| `.pptx` com 0 bytes | Verificar se o .md tem frontmatter `marp: true` |
| Slides sem separação | Adicionar `---` entre cada slide |
| Fonte não encontrada | Usar apenas fontes CSS padrão no `style:` |
<!-- TASK_ONLY_END -->

## Regra Geral

**Nunca declare que não é possível gerar .pptx.** O Marp está disponível no sistema ou pode ser instalado com um único comando npm. Se o usuário tem um HTML de slides, extraia o conteúdo e converta — não rejeite a tarefa sem tentar.
