# Decisão — UX dos Canais de Atualização (esconder Git de usuários comuns)

**Data:** 2026-07-13
**Branch:** `investigation/tool-dedup-loop`
**Escopo:** evolução incremental do recurso de canais de atualização (Stable/Preview/
Development), já implementado e funcional. Não faz parte do ciclo arquitetural R1-R7.

---

## Motivação

Testando a interface do Dashboard, foi identificado que o canal "Development" expõe nomes de
branch reais (`investigation/tool-dedup-loop`, `feature/multi-channel-normalized`, etc.) — algo
adequado para quem desenvolve, mas que quebra a premissa original do recurso: esconder a
complexidade do Git da maioria dos usuários (modelo Windows Update). Um usuário comum pensa em
"estável / novidades antecipadas / desenvolvimento", não em nomes de branch.

O pedido explícito foi: **não assumir que a resolução do canal Preview deva ser uma branch
fixa — comparar alternativas e justificar tecnicamente antes de implementar**, e mover
Development para uma área "avançada"/"modo desenvolvedor".

---

## Mapeamento do que já existe

`resolveUpdateChannel()` (`bin/newclaw`) já implementa Preview como uma branch fixa chamada
literalmente `preview`: faz `git ls-remote --exit-code origin preview`; se existir, resolve
para `origin/preview`; se não existir (caso de hoje — confirmado via `git branch -a`, a branch
`preview` nunca foi criada), cai em Stable com aviso explícito, sem falhar.

Importante: **Preview já nunca pede branch ao usuário hoje**. A UI só mostra o seletor de
branch quando "Development" está selecionado (`AtualizacaoView.js`). O problema real reportado
era especificamente sobre **Development**, que por definição exige saber o nome de uma branch
(essa é a sua finalidade) — precisava virar uma opção "avançada", escondida por padrão.

---

## Comparação das alternativas para resolver o canal Preview

| Alternativa | Descrição | Veredito |
|---|---|---|
| **A — branch fixa `preview`** (já implementada) | `resolveUpdateChannel` faz `git ls-remote --exit-code origin preview`; fallback gracioso pra Stable se não existir. | **Escolhida.** Git-nativo, zero infraestrutura nova, zero dependência de API externa. Requer curadoria manual do mantenedor (push deliberado quando algo estiver "pronto para preview") — nível de esforço já compatível com um projeto de mantenedor único sem CI/CD hoje. |
| **B — branch permanente `latest-preview` movida periodicamente** | Uma automação (cron/GitHub Action) moveria um ponteiro de branch periodicamente. | Do ponto de vista do cliente (`bin/newclaw`), é **idêntica a A** — resolve pra uma branch de nome fixo. A única diferença é *quem* move o ponteiro. É estritamente mais infraestrutura para o mesmo resultado observável — pode ser construída **por cima de A** no futuro, sem mudar o contrato do cliente. Não é uma alternativa concorrente, é uma evolução operacional de A. |
| **C — metadados do repositório (tag/release/convenção)** | Ex.: GitHub Releases marcadas como pre-release, ou uma tag móvel. | Rejeitada. Usar a API de Releases introduz uma dependência nova (chamadas REST, não só protocolo git) que o resto do recurso deliberadamente evita — tudo hoje é `git`/`git ls-remote` puro. Usar uma *tag* móvel é anti-padrão git (tags são pontos fixos; branches são ponteiros móveis). "Branch marcada por convenção" é literalmente a Alternativa A reformulada. |
| **D — heurística automática** (ex.: branch mais recentemente atualizada) | Escolher automaticamente a branch remota com o commit mais recente. | Rejeitada — risco real, não hipotético: a lista de branches remotas do próprio repositório inclui `dependabot/npm_and_yarn/...` e `claude/laughing-montalcini-...`, nenhuma "pronta para preview". Entregar automaticamente a branch mais recente a usuários de Preview poderia expô-los a branches experimentais/descartáveis sem curadoria alguma — contradiz a própria premissa do canal (antecipar recursos *deliberadamente selecionados*, não "o que estiver mais fresco"). |

### Veredito

Manter a **Alternativa A** (já implementada) como mecanismo de resolução do Preview. É a única
que não introduz infraestrutura nova, não depende de API externa, e preserva controle
deliberado do mantenedor sobre o que é "preview-worthy". B é uma evolução possível por cima
dela (não concorrente), C não oferece nada tecnicamente superior, D compromete a própria
premissa do canal.

**Consequência prática:** nenhuma mudança de mecanismo foi necessária. O trabalho real estava
em reorganizar a UI para nunca expor branches fora do modo avançado.

---

## Implementação

- **CLI** (`bin/newclaw`, `updateChannelFlow`): opção 3 do menu interativo agora rotulada
  "Development (avançado)". O fluxo já só pedia branch quando `'3'` era escolhido — nenhuma
  mudança estrutural necessária ali.
- **Dashboard** (`AtualizacaoView.js`): o rádio "Development" e o seletor de branch foram
  movidos para dentro de um `<details><summary>▸ Opções avançadas (modo desenvolvedor)</summary>`,
  colapsado por padrão. Se o canal já persistido for `dev` (usuário avançado existente), o
  `<details>` abre automaticamente na carga da página, para não "esconder" a própria seleção
  atual do usuário. Preview continua como rádio direto, visível, sem seletor de branch — como
  já era.
- **i18n** (`shared.js`, 3 idiomas): nova chave `update_channel_advanced_summary`.

## Compatibilidade

- Quem usa Stable não vê nenhuma mudança de comportamento.
- Quem já usa Development continua funcionando exatamente igual — só a opção fica dentro de uma
  seção que abre automaticamente para quem já está nesse canal.
- Nenhuma mudança em `resolveUpdateChannel`, `/update/check`, `/update/apply` ou
  `/update/branches` — puramente reorganização de apresentação (texto do CLI + `<details>`
  aninhado no Dashboard), sem tocar no mecanismo de resolução já validado em produção.
