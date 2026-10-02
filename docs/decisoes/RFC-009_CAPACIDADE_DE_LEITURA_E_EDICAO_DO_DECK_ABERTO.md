# RFC-009 — Capacidade de leitura e edição do deck aberto (item (c) da RFC-008)

**Status:** PROPOSTA — documentação apenas. **Nenhuma implementação aprovada.** Nenhum código foi alterado por esta RFC.

**Autor:** Revisão assistida (Claude Code), 02/10/2026.

**Tipo:** Arquitetura / capacidade nova · **Categoria:** Suplemento PowerPoint, `powerpoint_control`, broker.

**Origem:** o replay do RC1 e a validação do item (a) (`docs/decisoes/RFC-008_CONTEXTO_DE_APLICATIVO_HOSPEDEIRO.md`) mostraram que o gargalo para o pedido de 14/07 ("melhorar a cor dos textos") **não é o contexto
nem a visibilidade do schema, e sim a falta de capacidade**: o Planner chegou a emitir `action=apply_color_scheme`, que a ferramenta não tem.

---

# Resumo

Hoje o agente **não consegue ler nem alterar o deck aberto**: `powerpoint_control` só tem `addTextBox`. Esta RFC levanta o que a plataforma permite (verificado na documentação oficial), o que o código já fez e foi
descartado, e propõe um caminho **em etapas**, começando pela **leitura**, antes de qualquer **edição no deck do usuário**. O objetivo é decidir *o que* construir; **não** implementa nada.

---

# Fase 1 — Compreensão (evidência)

## 1.1 O que existe no código

| Fonte | Fato | Como foi obtido |
|---|---|---|
| `main` | `powerpoint_control` aceita só `addTextBox`; o broker tem `CommandAction = 'addTextBox' \| 'insertDocument'`; o add-in só trata `addTextBox` e a inserção de slides | leitura do código |
| Remoto `origin/fix/powerpoint-addin-goal-context` (`8913b9d`) | Implementou `getPresentation` (id, índice e título de cada slide) e `getSlide` (shapes, textos e células de tabela de um slide). **Somente leitura e estrutural: não lê cor, fonte nem preenchimento.** | leitura do código remoto (ver RFC-008, "Referência histórica") |
| Add-in (main) | Insere slides com `formatting: useDestinationTheme` **fixo** (`powerpoint.ts`) | leitura do código |
| Add-in (main) | Não usa nenhuma API de formatação (`font`, `fill`, `background`); só `shapes.addTextBox` | `grep` |

## 1.2 O que a plataforma permite (documentação oficial da Microsoft, consultada em 02/10/2026)

Fontes: `learn.microsoft.com/en-us/javascript/api/requirement-sets/powerpoint/powerpoint-api-requirement-sets` e as páginas dos conjuntos 1.4 e 1.10. **É leitura da documentação; nada disto foi executado.**

| Capacidade | Conjunto | Membros citados na documentação |
|---|---|---|
| Inserir slides de outra apresentação; **apagar slides** | PowerPointApi **1.2** | (descrição geral do conjunto) |
| Adicionar, mover, dimensionar, **formatar** e remover shapes | **1.4** | `Shape.fill`, `ShapeFill.setSolidColor(color)`, `ShapeFill.foregroundColor`, `TextRange.font` → `ShapeFont.color`, `ShapeLineFormat.color` |
| **Fundo do slide** (cor sólida, gradiente, padrão, imagem) | **1.10** | `Slide.background`, `SlideBackground.fill`, `SlideBackgroundFill.setSolidFill({color})`, `reset()` |
| **Cores do tema** (um só ponto para recolorir o deck) | **1.10** | `Slide/SlideLayout/SlideMaster.themeColorScheme`, `ThemeColorScheme.getThemeColor` e **`setThemeColor(color, rgbColor)`** |
| **Exportar slides como `.pptx` em Base64** | **1.10** | `SlideCollection.exportAsBase64Presentation(values)`, `SlideScopedCollection.exportAsBase64Presentation()` |
| Renderizar a imagem de um shape | 1.10 | `Shape.getImageAsBase64(options)` |

**Disponibilidade (da própria página):** o 1.10 exige, no Windows com assinatura Microsoft 365, a versão **2601 (build 19610.20002)**; no Mac, 16.105; **"Not available"** em Windows com licença por volume (LTSC) e no iPad. O 1.4 exige 2207 no Windows.
**A versão de PowerPoint do usuário não foi verificada.**

## 1.3 O que a evidência de comportamento diz

- **Replay do RC1 (execução de 02/10):** com o bloco de host, 12 de 15 planos escolheram `powerpoint_control`; **todos os 22 passos vieram sem `action`**. Com o hint do item (a), o uso caiu para 2 de 10 e um dos 2 passos inventou `apply_color_scheme`.
  O Planner **quer** uma capacidade de recolorir que não existe.
- **O único goal de 14/07 que concluiu (`d65qd`)**: a 1ª chamada de `powerpoint_control` falhou; ele então gerou um `.pptx` **do zero** com python-pptx (sem ler o deck aberto) e o entregou, em 1 min. "Concluiu" significou entregar algo, não recolorir o deck aberto.
- **Entrega por inserção:** o add-in só **acrescenta** slides (e com `useDestinationTheme`). Não há ação para apagar os antigos, de modo que "gerar e inserir" deixa slides duplicados. **Se `useDestinationTheme` descarta as cores do arquivo inserido é uma hipótese não verificada.**

---

# Fase 2 — Crítica da hipótese ("construir leitura e edição no deck")

Procurei razões para **não** fazer:

1. **Edição direta altera o deck do usuário.** Não verifiquei se o PowerPoint permite desfazer uma edição feita por um suplemento. Sem isso, qualquer ação de escrita é potencialmente irreversível.
2. **Superfície cresce por feature.** Cada ação nova (cor de fonte, fundo, tema, tabela…) é código no add-in, no broker e na tool. Risco de virar um "God Tool" que espelha o Office.js.
3. **Privacidade.** Ler o deck envia o conteúdo ao provedor do LLM. O `slideContext` já envia textos do slide ativo; ler o deck inteiro é muito maior.
4. **Injeção por conteúdo.** Texto de slide é dado não confiável (RFC-004; RFC-008 A8). Um deck com "ignore as instruções…" não pode virar instrução.
5. **Dependência de versão.** Metade da capacidade útil (tema, fundo, exportação) está no 1.10, indisponível em LTSC e iPad. O add-in precisaria detectar o conjunto em tempo de execução (`isSetSupported`) e degradar.
6. **Não há como testar o add-in sem o PowerPoint.** O `PowerPoint.run` não roda headless: a validação real (etapa 4 da Diretriz) **exige o PowerPoint do usuário**.
7. **Valor incerto.** Uma única mensagem de 14/07, de uma única sessão de testes, motiva tudo isto; a base retrospectiva de goals do suplemento é de **9 goals**.

---

# Fase 3 — Alternativas

| | Descrição | Vantagens | Desvantagens |
|---|---|---|---|
| **α** | **Só leitura**: ações `getPresentation`/`getSlide` (referência: remoto), opcionalmente com leitura de cor/fonte (1.4) e das cores do tema (1.10). | Sem risco ao deck; já existiu em julho; permite ao Planner **saber** o que há. | Sozinha **não recolore**: o fluxo restante é "regenerar com python-pptx e inserir", com a incerteza do `useDestinationTheme` e slides duplicados. |
| **β** | α **+ edição em lugar de formato**: `setThemeColor`, fundo do slide, cor de fonte/preenchimento — atrás de **aprovação** (mecanismo existente de ação perigosa, ADR-005). | Resolve o pedido de 14/07 de forma **direta**; `setThemeColor` recolore o deck inteiro em uma operação. | Escrita no deck (item 1 da Fase 2); 1.10 para tema/fundo; superfície maior; precisa validação no PowerPoint real. |
| **γ** | **Exportar** (`exportAsBase64Presentation`) → arquivo no workspace → python-pptx → inserir e apagar os antigos. | Fidelidade total do arquivo; reusa python-pptx e `send_document`. | Mais peças (payload binário pelo broker, gravação no workspace, **apagar slides**), mesma incerteza do tema, depende do 1.10. |
| **δ** | Não construir; aceitar o limite e documentar. | Zero risco e custo. | O Planner continua tentando recolorir sem poder. |

**Gate Extensão antes de Criação** (Diretriz): **nenhuma** das alternativas exige Tool, Skill ou Script novo. Todas **estendem** `powerpoint_control` (`src/tools/powerpoint_control.ts`), `powerpointBroker.ts` e o add-in
(`powerpoint.ts`), que já existem. O código do remoto serve de **referência**, não de merge (384+ commits de divergência).

---

# Fase 4 — Síntese (recomendação, a ratificar)

**Em etapas, e só avançar com evidência da anterior:**

1. **Etapa 1 — α, somente leitura.** Reimplementar `getPresentation` e `getSlide` sobre a `main` atual, **sem** cherry-pick, com limites de tamanho, textos delimitados e rotulados como dado, e com **detecção de conjunto** (`isSetSupported`) devolvendo `unsupported`
   quando faltar. A ação entra no `enum` e **o hint do item (a) a acompanha** (a lista de ações já é derivada do schema). Não há aprovação nem risco de escrita.
2. **Validação humana no PowerPoint real** (a Diretriz exige a etapa 4; eu não consigo executá-la): roteiro manual, com o resultado registrado.
3. **Etapa 2 — β mínimo, só se a Etapa 1 mostrar valor:** `setThemeColor` (e, depois, fundo do slide), **atrás de aprovação**, com a pergunta de reversibilidade respondida **antes**.
4. **γ fica de fora** por ora (maior custo e risco, mesma dependência de versão).

**Não escolho δ** porque a evidência mostra que o Planner **tenta** a capacidade e falha; mas δ é uma resposta válida se o valor para o usuário não justificar o custo.

**Riscos que permanecem:** reversibilidade desconhecida; versão do PowerPoint do usuário desconhecida; `useDestinationTheme` não verificado; amostra de motivação pequena.

---

# Fase 5 — Validação da proposta

| Pergunta | Resposta |
|---|---|
| Baseada em evidência real ou hipótese? | **Parcial.** A necessidade vem de execuções reais (replay, goals de 14/07); a viabilidade técnica vem da **documentação**, **não** de execução. |
| Resolve a causa estrutural ou um sintoma? | A causa (falta de capacidade), não só o sintoma (passo mal formado, já tratado no item (a)). |
| Reduz a complexidade total? | **Não**: acrescenta superfície. Só se justifica por valor. |
| Elimina múltiplas fontes de verdade? | Mantém uma: a lista de ações vem do schema (item (a)). |
| Mantém a filosofia do Cognitive Kernel? | Sim: a leitura **fornece fatos**; a escrita fica atrás do gate de aprovação existente, não decide pelo Planner. |
| Incremental e reversível? | Etapa 1 sim (só leitura, reversível por remoção). Etapa 2 **depende de uma resposta ainda desconhecida** (desfazer). |

---

# Critérios de aceitação (Etapa 1) e testes

| # | Critério | Como se verifica |
|---|---|---|
| E1 | `getPresentation` e `getSlide` entram no `enum`; o hint do item (a) os lista **sem segunda lista a manter** | teste análogo ao S314 |
| E2 | Sem `PowerPointApi` suficiente, o add-in devolve `unsupported`, nunca um valor inventado | teste do broker com cliente simulado |
| E3 | Texto de slide chega ao Planner **delimitado e rotulado como dado**, com teto por campo e total; conteúdo imperativo não vira instrução | teste análogo a RFC-008 A8 |
| E4 | Nenhuma ação de leitura exige aprovação; nenhuma ação de escrita é adicionada nesta etapa | revisão do diff |
| E5 | Regressão completa verde; `tsc` limpo | `npm run test:regression` |
| E6 | **Validação manual no PowerPoint real**, com roteiro e resultado registrados | **depende do usuário** |
| E7 | Replay com LLM real do pedido de 14/07 repetido **com a capacidade de leitura**, protocolo pré-registrado | mesmo instrumento do RC1 |

---

# Decisões que dependem do usuário

1. **Avançar ou escolher δ** (não construir)?
2. Se avançar, **aprovar a Etapa 1 (α, só leitura)** como primeiro incremento?
3. **Qual a versão do seu PowerPoint** (Windows com assinatura: 2601 ou superior)? Isso decide se tema e fundo (1.10) estão disponíveis para a Etapa 2.
4. **Você aceita fazer a validação manual** no PowerPoint real (critério E6)? Sem ela a Etapa 1 não pode ser declarada validada.
5. Para a Etapa 2: **a reversibilidade** (o Ctrl+Z desfaz uma edição feita pelo suplemento?) precisa ser respondida **antes** de qualquer escrita.
