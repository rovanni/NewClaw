# Convenções Documentais — `docs/`

Referência única de onde um documento novo deve ir. Consulte isto **antes** de criar um arquivo
em `docs/` — é o que faltou nas duas reorganizações anteriores (ver "Histórico" no fim) e o
motivo de `docs/` ter acumulado ~25 arquivos soltos sem categoria entre uma reorganização e a
próxima.

## Árvore de decisão

```
Este documento é sobre O PROGRAMA/PROJETO como um todo, permanente?
  → fica na raiz de docs/ (ex: ARCHITECTURE.md, DIRETRIZ_ARQUITETURA, ROADMAP.md, walkthrough.md)
  → só 4-5 documentos merecem isso; se está em dúvida, provavelmente NÃO é este caso

É uma decisão formal e pontual (ADR/RFC)?
  → docs/decisoes/

É uma análise/investigação seguindo o processo de 5 fases da Diretriz, mas NÃO abre um
programa de várias Sprints (é uma mudança específica e contida)?
  → docs/analises-arquiteturais/

É um programa inteiro de trabalho — várias Sprints, múltiplos documentos, nasce e se
encerra como uma unidade? (ex: refatoração arquitetural, Sprints R1-R7)
  → NASCE JÁ com sua própria pasta: docs/<nome-do-programa>-<ano>/
  → nunca como arquivos soltos na raiz "por enquanto" — isso é o que gera a bagunça

É uma auditoria técnica do codebase (revisão de código, achados, aprovação)?
  → docs/Auditorias/<NN>/ (numerado, convenção antiga) ou docs/Auditorias/<YYYY-MM-DD>/
    (datado, convenção atual — prefira esta para auditorias novas)
  → PRIVADO (.gitignore) — nunca vai para o GitHub público

É um relatório de implementação de Sprint numerada (3.6, 3.7A, 006...)?
  → docs/sprints/SPRINT_<versão>_<NOME>.md

É documentação sobre o sistema de Skills?
  → docs/skills/

É um diagnóstico de performance/melhoria pontual?
  → docs/melhorias/<nome>-<YYYY-MM-DD>.md
  → PRIVADO (.gitignore)

É dívida técnica ou achado fora do escopo da Sprint atual, para correção futura?
  → docs/issues/<NNN>-<kebab-case>.md
  → ATENÇÃO: pasta com rastreamento MISTO — ver seção "Público × Privado" abaixo antes de
    assumir que um novo item aqui será público ou privado

É um princípio arquitetural normativo (regra permanente, leitura obrigatória antes de propor
componente novo)?
  → docs/ARCHITECTURE/ — mas pense duas vezes: um princípio novo tem barra alta, não é onde
    guardar uma análise pontual
```

## Regras que se aplicam a qualquer categoria

1. **Sem sufixo de data no nome do arquivo se a pasta já data/nomeia o conteúdo.** A data pertence
   ao `git log --follow` (ou, para conteúdo privado, ao próprio nome da subpasta), não precisa se
   repetir no nome de cada arquivo dentro dela. Ex: dentro de `sprints-r1-r7-2026-07-13/`, os
   arquivos ainda têm `_2026-07-13` no nome por serem uma migração retroativa — evite repetir esse
   padrão em pastas novas.
2. **Reaproveite a convenção existente antes de inventar uma nova.** As 3 pastas criadas em
   2026-07-26 (`decisoes/`, `analises-arquiteturais/`, `sprints-r1-r7-2026-07-13/`) só nasceram
   depois de confirmar que nenhuma pasta existente cobria aquele conteúdo — mesmo critério do Gate
   "Extensão antes de Criação" da Diretriz, aplicado a documentação.
3. **Um programa nasce com pasta própria, não vira pasta depois.** Lição registrada em
   `refatoracao-arquitetural-2026/PLANO_REORGANIZACAO_DOCUMENTAL.md` §7: o custo de organizar
   depois é sempre maior que nascer organizado.
4. **README.md de cada pasta-programa é o índice daquele programa**, não um resumo redundante —
   ver `refatoracao-arquitetural-2026/README.md` como modelo.

## Público × Privado

`.gitignore` (linha 8, desde 2026-05-21): `docs/Auditorias/`, `docs/melhorias/`, `docs/issues/`,
`docs/task.md`, `docs/plano-correcao-bugs.md` ficam fora do repositório público — comentário
original: "apenas assets, ROADMAP e walkthrough são públicos". Tudo mais em `docs/` é público por
padrão (qualquer arquivo/pasta nova fora dessa lista é versionado automaticamente ao `git add`).

**Exceção a conhecer:** `docs/issues/` está parcialmente pública — 6 arquivos (`001`, `002`,
`008`-`011`) foram commitados antes da regra do `.gitignore` existir e continuam rastreados
(`.gitignore` nunca destrackeia o que já foi commitado, só bloqueia arquivos novos). Rode
`git ls-files docs/issues/` se precisar saber com certeza se um item específico é público.

Se um documento sobre auditoria/melhoria/issue deveria ser público, isso é uma decisão explícita
(editar o `.gitignore` ou `git add -f`), nunca uma correção automática.

### O que pode estar dentro de um arquivo público

A regra acima diz **onde** um arquivo mora; esta diz **o que** ele pode conter. Vale para todo
arquivo versionado, não só para `docs/`:

> Conteúdo local — caminho pessoal, credencial, configuração privada, topologia de máquina do
> mantenedor — permanece fora do repositório público, mesmo em documento cujo conteúdo técnico é
> público.

Quando o caminho importa para o sentido do texto, use marcador: `<workspace>`,
`<instalação de produção>`, `<home>/.claude/...`. Preserva a informação técnica e não expõe quem
escreveu. Em script, prefira **caminho relativo à raiz do repositório** — remove o dado e ainda
torna o script portável.

**Arquivos de instrução para agentes** (`CLAUDE.md`, `AGENTS.md`, e os equivalentes que
ferramentas futuras criarem) são públicos e por isso só podem conter instrução independente do
ambiente pessoal. Já os **diretórios de configuração local** dessas ferramentas (`.claude/`,
`.agents/`) ficam ignorados: eles carregam skills e configurações que citam `.env`, portas e
caminhos da máquina.

Isso não é hipótese. Em 09/08/2026 a instalação de uma segunda ferramenta de agente espelhou
`.claude/` em `.agents/` — copiando um arquivo **ignorado** para um caminho **não ignorado**, com
o caminho pessoal do mantenedor dentro. A mesma varredura encontrou sete arquivos já públicos com
caminhos pessoais, que passaram por revisão sem ninguém notar. Portanto: **ao instalar ferramenta
nova que espelhe ou gere arquivos, classifique a exposição antes do primeiro `git add`** — e
prefira `git add <caminho>` a `git add -A`, que é o que transforma um espelho novo em commit
público sem ninguém decidir.

## Histórico

Este documento nasceu na terceira rodada de organização de `docs/` (2026-07-26), depois que as
duas primeiras — que corrigiram o que existia até então, mas não deixaram uma regra para o que
viria depois — precisaram ser redescobertas do zero:

1. [analises-arquiteturais/DOCUMENTATION_AUDIT_REPORT.md](./analises-arquiteturais/DOCUMENTATION_AUDIT_REPORT.md) (2026-06-01)
2. [refatoracao-arquitetural-2026/PLANO_REORGANIZACAO_DOCUMENTAL.md](./refatoracao-arquitetural-2026/PLANO_REORGANIZACAO_DOCUMENTAL.md) (2026-07-18)
3. Esta reorganização (2026-07-26) — ver commit `docs: reorganiza arquivos soltos de docs/ em
   pastas temáticas + reescreve índice`

Se `docs/` ficar bagunçado de novo, o problema não é falta de regra — é este documento não ter
sido consultado antes de criar o próximo arquivo solto.
