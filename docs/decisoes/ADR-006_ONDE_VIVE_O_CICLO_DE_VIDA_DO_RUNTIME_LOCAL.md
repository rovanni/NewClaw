# ADR-006 — Onde vive a capacidade de ciclo de vida do runtime local

> **Status:** decisão tomada em 06/08/2026. Sprint 019 da `RFC-005`.
>
> Escopo: **onde** mora a capacidade de conhecer e controlar o servidor de modelo local. Não altera
> nenhuma política já decidida pela `ADR-002` — em particular, §2.3 (o NewClaw nunca religa o
> modelo sozinho) sai desta ADR mais forte, não mais fraca.
>
> Esta ADR **decide localização, não implementa**. O movimento de código é a Sprint 020.

## 1. Contexto

A `RFC-005` deixou esta como questão aberta #4, herdada da Fase 0. O achado que a originou:

A capacidade de ciclo de vida do runtime local **não está ausente — está implementada, madura e
testada** (`S171`), em `src/dashboard/routes/models.ts`. Ela faz `spawn` desacoplado, `kill` sob
pedido, persiste estado em `data/local-model-server.json`, reencontra um servidor sobrevivente após
restart e valida o modelo pedido contra a listagem real da pasta.

O problema é de localização. `ProviderFactory`/`CircuitBreaker` não conseguem distinguir um
runtime **desligado pelo usuário** (estado normal, reversível com um clique) de um **realmente
avariado** — e por isso acumulam falhas indevidamente. Observado em produção:
`CIRCUIT-OPEN: Skipping 'Modelo local' (failures: 72)`.

A informação que permitiria a distinção existe. Ela mora numa camada de apresentação.

## 2. O que exatamente está no lugar errado

A investigação desta Sprint encontrou que `models.ts` contém **duas capacidades separáveis**, e
que apenas uma delas é necessária ao Core:

| Capacidade | O que faz | Quem precisa |
|---|---|---|
| **Diagnóstico** (leitura) | `readServerState()` + teste de vida do PID → `getLastKnownLocalServer()` | Dashboard **e** `ProviderFactory` |
| **Atuação** (escrita) | `spawn` do servidor, `kill`, `adoptRunningServer`, descoberta do binário, validação do arquivo | Somente o Dashboard |

Três fatos do código sustentam a separação:

1. **O diagnóstico já é exportado e já tem a forma certa.**
   `getLastKnownLocalServer(): { file: string; port: number; running: boolean } | null`
   ([`models.ts:208`](../../src/dashboard/routes/models.ts)) — barato, síncrono, sem I/O de rede,
   por decisão explícita registrada no próprio comentário (roda no caminho de polling do
   dashboard).
2. **Ele tem um único consumidor de produção**: `src/dashboard/routes/providers.ts:96`. Não é uma
   capacidade entranhada em muitos pontos; é um ponto só.
3. **A metade cara do sinal já é gratuita para quem precisa dele.** A `RFC-005` define
   `avariado` como "PID vivo **e** porta respondendo, e ainda assim falhou". O `ProviderFactory`
   faz essa classificação **no instante em que uma requisição acabou de falhar** — a requisição
   falhada *é* a verificação de porta. Sobra apenas o teste de PID, que é exatamente o que
   `getLastKnownLocalServer()` já faz.

Ou seja: o Core não precisa de uma capacidade nova, nem de uma versão mais cara da existente.
Precisa alcançar uma função que já existe, já é barata e já devolve a forma certa.

## 3. Problema arquitetural

`src/core/ProviderFactory.ts` importar de `src/dashboard/` inverteria a arquitetura de camadas: o
Core passaria a depender da apresentação. A direção correta já é a praticada — `models.ts` importa
`core/modelCapabilityHeuristics`, `providers.ts` importa `core/OpenAIProvider`, e assim por diante.

**Precedente aparente que não vale como licença.** `src/memory/MemoryManager.ts:26` importa
`dashboard/DashboardMemoryRepository`. É uma inversão real, mas de outra natureza: o
`MemoryManager` detém o handle do banco e apenas *constrói* uma classe cujo comportamento é do
dashboard — não consome capacidade de apresentação para decidir nada. Registrado aqui para não ser
usado como argumento a favor de repetir o padrão; se algo, é um vazamento de fronteira próprio, de
escopo separado.

## 4. Alternativas consideradas

### A — Manter no Dashboard e expor por HTTP ao Core
**Descartada** (já em `RFC-005`, A4). O Core passaria a depender de uma camada de apresentação
*pela rede*, e o diagnóstico existiria apenas quando o servidor HTTP estivesse no ar. Resolve o
sintoma piorando a estrutura.

### B — Mover a capacidade inteira (diagnóstico + atuação) para um serviço de domínio
**Descartada**, por uma razão que só apareceu ao separar as duas metades:

Mover `spawn`/`kill` para o Core daria à camada com o **maior motivo** para religar o modelo — um
provider cuja requisição acabou de falhar — os **meios** para fazê-lo. A `ADR-002` §2.3 proíbe
isso por política; manter a atuação fora do Core transforma a proibição em **garantia estrutural**.
Uma regra que o código não tem como violar é melhor que uma regra que ele apenas não viola hoje.

Secundariamente, `spawn`, descoberta de binário e validação de caminho arrastariam preocupações de
processo e filesystem para dentro do domínio, sem consumidor que as justifique.

### C — Mover **apenas o diagnóstico** para um módulo de domínio; atuação fica na rota
**Escolhida.** Ver Seção 5.

### D — `ProviderFactory` lê `data/local-model-server.json` diretamente
**Descartada.** Criaria uma segunda implementação da interpretação do arquivo (formato, caminho,
o que "vivo" significa) em dois módulos, para divergirem na primeira mudança. É a classe de defeito
que `ADR-005` §4.1 descarta explicitamente — e o caminho do arquivo viraria contrato implícito em
dois lugares.

### E — Injeção do sinal pela raiz de composição
Atraente: o Core permaneceria ignorante, recebendo uma função leitora injetada por
`AgentController`. **Descartada como primária** porque o módulo leitor teria que morar em algum
lugar: se ficar no dashboard, a inversão apenas sobe um nível, e o diagnóstico passa a existir
**somente quando o dashboard foi construído** — precisamente uma recuperação "correta porém
inalcançável", o defeito que `LOCALIDADE_DA_RECUPERACAO.md` existe para impedir. Se o leitor for de
domínio, a alternativa colapsa em C.

## 5. Decisão

1. **O diagnóstico do runtime local passa a viver em `src/core/`**, como módulo de leitura, sem
   estado mutável e sem I/O de rede — o mesmo contrato que `getLastKnownLocalServer()` já respeita.
2. **A atuação (`spawn`, `kill`, adoção, descoberta de binário, validação de arquivo) permanece em
   `src/dashboard/routes/models.ts`.** O Core não ganha, em nenhum momento, a capacidade de subir
   um servidor de modelo.
3. **`src/dashboard/routes/models.ts` passa a consumir o módulo de domínio** em vez de definir o
   diagnóstico. `providers.ts` continua funcionando pelo mesmo caminho, agora reexportado ou
   importado do novo local — decisão de detalhe da Sprint 020.
4. **`ProviderFactory` consome o mesmo módulo** para classificar o estado, conforme a taxonomia da
   `RFC-005`.

### 5.1 A regra que a decisão cria

> O Core pode **saber** o estado de um runtime local. Não pode **mudá-lo**.

Saber é o que a Localidade da Recuperação exige (o diagnóstico precisa ser alcançável de onde a
falha ocorre). Mudar é o que a `ADR-002` §2.3 proíbe. As duas coisas coexistem sem tensão porque
são capacidades diferentes — e foi só ao separá-las que isso ficou visível.

## 6. Gate obrigatório — Extensão antes de Criação

Um arquivo novo em `src/core/` é proposto. As quatro perguntas, respondidas:

**1. Este arquivo realmente precisa existir?** Sim — mas como **destino de um movimento**, não como
código novo. A lógica já existe e será realocada, não escrita.

**2. Existe implementação já presente que resolve parte disso?** Sim, e é justamente a que se move:
`readServerState()` e `getLastKnownLocalServer()` em `src/dashboard/routes/models.ts`.

**3. Existe extensão pequena de algo já existente que elimine a necessidade do arquivo?** Dois
candidatos em `src/core/` foram examinados e ambos descartados por razão concreta:

| Candidato | Por que não |
|---|---|
| `src/core/ModelRegistryService.ts` | Já importa `ProviderFactory`. Como `ProviderFactory` passaria a importar o diagnóstico, o movimento criaria dependência circular |
| `src/core/modelCapabilityHeuristics.ts` | Heurística pura por nome de arquivo — sem `fs`, sem `process`. Acrescentar leitura de disco e teste de PID destruiria a coesão do módulo |

**4. Prova de que é inevitável:** o módulo precisa ser importável por
`src/core/ProviderFactory.ts` **e** por `src/dashboard/routes/models.ts` sem inverter camadas.
Nenhum módulo de domínio existente satisfaz isso sem ciclo (ModelRegistryService) ou sem perda de
coesão (modelCapabilityHeuristics). Um módulo pequeno e novo em `src/core/` é o único lugar que
satisfaz as duas restrições.

**Nenhuma Tool, Skill ou Script novo.** Nenhuma capacidade nova de runtime.

## 7. O que esta ADR NÃO muda

* **`ADR-002` §2.3 permanece integralmente.** O NewClaw continua sem religar o modelo sozinho — e
  agora sem sequer poder fazê-lo a partir do Core.
* **`ADR-002` §2.4 permanece.** O registro continua sobrevivendo à morte do processo, e sua mera
  presença continua **não** significando "deveria estar de pé".
* **Nenhuma política de substituição é decidida aqui.** Isso é `RFC-005`, Sprints 020-022.
* **O Dashboard continua sendo quem sobe e derruba o servidor**, pelo mesmo botão, com o mesmo
  fluxo.

## 8. Consequências e migração

**Duas regressões estão acopladas à localização atual** e precisarão acompanhar o movimento na
Sprint 020 — nomeadas aqui para que não sejam descobertas como quebra:

* `S171_LocalModelServer_Lifecycle` importa `getLastKnownLocalServer` de
  `../../dashboard/routes/models` e fatia o **texto-fonte** do arquivo entre `adoptRunningServer` e
  `export function getLastKnownLocalServer` para asserções estruturais.
* `S182_DashboardConfig_SaveTraceAndRealReadiness` casa por **regex a assinatura exportada** dentro
  do fonte da rota.

Ambas continuam válidas como intenção; o que muda é onde procuram. Isso é consequência esperada de
mover código coberto por teste estrutural, não sinal de que o movimento está errado — mas é
exatamente o tipo de detalhe que, não registrado, vira "a Sprint 020 quebrou dois testes".

**Reversibilidade:** alta. O movimento é um recorte de duas funções sem estado mutável; reverter é
movê-las de volta e restaurar os dois imports.

## 9. Validação exigida

Segue a Validação Progressiva. As etapas 1-3 na Sprint 020, junto do movimento; a etapa 4 na
Sprint 024, com o comportamento completo.

O cenário de execução real que esta decisão precisa ver funcionando, em instância isolada:

1. Declarar um modelo local e carregá-lo pelo dashboard.
2. Encerrá-lo deliberadamente (botão).
3. Disparar um turno.
4. **Esperado:** `ProviderFactory` classifica `parado_por_decisao`, o contador de falhas do recurso
   local permanece em zero, e o usuário é informado — nunca recebe resposta de nuvem em silêncio.

O passo 4 é o que distingue esta ADR de um refactor: se o contador subir, o movimento aconteceu e
o problema continua.

## 10. Limites conhecidos

* **Herda o limite de plataforma da `ADR-002` §3:** o teste de vida do PID
  (`process.kill(pid, 0)`) é multiplataforma no Node, mas só foi exercitado no Windows. Fora dele,
  o estado provável é `indeterminado` — degradação correta, sem o benefício.
* **Um servidor por vez** continua valendo (`ADR-002` §3). O diagnóstico responde sobre *o* runtime
  local declarado, não sobre um conjunto.
* **A decisão cobre o runtime local do llamafile.** Outros runtimes com ciclo de vida (LM Studio,
  vLLM) não têm hoje nenhum gerenciamento no NewClaw; quando tiverem, esta ADR é o precedente a
  seguir, não um contrato já escrito para eles.
