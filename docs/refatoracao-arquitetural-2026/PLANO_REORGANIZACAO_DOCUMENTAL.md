# Plano de Reorganização Documental — Programa de Refatoração Arquitetural

**Status:** **Executado por completo em `2026-12-CP05` (2026-07-18).** Parte 1 (mover os 5
documentos para a pasta) foi feita fora de ordem em S13 (2026-07-17), a pedido explícito do
usuário; parte 2 (dividir `MASTER_EXECUTION_PLAN.md`, compilar `EXECUCAO_DECISOES_DE_DESIGN.md`,
escrever `README.md`) foi feita no encerramento do programa, conforme sempre planejado.
Este documento é a evolução formal de `docs/issues/007-organizacao-documentacao-programa-
refatoracao.md` (primeira passada, nível "achado de Sprint") para uma análise arquitetural
completa — cobre estrutura definitiva, trade-offs, impacto técnico e passo a passo de migração.

**Divergência registrada entre o plano original e a execução real:** a análise abaixo (seções 1-5)
recomendava suspender QUALQUER movimentação de arquivo até `2026-12-CP05`, justamente para não
competir com a execução ativa das Sprints restantes. O usuário, ao revisar essa recomendação,
priorizou explicitamente encontrabilidade imediata sobre esse custo operacional: aguardar meses
para ter uma pasta organizada não serve se, nesse meio tempo, a localização dos documentos só é
recuperável perguntando à IA — o próprio problema que a reorganização deveria resolver. Isso é uma
correção válida da minha análise original, não uma inconsistência a esconder: eu pesava o custo de
mexer nos links contra o ganho de organização; o usuário pesou (corretamente) o custo de NÃO se
lembrar onde as coisas estão contra esse mesmo ganho — um fator que minha análise original não deu
peso suficiente.

**O que já foi feito (passo 2 e parte do 6 da seção 6, fora de ordem):** os 5 documentos do
programa (`ARCHITECTURAL_BACKLOG.md`, `MASTER_EXECUTION_PLAN.md`, `RETROSPECTIVA_PREMISSAS_
AUDITORIA.md`, `DEPENDENCIAS_ORDEM_IMPLICITA.md`, este arquivo) já vivem em
`docs/refatoracao-arquitetural-2026/`, sem sufixo de data no nome, com todas as referências
cruzadas internas corrigidas.

**O que continua deferido para `2026-12-CP05`:** exatamente a parte da seção 3 que dependia do
documento estar CONGELADO — dividir `MASTER_EXECUTION_PLAN.md` em `SPRINTS/`+`CHECKPOINTS/`+
`METRICAS.md`, compilar `EXECUCAO_DECISOES_DE_DESIGN.md`, e escrever o `README.md` final. Esse
recorte continua válido: agrupar em pasta é uma mudança de LOCALIZAÇÃO (barata a qualquer momento,
já provado); decompor o hub em ~35 arquivos é uma mudança de ESTRUTURA que só compensa quando o
conteúdo já parou de mudar (ver seção 3.2) — os dois têm perfis de custo diferentes, por isso
foram desacoplados nesta execução parcial.

---

## 1. Objetivo e critério de sucesso

Não é estético. A estrutura de diretórios deve, por si só, comunicar onde está toda a
documentação deste programa, sem depender de busca ou memória — critérios: encontrabilidade,
navegabilidade, manutenção futura, onboarding, preservação de contexto histórico.

A pasta deve representar **um programa de trabalho como unidade lógica**, não um agrupamento de
arquivos soltos que por acaso nasceram na mesma semana. Isso tem uma implicação concreta na
estrutura (seção 3): precisa existir um único ponto de entrada (`README.md`) que explique o que o
programa foi, não só uma lista de arquivos.

## 2. Quais documentos pertencem permanentemente ao programa

Reavaliando o inventário de `docs/issues/007` com o critério "isto é sobre O PROGRAMA, ou sobre o
PROJETO como um todo":

| Documento | Pertence ao programa? | Por quê |
|---|---|---|
| `ARCHITECTURAL_BACKLOG.md` | **Sim** | É o próprio objeto do programa — os 26 cards que ele existe para executar. |
| `MASTER_EXECUTION_PLAN.md` | **Sim** | O plano operacional que executa o backlog acima. |
| `RETROSPECTIVA_PREMISSAS_AUDITORIA.md` | **Sim** | Conhecimento gerado *durante* e *sobre* este programa especificamente (a auditoria que ele consolida). |
| `DEPENDENCIAS_ORDEM_IMPLICITA.md` | **Sim** | Idem — nasceu de uma Sprint deste programa (S12), mesmo cobrindo trechos de código que sobrevivem além dele. |
| `docs/issues/002` a `006` | **Não** — pertencem ao PROJETO | `docs/issues/` é convenção mais antiga (item `001`, abril/2026) e mais ampla — vai seguir recebendo achados de sessões futuras sem relação alguma com este programa. Só o CONTEÚDO de 5 itens específicos nasceu aqui; a CONVENÇÃO em si não. |
| `docs/DIRETRIZ_ARQUITETURA_2026-07-13.md` | **Não** — é governança do PROJETO | Rege este programa, mas nasceu de um programa anterior (Sprints R1-R7) e continuará regendo qualquer futuro programa arquitetural. Referenciado por `@docs/...` no `CLAUDE.md` — mover quebraria essa referência sem nenhum ganho (ver seção 5). |
| Auditoria I, II, III, IV (citadas, nunca persistidas como arquivo) | **N/A** | Não existem como documento — ver `docs/issues/007`, Lacuna 1. Fora do escopo deste plano (é lacuna de conteúdo, não de organização). |

Isso confirma a árvore proposta pelo usuário: `docs/issues/` fica **fora** da pasta do programa,
e é o único ponto onde discordo implicitamente de uma leitura mais agressiva ("mover tudo que foi
tocado esta semana") — o critério certo é posse conceitual, não coincidência de data.

## 3. Estrutura definitiva recomendada

```
docs/refatoracao-arquitetural-2026/
├── README.md                              — índice + o que foi o programa (ver 3.1)
├── ARCHITECTURAL_BACKLOG.md                — congelado ao final
├── MASTER_EXECUTION_PLAN.md                — ver 3.2, reduz para um índice/dashboard
├── RETROSPECTIVA_PREMISSAS_AUDITORIA.md    — sem sufixo de data (ver 3.4)
├── DEPENDENCIAS_ORDEM_IMPLICITA.md         — idem
├── EXECUCAO_DECISOES_DE_DESIGN.md          — NOVO, ver 3.3
├── SPRINTS/
│   ├── S01-ARCH-001.md
│   ├── S02-ARCH-004.md
│   ├── ...
│   └── S27-ARCH-012.md
├── CHECKPOINTS/
│   ├── CP01.md
│   ├── ...
│   └── CP05.md
└── METRICAS.md                             — arquivo único, não pasta (ver 3.5)
```

Diferenças deliberadas em relação ao rascunho original — explico cada uma porque nenhuma é
estética, todas têm um motivo funcional:

### 3.1 — `README.md` como índice, não como resumo executivo redundante

O `README.md` assume o papel que hoje o "Resumo Executivo" cumpre dentro do
`MASTER_EXECUTION_PLAN.md` — mas com propósito diferente. O Resumo Executivo de hoje é um
snapshot de ESTADO ATUAL, reescrito a cada Sprint (regra permanente #6). Depois de congelado, não
existe mais "estado atual" — existe um resultado final. O `README.md` deve conter: o que o
programa foi (objetivo, origem nas 4 auditorias), o resultado final (X/26 ARCH concluídos, Y RFCs
geradas), e principalmente **um guia de leitura**: "se você quer saber o quê/por quê de uma
mudança específica, vá no Backlog; se quer saber como uma Sprint específica foi executada, vá em
`SPRINTS/`; se quer entender por que a auditoria original errou em 4 de cada 8 casos, vá na
Retrospectiva." Isso é o que torna a pasta "uma unidade lógica" e não um baú de arquivos — o
`README.md` é o único documento inteiramente nascido DEPOIS do encerramento, sem equivalente hoje.

### 3.2 — `MASTER_EXECUTION_PLAN.md` encolhe para índice/dashboard; Sprints saem para `SPRINTS/`

Motivo mensurável, não estético: o arquivo tem hoje **95 KB com 13/27 Sprints fechadas** — projeção
linear para as 27 é **~198 KB**, um único arquivo Markdown maior que muitos módulos de código do
projeto inteiro. Nesta própria sessão o arquivo já precisou ser lido por trechos (offset/limit)
em vez de inteiro, mais de uma vez — o tamanho já é um problema de navegabilidade hoje, não uma
preocupação hipotética de "manutenção futura".

Divisão proposta: cada seção "### Sprint 2026-XX-SNN" (Objetivo, Arquivos afetados, Dependências,
Premissa reverificada, Decisão de design, Checklists, Critérios de Aceite, DoD, Commit, Status)
vira `SPRINTS/SNN-ARCH-XXX.md`. O que fica em `MASTER_EXECUTION_PLAN.md`: Painel Executivo (tabela
com link para cada `SPRINTS/*.md`), Dashboard Executivo (estado de validação global), Regras
permanentes, Checklist de Execução/Validação — padrão. Isso reduz o arquivo principal para
provavelmente **10-15 KB independente de quantas Sprints o programa tiver** — o tamanho do índice
não cresce com o número de Sprints, só a lista de links cresce (uma linha por Sprint na tabela do
Painel Executivo, que já existe hoje).

**Por que só fazer isso na migração final, nunca durante a execução:** dividir agora multiplicaria
o custo de cada Sprint futura — hoje fechar uma Sprint é editar 1 arquivo; com a divisão em vigor
durante a execução, seria editar o arquivo da Sprint + o Painel Executivo + o Dashboard = 3
arquivos por Sprint, sem ganho nenhum enquanto o programa ainda está em ritmo ativo (o "arquivo
grande" só incomoda quem está LENDO o histórico completo, não quem está escrevendo a Sprint atual).
A extração é um trabalho MECÂNICO de recorte quando o conteúdo já parou de mudar — zero risco,
diferente de fazer isso "a quente".

### 3.3 — `EXECUCAO_DECISOES_DE_DESIGN.md` (novo, fecha a Lacuna 2 de `docs/issues/007`)

Cada Sprint já registra sua própria decisão de trade-off (ex.: S13 escolheu adicionar um campo
em vez de estender o enum `PlanStep.status`, por causa do raio de impacto em ~15 call sites; S12
escolheu manter 4 pontos de chamada explícitos em vez de consolidar num loop, por uma dependência
de ordem real; S06 escolheu deixar o prompt de replan ganhar conteúdo que faltava, uma mudança de
comportamento deliberada). Isso já é registrado — mas só **dentro da seção daquela Sprint**, nunca
reunido. Diferente da Retrospectiva (que cataloga a AUDITORIA errando) e da Dependências de Ordem
(que cataloga um padrão de risco no CÓDIGO), este novo documento cataloga as escolhas que NÓS
fizemos e por quê — o terceiro vértice que faltava. Extração mecânica no encerramento, a partir do
campo "Decisão de design"/"Premissa reverificada" que já existe em cada `SPRINTS/*.md` (uma vez
que a divisão da seção 3.2 já exista, essa extração fica trivial — é basicamente um `grep` guiado).

### 3.4 — Sem sufixo de data nos nomes de arquivo dentro da pasta

A pasta já carrega o ano (`refatoracao-arquitetural-2026/`). Repetir `_2026-07-17` no nome de cada
arquivo dentro dela é redundante e só serve para alongar paths sem adicionar informação — a data
de CRIAÇÃO de cada documento já fica no histórico do git (`git log --follow`), que é a fonte
correta para "quando isso foi escrito", não o nome do arquivo. **Já aplicado na migração parcial:**
os dois catálogos que tinham data no nome (`RETROSPECTIVA_PREMISSAS_AUDITORIA_2026-07-17.md`,
`DEPENDENCIAS_ORDEM_IMPLICITA_2026-07-17.md`) a ganharam de forma ad-hoc, no momento em que foram
criados sem um plano de pasta ainda — não era uma convenção a preservar, era um acidente de quando
cada um nasceu; renomeados para `RETROSPECTIVA_PREMISSAS_AUDITORIA.md`/`DEPENDENCIAS_ORDEM_
IMPLICITA.md` no `git mv` que moveu tudo para a pasta.

### 3.5 — `METRICAS.md`: um arquivo, não uma pasta

O rascunho original lista `METRICAS/` como diretório. Avaliei e recomendo o oposto: manter como
**um único arquivo**. A "Registro de Métricas por Sprint" de hoje é uma tabela — seu valor
inteiro está em ser **uma visão comparável, lado a lado, de todas as Sprints** (uma linha por
Sprint, colunas idênticas: tempo gasto, indicadores antes/depois, riscos, lições). Fragmentar em
27 arquivos (um por Sprint) destruiria exatamente essa propriedade — ninguém consegue comparar
"quanto tempo cada Sprint levou" ou "em quais Sprints apareceram riscos" abrindo 27 arquivos, mas
consegue rolando uma tabela. Note que isso também não é redundante com `SPRINTS/*.md`: os campos
overlapam parcialmente (Commit, Arquivos), mas `METRICAS.md` tem colunas (indicadores antes/depois
lado a lado, tempo gasto) que a narrativa por Sprint não apresenta de forma comparável. Os dois
documentos têm propósitos de leitura genuinamente diferentes — um é "leia a história de uma
Sprint", o outro é "compare todas as Sprints numa tela".

### 3.6 — Revisão da minha própria proposta anterior (`docs/issues/007`)

Aquele primeiro rascunho sugeria um subdiretório `conhecimento/` para agrupar Retrospectiva +
Dependências de Ordem + o novo log de decisões. Reavaliando com a estrutura completa na mesa: 3
arquivos não justificam uma pasta própria — pastas ganham sentido quando têm dezenas de itens
(`SPRINTS/`, `CHECKPOINTS/`), não 3. Adoto a estrutura mais achatada que o próprio rascunho do
usuário já sugeria — é mais simples e não perde nada em navegabilidade (o `README.md` já cumpre o
papel de agrupar/explicar esses 3 documentos por texto, não precisa de mais um nível de pasta).

## 4. Vantagens e desvantagens

### Vantagens
1. **Encontrabilidade imediata:** qualquer pessoa (ou eu, em uma sessão futura) sabe que TUDO
   sobre este programa está sob um único diretório — não precisa saber os nomes dos 9+ arquivos
   de antemão.
2. **Tamanho de arquivo sob controle:** o hub (`MASTER_EXECUTION_PLAN.md`) para de crescer sem
   limite; cada `SPRINTS/*.md` fica pequeno e de leitura rápida, independente de quantas Sprints o
   programa acumular.
3. **Granularidade de git mais limpa:** `git log --follow -- docs/refatoracao-arquitetural-2026/
   SPRINTS/S13-ARCH-007.md` mostra o histórico só daquela Sprint, sem ruído das outras 26.
4. **Precedente reutilizável:** a próxima grande iniciativa arquitetural do projeto (ver seção 7)
   ganha um molde pronto em vez de reinventar a organização do zero.
5. **Fecha 1 de 3 lacunas já identificadas** (`EXECUCAO_DECISOES_DE_DESIGN.md`, Lacuna 2 de
   `docs/issues/007`) como subproduto natural da divisão em `SPRINTS/`.

### Desvantagens / custos
1. **~35-40 arquivos novos** (27 Sprints + 5 Checkpoints + 1 README + os que já existem) onde hoje
   há ~9 — mais superfície para manter consistente (embora, uma vez congelado, "manter" signifique
   só preservar, não editar ativamente).
2. **Referências cruzadas dentro dos próprios documentos precisam virar links relativos**
   corretos (`SPRINTS/S13-ARCH-007.md` em vez de uma seção `#sprint-2026-08-s13` no mesmo
   arquivo) — trabalho mecânico, mas não zero.
3. ~~5 comentários em código-fonte (`extractText.ts`, `transientErrorPatterns.ts`, 3 testes de
   regressão) apontam para `docs/ARCHITECTURAL_BACKLOG.md` pelo path antigo.~~ **Corrigido junto
   com a migração parcial** — os 5 já apontam para `docs/refatoracao-arquitetural-2026/
   ARCHITECTURAL_BACKLOG.md`.
4. **Histórico de commits antigos** (mensagens de commit já publicadas, ex. "docs: record S01
   commit hash... in execution plan") continuam citando o path/contexto antigo — imutável por
   natureza de git, não é um problema a resolver, só um custo a aceitar (`git log --follow`
   resolve a navegação apesar disso).
5. **Custo de execução não-trivial:** mesmo sendo mecânico, extrair 27 seções de um arquivo de
   ~200 KB em 27 arquivos + reescrever o índice + gerar o log de decisões é um trabalho de uma
   sessão dedicada inteira, não uma tarefa de 10 minutos.

**Balanço:** as vantagens são estruturais e compostas (cada Sprint futura do PRÓXIMO programa se
beneficia do precedente); os custos são um investimento único, pago uma vez, na sessão de
encerramento — quando o conteúdo já parou de mudar e o trabalho é mecânico, não criativo. Recomendo
seguir com o plano.

## 5. Impactos técnicos (levantamento real, não estimado)

**Referências cruzadas entre os próprios documentos do programa** (contadas por grep, sessão
anterior — `docs/issues/007`): `MASTER_EXECUTION_PLAN.md` é citado 8x no Backlog+Retrospectiva
combinados e cita os outros 3 documentos 13x no total — confirmando que ele é o hub e deve ser
movido/dividido por último.

**Código-fonte** (`grep` executado nesta sessão, `src/`, `scripts/`, `.claude/`): **5 arquivos**
referenciam `docs/ARCHITECTURAL_BACKLOG.md` — todos como comentário JSDoc explicativo (ex.
`extractText.ts:5`, `transientErrorPatterns.ts:9`, e 3 testes de regressão `S116`/`S117`/`S118`).
**Nenhum é import, path resolvido em runtime, ou dependência de build** — são só prosa. Impacto:
cosmético (o comentário aponta pra um path que muda de lugar), zero risco de quebrar `tsc`/build/
testes. Nenhuma referência encontrada em `CLAUDE.md` (só cita `ARCHITECTURE.md` e
`DIRETRIZ_ARQUITETURA_2026-07-13.md`, nenhum dos dois se move neste plano).

**Memória persistente do Claude Code** (`C:\Users\lucia\.claude\projects\...\memory\`): o arquivo
`project_master_execution_plan_2026-07-17.md` referenciava `docs/MASTER_EXECUTION_PLAN.md` pelo
path antigo em dezenas de linhas de narrativa histórica. **Já corrigido na migração parcial**: a
descrição, o parágrafo de abertura e as instruções finais de "como retomar" (os trechos que uma
sessão futura efetivamente usa para navegar) foram atualizados para o novo path, com uma nota
explícita avisando que qualquer path sem o prefixo novo em linhas históricas mais antigas do mesmo
arquivo está desatualizado — não reescrevi cada menção histórica individual (custo alto,
benefício baixo: são narrativa de Sprints já fechadas, não instruções de navegação ativas).

**Rastreabilidade histórica no git:** todo `git mv` preserva o histórico via detecção de rename
(`git log --follow`) — confirmado nesta mesma sessão (o `git mv` de teste feito e revertido mais
cedo funcionou exatamente assim). O único custo permanente e irreversível é que mensagens de
commit JÁ PUBLICADAS continuam citando o path antigo no texto (não no diff) — aceitável, é assim
que qualquer rename em qualquer repositório git funciona, não é uma falha deste plano.

## 6. Plano de migração passo a passo (executar só no `2026-12-CP05`)

1. **Pré-requisito:** todas as 27 Sprints e os 5 Checkpoints com status `🟢`/finalizado — nenhum
   documento do programa deve mudar de conteúdo depois que a migração começar.
2. Criar `docs/refatoracao-arquitetural-2026/`, `SPRINTS/`, `CHECKPOINTS/`.
3. ✅ **Feito, 2026-12-CP05 (executada 2026-07-18):** as 27 seções "### Sprint ..." de
   `MASTER_EXECUTION_PLAN.md` extraídas para `SPRINTS/SNN-ARCH-XXX.md` (mecânico, via script —
   cada seção já era auto-contida).
4. ✅ **Feito, CP05:** as 5 seções "## Checkpoint ..." extraídas para `CHECKPOINTS/CPNN.md`.
5. ✅ **Feito, CP05:** `EXECUCAO_DECISOES_DE_DESIGN.md` compilado — a partir do campo "Lições
   aprendidas"/"Riscos encontrados" de `METRICAS.md` (fonte mais rica que os campos
   "Objetivo"/"Checklist" dos `SPRINTS/*.md` para esse propósito específico), não literalmente
   dos campos "Decisão de design"/"Premissa reverificada" citados no rascunho original desta
   seção (esses campos nomeados não existiam como tal nas Sprints reais — a narrativa de decisão
   sempre viveu na coluna "Lições aprendidas").
6. ✅ **Feito fora de ordem, 17/07/2026 (S13), a pedido do usuário:** `git mv` dos 4 documentos
   restantes (`ARCHITECTURAL_BACKLOG.md`, `RETROSPECTIVA_PREMISSAS_AUDITORIA` e
   `DEPENDENCIAS_ORDEM_IMPLICITA` — sem sufixo de data, seção 3.4) para dentro da pasta, na ordem
   menos referenciado → mais referenciado: `DEPENDENCIAS_ORDEM_IMPLICITA.md` →
   `RETROSPECTIVA_PREMISSAS_AUDITORIA.md` → `ARCHITECTURAL_BACKLOG.md` → `MASTER_EXECUTION_PLAN.md`
   por último. **Diferença em relação ao plano original:** `MASTER_EXECUTION_PLAN.md` NÃO foi
   reduzido ao índice/dashboard da seção 3.2 antes de mover — continua com todas as 27 Sprints
   inline, porque essa redução só é segura quando o documento já está congelado (passo 5 acima).
7. ✅ **Feito junto com o passo 6:** todos os links internos entre os 5 documentos movidos
   reescritos para paths relativos (`ARCHITECTURAL_BACKLOG.md` em vez de
   `docs/ARCHITECTURAL_BACKLOG.md`) — confirmado por `grep` com 0 ocorrências residuais do path
   antigo dentro da pasta.
8. ✅ **Feito, CP05:** `README.md` final escrito (seção 3.1) — índice do programa encerrado, com
   resultado final, guia de leitura e as 7 lições mais importantes.
9. ✅ **Feito, 17/07/2026:** os 5 comentários em código-fonte (seção 5) que citavam o path antigo
   corrigidos para `docs/refatoracao-arquitetural-2026/ARCHITECTURAL_BACKLOG.md`.
10. ✅ **Feito, 17/07/2026:** memória `project_master_execution_plan_2026-07-17.md` atualizada
    (descrição, parágrafo de abertura, instruções de "como retomar") com o novo path — narrativa
    histórica de Sprints já fechadas dentro do mesmo arquivo não foi reescrita linha a linha (ver
    seção 5).
11. ✅ **Feito, 17/07/2026:** suíte de regressão rodada após a migração parcial — nenhuma mudança
    tocou código de produção, só `.md`/comentários, então nenhuma alteração de resultado esperada.
12. ✅ **Feito, 17/07/2026:** commit da migração parcial, apontando para este plano.

**Plano executado por completo em `2026-12-CP05` (2026-07-18).** Todos os 12 passos concluídos —
`MASTER_EXECUTION_PLAN.md` reduzido a índice/dashboard (de ~178 KB/866 linhas para ~15 KB/230
linhas), `SPRINTS/`+`CHECKPOINTS/`+`METRICAS.md`+`EXECUCAO_DECISOES_DE_DESIGN.md`+`README.md`
criados, regressão pós-reorganização confirmada sem quebras (mudança só em `.md`, nenhum código
tocado).

## 7. Recomendações para futuras iniciativas arquiteturais

1. **Todo programa de refatoração de porte semelhante deve nascer já com sua própria pasta**
   (`docs/<nome-do-programa>-<ano>/`), não como arquivos soltos em `docs/` — o custo de organizar
   depois (este próprio plano) é maior do que nascer organizado.
2. **A divisão viva-vs-arquivada da seção 3.2 deve ser avaliada por tamanho, não copiada por
   padrão:** um programa pequeno (poucas Sprints, arquivo que nunca passaria de ~20 KB) não
   precisa de `SPRINTS/` — a divisão só se paga quando o crescimento projetado justifica.
3. **`docs/issues/` continua sendo do projeto, nunca de um programa específico** — nenhum
   programa futuro deve tentar "possuir" essa convenção.
4. **Catálogos cumulativos de conhecimento (tipo Retrospectiva/Dependências/Decisões) devem
   nascer sem sufixo de data no nome**, mesmo que criados no meio da execução — a data pertence ao
   git log, não ao nome do arquivo, mesmo antes de existir uma pasta para "esconder" a redundância.
5. **Este documento em si é o precedente:** a próxima iniciativa de porte comparável pode reusar a
   seção 3 (estrutura) e a seção 6 (passo a passo) quase literalmente, ajustando nomes.
