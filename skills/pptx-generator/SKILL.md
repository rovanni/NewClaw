---
name: pptx-generator
description: Converte Markdown ou HTML em arquivos PowerPoint (.pptx). Ativar APENAS quando o usuário pedir explicitamente .pptx, PowerPoint ou um arquivo editável no formato Office. NÃO ativar para pedidos genéricos de "slides" ou "apresentação" sem formato específico. Quando o pedido exigir texto REALMENTE editável (não apenas um .pptx que abre no PowerPoint), usar o caminho python-pptx (Passo 0B), não o Marp CLI — ver aviso abaixo.
version: "1.1"
triggers: powerpoint, pptx, arquivo pptx, slides powerpoint, slides em pptx, apresentação editável, exportar pptx, marp, converter para pptx
tools: exec_command, write, read, send_document
tags: export, office, document-generation, powerpoint, marp, convert
---

# PPTX Generator Skill

Converte conteúdo em arquivos PowerPoint (.pptx) usando **Marp CLI** ou **python-pptx**,
dependendo do que o usuário realmente precisa (ver aviso abaixo).

## ⚠️ AVISO IMPORTANTE: o `.pptx` gerado pelo Marp CLI NÃO é editável

**Verificado diretamente no arquivo gerado (não é suposição):** o Marp CLI renderiza cada slide
como uma imagem PNG de página inteira e a embute como plano de fundo do slide
(`<p:bg><p:bgPr><a:blipFill>`). O `<p:spTree>` (árvore de formas) fica vazio — zero caixas de
texto, zero `<a:t>`. O arquivo abre normalmente no PowerPoint e parece correto visualmente, mas
**nenhum texto pode ser clicado ou editado** — é uma imagem por slide, não uma apresentação
nativa.

**Isso significa:**
- Se o usuário pedir só "gerar um .pptx" ou "exportar para PowerPoint" (sem enfatizar edição),
  o Marp CLI (Passo 1-4 abaixo) é aceitável — é rápido e o resultado abre e projeta bem.
- Se o usuário pedir explicitamente algo **editável** ("slides editáveis", "quero poder mudar o
  texto depois", "preciso editar no PowerPoint"), **use python-pptx desde o início (Passo 0B)**
  — não tente o Marp CLI primeiro. Gerar via Marp e descobrir depois que não é editável só
  desperdiça um ciclo inteiro.
- **Se o usuário já recebeu um `.pptx` (gerado por este skill ou não) e disser que "não está
  editando", "não consigo mudar o texto", ou algo equivalente**: NÃO gere de novo com Marp CLI —
  o resultado será idêntico (imagem por slide). Vá direto para o Passo 0B (python-pptx).

## Passo 0 — Verificar Marp (apenas se for usar o caminho Marp CLI)

Antes de qualquer conversão, verificar se o Marp está disponível:

```bash
marp --version
```

Se não estiver instalado, tentar instalar silenciosamente:

```bash
npm install -g @marp-team/marp-cli 2>/dev/null && marp --version
```

**Se a instalação falhar:** não mencionar o erro ao usuário e não revelar detalhes de infraestrutura (como "no servidor", "no ambiente", caminhos internos ou comandos de instalação). Usar automaticamente o fallback via `python-pptx` (Passo 0B) sem comentários.

## Passo 0B — python-pptx (quando o usuário precisa de texto realmente editável, ou quando o Marp está indisponível)

Para gerar um `.pptx` com texto nativo editável — ou quando o Marp não está disponível — usar um script Python com `python-pptx`.

**REGRA CRÍTICA:** escrever o script com `write` **não é o fim da tarefa**. O arquivo `.pptx`
só existe depois que o script for **executado** com `exec_command`. Uma resposta que diz "gerei
os slides" sem antes ter rodado o script é uma alucinação — o usuário não recebeu nada. Sempre
faça: `write` do script → `exec_command` para rodá-lo → confirmar que o `.pptx` foi criado →
`send_document`.

**REGRA:** NUNCA usar `python3 -c "..."` com código multilinha — o shell trunca o conteúdo.
Sempre criar o script em arquivo separado e depois executar:

**Passo 0B.1** — Instalar a lib (se necessário):

```bash
pip install python-pptx -q 2>/dev/null || pip install --break-system-packages python-pptx -q 2>/dev/null
```

**Passo 0B.2** — Usar `write` para salvar o script com um nome **ÚNICO derivado do assunto/arquivo
de origem** — NUNCA use o nome genérico `tmp/gerar_pptx.py` nem a saída genérica
`apresentacao.pptx`. O workspace é persistente entre conversas: um script ou script
`tmp/gerar_pptx.py` de uma tarefa anterior (outro assunto, outra aula) continua no disco, e se
outro step do mesmo plano (ex: um step separado de `exec_command` que segue esta receita ao pé
da letra) rodar `python3 tmp/gerar_pptx.py` sem saber que o nome mudou, ele executa o script
ERRADO — silenciosamente gerando/enviando o arquivo da tarefa antiga. Use o mesmo padrão de nome
em todos os lugares (script E saída), ex. para uma aula sobre DHCP: `tmp/gerar_pptx_dhcp.py` →
`aula_dhcp.pptx`.

```python
from pptx import Presentation
from pptx.util import Inches, Pt

prs = Presentation()
# ... gerar slides a partir do conteúdo
prs.save('NOME_UNICO_DO_ASSUNTO.pptx')  # ex: 'aula_dhcp.pptx' — nunca 'apresentacao.pptx'
```

**Passo 0B.3** — Executar via `exec_command`, usando o MESMO nome único do Passo 0B.2:

```bash
python3 tmp/gerar_pptx_NOME_UNICO_DO_ASSUNTO.py
```

**Nunca informar ao usuário que o Marp não estava disponível ou que foi usado um método alternativo** — simplesmente entregar o arquivo gerado.

### Passo 0B.4 — Aplicando o tema "academico" via python-pptx

Se o usuário pediu texto editável **e** escolheu o tema `academico` (ver seção de temas abaixo),
replique a paleta e o layout com estas constantes — mantém o resultado visualmente consistente
com o mesmo tema do caminho Marp:

```python
from pptx.dml.color import RGBColor
from pptx.util import Pt

NAVY = RGBColor(0x16, 0x3A, 0x5F)       # fundo de capa/divisores, cabeçalho de tabela
NAVY_DARK = RGBColor(0x0F, 0x29, 0x42)  # slide de encerramento
RED = RGBColor(0xE8, 0x42, 0x5F)        # barra sob o título, subtítulos em destaque
GRAY_BG = RGBColor(0xF4, 0xF6, 0xF9)    # linhas pares de tabela (zebra)
GRAY_TEXT = RGBColor(0x6B, 0x72, 0x80)  # rodapé

# Slide de capa/divisor: fundo NAVY, título branco, subtítulo RED
# Slide de conteúdo: fundo branco, título NAVY com uma forma retangular fina RED
#   logo abaixo (simula a barra vermelha do tema Marp), texto padrão #1F2933
# Tabelas: primeira linha (cabeçalho) com fill NAVY e fonte branca; linhas
#   pares com fill GRAY_BG
# Rodapé: caixa de texto pequena (Pt(11), GRAY_TEXT) no rodapé de cada slide,
#   com o texto que o usuário informou (ex: "CÓDIGO — Disciplina | Aula N | Professor")
```

---

## Passos 1-4 — Caminho Marp CLI (rápido, mas NÃO gera texto editável — ver aviso no topo)

Use este caminho apenas quando o usuário não pediu explicitamente edição de texto, ou quando
ainda não tentou e falhou com o Marp CLI antes.

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

**Temas disponíveis:**
- `default` (limpo), `gaia` (colorido/moderno), `uncover` (negrito) — temas nativos do Marp
- `academico` — tema institucional customizado deste skill (capa/divisores em fundo azul-marinho,
  título com barra vermelha, tabelas com cabeçalho escuro, rodapé fixo). Definido em
  `skills/pptx-generator/themes/academico.css` — ver Passo 3 para o comando de conversão.

**Se o pedido não especificar tema** (ex: só "gera os slides da aula"), pergunte ao usuário se
prefere `gaia` (padrão, rápido) ou `academico` (visual institucional formal) antes de gerar — não
escolha silenciosamente por ele. Se o usuário já citar o nome de um tema, use-o direto sem
perguntar.

**Dica para aulas (tema gaia):** usar `theme: gaia` com `paginate: true`

**Usando o tema `academico`:** além de `theme: academico` no frontmatter, use as diretivas abaixo
para reproduzir capa/divisores/rodapé:

```markdown
---
marp: true
theme: academico
paginate: true
size: 16:9
footer: "CÓDIGO — Nome da Disciplina | Aula N | Nome do Professor"
---

<!-- _class: lead -->

# Título da Aula

## Subtítulo

---

<!-- _class: divider -->

# Parte 1

## Nome da Seção

---

# Slide de Conteúdo Normal

- 📦 Ponto com ícone (emoji funciona bem neste tema, no lugar dos ícones do PDF original)
- 🔄 Outro ponto
```

## Passo 3 — Converter para .pptx

> **REGRA ABSOLUTA:** o arquivo de entrada (`.md`) deve vir ANTES de qualquer flag.
> O arquivo de entrada é OBRIGATÓRIO e deve preceder `--no-stdin`, `--pdf`, `-o` e demais opções.
> Formato correto: `marp entrada.md --no-stdin -o saida.pptx`
> Formato ERRADO: `marp --no-stdin -o saida.pptx` (sem arquivo) ou `marp --pdf entrada.md` (flag antes)

> Use nomes derivados do assunto (para o `.md` de entrada E o `.pptx` de saída), nunca genéricos
> como `slides.md`/`apresentacao.pptx` — o workspace persiste entre conversas, e um nome genérico
> pode coincidir com um arquivo de uma tarefa antiga e diferente.

```bash
# Converter Markdown para PowerPoint (arquivo ANTES das flags) — nomes de exemplo, adapte ao assunto
marp aula_dhcp.md -o aula_dhcp.pptx

# Com tema nativo específico
marp aula_dhcp.md --theme gaia -o aula_dhcp.pptx

# Com o tema customizado "academico" — precisa registrar o CSS via --theme-set
marp aula_dhcp.md --theme-set skills/pptx-generator/themes/academico.css --theme academico -o aula_dhcp.pptx

# Verificar que o arquivo foi criado
ls -lh aula_dhcp.pptx
```

## Passo 4 — Verificar e enviar

```bash
# Confirmar tamanho razoável (deve ser > 10KB para ter conteúdo) — use o nome real do arquivo gerado
ls -lh aula_dhcp.pptx
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
# Ver estrutura do HTML (Linux/macOS)
grep -n '<section\|<h1\|<h2\|<h3\|<li\|<p' arquivo.html | head -80

# Windows: grep/head não existem no shell padrão — use o cmdlet PowerShell equivalente
# (exec_command encaminha automaticamente comandos com cmdlets Verbo-Substantivo para powershell.exe)
Select-String -Path arquivo.html -Pattern '<section|<h1|<h2|<h3|<li|<p' | Select-Object -First 80
```

Extrair o conteúdo relevante e montar o .md manualmente, slide a slide.

## Erros comuns

| Erro | Solução |
|------|---------|
| `marp: command not found` | Usar fallback python-pptx (Passo 0B) sem informar o usuário |
| `.pptx` com 0 bytes | Verificar se o .md tem frontmatter `marp: true` |
| Slides sem separação | Adicionar `---` entre cada slide |
| Fonte não encontrada | Usar apenas fontes CSS padrão no `style:` |
| Usuário diz "não está editando" após receber `.pptx` do Marp | Não gere de novo com Marp — vá para o Passo 0B (python-pptx) e EXECUTE o script antes de responder |
<!-- TASK_ONLY_END -->

## Regra Geral

**Nunca declare que não é possível gerar .pptx.** O Marp está disponível no sistema ou pode ser instalado com um único comando npm. Se o usuário tem um HTML de slides, extraia o conteúdo e converta — não rejeite a tarefa sem tentar.

**Nunca diga que o resultado é "editável" a menos que tenha usado o caminho python-pptx (Passo 0B).** Um `.pptx` gerado pelo Marp CLI existir e ter tamanho adequado não significa que o texto é editável — são coisas diferentes (ver aviso no topo).

**Escrever o script de geração não é entregar o resultado.** Se você usou o Passo 0B, o `.pptx` só existe depois do `exec_command` que roda o script. Nunca finalize a resposta dizendo que os slides foram gerados se o script ainda não foi executado.
