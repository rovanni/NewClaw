---
name: dependency-curator
description: Pesquisa e documenta comandos de instalação cross-platform (Linux/Windows/macOS) de uma dependência de sistema, com fonte citada e grau de confiança, antes que ela seja considerada para entrar em KNOWN_DEPS. Nunca instala, nunca executa, nunca edita código — produz apenas um relatório de evidências para aprovação humana.
version: "1.0"
triggers: curar dependência, curadoria de dependência, pesquisar instalação, adicionar ao known_deps, known_deps, pipeline de dependência, comando de instalação cross-platform, dependency-curator
tools: web_search, web_navigate, read, write
tags: research, dependency, install, cross-platform, evidence, curation, known_deps
---

# Dependency Curator

Pesquisa, com evidência citada, como instalar uma dependência de sistema no Linux, Windows e
macOS — e produz um relatório estruturado para um humano decidir se ela entra em `KNOWN_DEPS`
(`src/loop/GoalEvaluator.ts`).

**Princípio fundamental:** só produz conhecimento. Nunca decide, nunca instala, nunca edita
código. Mesmo padrão de `skill-auditor` (pesquisa → relatório categorizado → decisão humana),
aplicado ao domínio de instalação de dependências em vez de segurança de skills.

Origem: Sprint 007 (`docs/Auditorias/2026-07-26/AUDITORIA_COBERTURA_CROSSPLATFORM_KNOWN_DEPS_2026-07-26.md`)
encontrou que 23 das 26 entradas de `KNOWN_DEPS` não têm cobertura Windows/macOS — não por
decisão técnica, mas porque nunca houve um processo de pesquisa/validação desses comandos. Esta
skill é esse processo — a metade de pesquisa. O documento normativo que consolida esta skill como
decisão arquitetural, com a responsabilidade completa de cada componente envolvido (`KNOWN_DEPS`,
`resolveInstallCommand`, `GoalEvaluator`, `OperationalKnowledge`, `EnvironmentProbe`) é
`docs/ARCHITECTURE/PIPELINE_CURADORIA_DEPENDENCIAS.md` (Sprint 009) — leia-o antes de alterar esta
skill ou qualquer componente do fluxo de dependências.

## Quando usar

- Antes de propor uma nova entrada em `KNOWN_DEPS`, ou de completar `installByPlatform` para uma
  entrada que hoje só tem `installCmd` legado (apt/Linux).
- Quando o usuário pedir `/dependency-curator <ferramenta>` ou "pesquisar instalação de X".
- **Nunca** como reação automática a uma dependência ausente durante a execução de um goal — essa
  é a responsabilidade de `system-provisioner` (execução heurística, em runtime) e do fluxo
  `needs_dependency` (`GoalEvaluator`/`resolveInstallCommand`), que continuam inalterados. Esta
  skill é acionada por um humano/operador de forma assíncrona, fora do caminho de execução de um
  goal.

## Restrições absolutas

- **NUNCA** editar `src/loop/GoalEvaluator.ts`, `src/loop/planning/resolveInstallCommand.ts`,
  `src/loop/RiskAnalyzer.ts`, `src/core/EnvironmentProbe.ts` ou qualquer outro arquivo de código —
  a tool `write` desta skill só deve ser usada para escrever o relatório final (passo 6), nunca
  código-fonte.
- **NUNCA** executar um comando de instalação para "testar" — esta skill não tem `exec_command`
  no `tools:` acima, de propósito.
- **NUNCA** propor um comando sem uma fonte (URL) citada — se não encontrar fonte oficial
  confiável, a situação da plataforma é `não encontrado`, nunca um comando inventado (princípio
  "Nunca Adivinhar", `docs/ARCHITECTURE/NUNCA_ADIVINHAR.md`).
- Toda alteração real em `KNOWN_DEPS` acontece depois, em um PR revisado por humano — fora do
  escopo desta skill.

## Passo 1 — Identificar a ferramenta e checar se já está coberta

Antes de pesquisar, leia a entrada atual (se existir) em `src/loop/GoalEvaluator.ts`
(`KNOWN_DEPS`). Se a dependência já tem `installByPlatform` para as 3 plataformas, **pare aqui** —
não há nada a curar, ela já é Categoria A.

Registre: nome da dependência, por que foi pedida (ex: usada por qual skill/tool/step de goal),
se já existe entrada parcial em `KNOWN_DEPS` hoje.

## Passo 2 — Pesquisar documentação oficial

Use `web_search` para localizar o site/repositório oficial do projeto (não blogs de terceiros,
não fóruns, a menos que não exista nada oficial — nesse caso registre a fonte como
"não-oficial" explicitamente no relatório). Priorize, nesta ordem: site oficial do projeto →
repositório GitHub oficial (README/INSTALL.md) → documentação de gerenciador de pacote oficial
(ex: página do pacote no `winget`/`choco`/`brew`/`apt`).

## Passo 3 — Identificar requisitos

A partir da documentação encontrada, registre:
- Precisa de privilégios administrativos/root para instalar?
- Depende de outro runtime (ex: precisa de Python, Node, um compilador)?
- Tem variantes de nome de pacote por distro/gerenciador (ex: `ffmpeg` no apt vs no winget)?

## Passo 4 — Pesquisar comando por plataforma

Para cada uma das 3 plataformas (Linux, Windows, macOS), independentemente:
- Use `web_search`/`web_navigate` para confirmar o comando real (`apt`/`apt-get` para Linux;
  `winget`/`choco` para Windows; `brew` para macOS — na ausência de um gerenciador padrão,
  registre o instalador oficial encontrado).
- Anote a URL exata de onde o comando veio.
- Se depois de pesquisar não houver fonte confiável para uma plataforma específica, essa
  plataforma fica `não encontrado` — **não tente inferir por analogia com outra plataforma**.

## Passo 5 — Atribuir grau de confiança e situação (por plataforma)

Para cada plataforma, uma das 4 situações:
- **validado**: comando testado por evidência direta (changelog, doc oficial explícita para
  aquela versão/SO) — confiança alta.
- **parcialmente validado**: comando existe na documentação oficial, mas sem confirmação de
  execução real neste projeto — confiança média.
- **necessita testes**: comando encontrado, mas em fonte secundária/desatualizada, ou com
  ressalvas (ex: versão antiga, pacote com nome ambíguo) — confiança baixa.
- **não encontrado**: nenhuma fonte confiável localizada — sem comando proposto.

## Passo 6 — Gerar o relatório

Escreva (tool `write`) o relatório em
`docs/Auditorias/dependencias/<nome-da-dependencia>.md`, com esta estrutura:

```markdown
# Curadoria de Dependência — <nome>

## Resumo
- Dependência pesquisada: <nome>
- Fontes consultadas: <lista de URLs>
- Plataformas cobertas: <ex: Linux (validado), Windows (necessita testes), macOS (não encontrado)>
- Grau de confiança geral: <alto/médio/baixo>

## Ficha técnica
- Categoria: <system | node | python | outro>
- Necessidade de privilégios administrativos: <sim/não, detalhar>
- Dependências adicionais: <lista ou "nenhuma encontrada">

## Evidências

### Linux
- Comando encontrado: `<comando ou "nenhum">`
- Origem: <URL>
- Situação: <validado | parcialmente validado | necessita testes | não encontrado>
- Observações: <...>

### Windows
- Comando encontrado: `<comando ou "nenhum">`
- Origem: <URL>
- Situação: <validado | parcialmente validado | necessita testes | não encontrado>
- Observações: <...>

### macOS
- Comando encontrado: `<comando ou "nenhum">`
- Origem: <URL>
- Situação: <validado | parcialmente validado | necessita testes | não encontrado>
- Observações: <...>

## Recomendação
- Existe evidência suficiente para adicionar esta dependência (ou completar `installByPlatform`)
  em `KNOWN_DEPS`? <sim/não/parcialmente, por quê>
- Existem lacunas que exigem validação manual? <quais>
- Quais testes deverão ser criados antes da aprovação? <ex: novo caso no estilo de S141/S31,
  testando resolveInstallCommand() com a entrada real proposta>
```

## Boas práticas

- Falso "não encontrado" é aceitável; comando inventado sem fonte não é — na dúvida, marque
  `não encontrado`.
- Se a mesma dependência já foi pesquisada antes (`docs/Auditorias/dependencias/<nome>.md` já
  existe), leia o relatório anterior primeiro — não repita pesquisa já registrada, só atualize se
  houver evidência nova.
- O relatório é o único artefato desta skill. Ela nunca conclui dizendo "adicionei a entrada" —
  sempre termina com uma recomendação para decisão humana.
