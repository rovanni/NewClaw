# Investigação — fontes de instabilidade do `S158`

**Data:** 2026-08-07
**Estado do código investigado:** `b4abf4b`
**Natureza:** investigação. **Não é RFC, não é ADR, não contém proposta de correção.**

> Registra o que foi **refutado**, o que foi **estreitado** e o que **permanece indeterminado**.
> A causa da instabilidade do `S158` continua sem explicação confirmada.

## 1. Objetivo

`docs/issues/021-s158-flaky-dedup-vs-ciclo-de-verificacao.md` registra uma hipótese principal
(conflito entre o dedup da issue 020 e o ciclo de verificação da `RFC-003`) e um achado secundário
(a suíte não isola estado entre testes). Esta investigação nasceu de o `S158` falhar durante a série
RFC-005 e ter sido preciso decidir, ali, se a falha era consequência daquelas Sprints.

## 2. Metodologia

Leitura do teste, da primitiva de sondagem e do runner da suíte; execuções isoladas e completas.
Nenhuma alteração de código.

**Observações de execução acumuladas na série:** `S158` falhou **uma vez** em aproximadamente seis
execuções da suíte completa, e passou nas duas execuções isoladas feitas logo em seguida.

## 3. O que foi REFUTADO

### 3.1 O achado secundário da issue 021 não descreve este teste

A issue afirma: *"`S158` depende de conhecimento aprendido persistido, e o resultado muda conforme o
que ficou gravado de execuções anteriores"*.

O teste cria seus bancos com `new Database(':memory:')` — duas vezes
([`S158…test.ts:97`](../../src/__tests__/regression/S158_RFC003_SprintF_FullCycleIntegration.test.ts)
e `:128`). **Nada persiste entre execuções.** A caracterização não corresponde ao código atual.

### 3.2 A instabilidade não vem de contenção entre testes

Hipótese levantada durante esta investigação — e descartada por ela mesma. O runner
(`scripts/run-regression-tests.cjs:33`) usa `spawnSync` dentro de um laço: os testes rodam **um de
cada vez**. Não há paralelismo, portanto não há contenção de processos a explicar diferença entre
rodar isolado e rodar na suíte.

Registrado porque foi apresentado ao operador com mais confiança do que a evidência sustentava,
antes de o runner ser verificado.

## 4. O que foi ESTREITADO

A única entrada do `S158` capaz de mudar o desfecho conforme o ambiente é a sondagem de existência
de binário:

* o teste escolhe um binário real do ambiente (`whoami`/`hostname`/`sh`/`cmd`) via `commandExists`;
* o caminho de produção **re-sonda** o ambiente: `GoalExecutionLoop.ts:1385` e `:1995` passam
  `commandExists` para `OperationalKnowledge.captureFromGoal()`, e é esse veredito que decide se o
  conhecimento é aprendido — exatamente o que o caso `S158.1b` afirma.

As demais variações do teste (`Date.now()`, `Math.random()`) alimentam apenas identificadores, não
o desfecho.

**Isto não é a causa comprovada.** É a redução do espaço de busca: se a instabilidade vier do
ambiente, entra por aqui.

> **Superado pela medição de 08/08/2026 (Seção 9).** As asserções que de fato falham são de
> promoção de confiança, não de detecção de ambiente. A sondagem de binário deixou de ser a
> suspeita principal. Este parágrafo fica como registro do que se pensava antes de medir.

## 5. Achado independente — `which()` não distingue ausência de falha

Verdadeiro por leitura, e **independente** de o `S158` ser instável ou não
([`src/utils/crossPlatform.ts`](../../src/utils/crossPlatform.ts)):

```ts
export function which(cmd: string): string | null {
    try {
        const result = execFileSync(bin, [cmd], { timeout: 3000, ... });
        return result || null;
    } catch { return null; }
}
```

Qualquer falha — timeout de 3 s, erro de spawn, permissão — vira `null`, e `commandExists()` traduz
`null` para **"o comando não existe"**. O chamador não tem como distinguir *"verifiquei e não há"*
de *"não consegui verificar"*.

É a mesma distinção que a Sprint 020 precisou introduzir em `readLocalRuntimeRecord` (`absent` ×
`unreadable`), e o comportamento que `docs/ARCHITECTURE/NUNCA_ADIVINHAR.md` §4 proíbe —
*"deixar rastreável a diferença entre 'verifiquei e não há' e 'não tentei verificar'"*.

Aqui a consequência é maior que um teste instável: esse veredito alimenta o aprendizado operacional
e a resolução de dependências de todo o sistema.

## 6. O que permanece INDETERMINADO

* **A causa da instabilidade do `S158`.** Nenhuma das hipóteses examinadas está confirmada.
* **A hipótese PRINCIPAL da issue 021** — o conflito entre o dedup da issue 020 e o ciclo de
  verificação da `RFC-003` — **não foi examinada** nesta investigação e continua aberta. Ela não é
  afetada pela refutação do §3.1, que trata do achado *secundário*.
* **Se o `which()` chega a falhar na prática nesta máquina.** Não foi medido.

## 7. Limites

* Uma única falha observada, sem instrumentação: não houve captura de qual asserção falhou naquela
  execução. Sem isso, qualquer atribuição de causa é conjectura.
* Não foi medida a latência real de `where.exe` sob as condições da suíte.
* O passo 1 do plano da própria issue 021 — *"instrumentar `S158` para registrar se a 1ª chamada da
  ferramenta de teste falhou na rodada"* — **continua não executado**, e é ele que produziria a
  evidência que falta.
* Nenhuma alteração foi feita em `which()`: ele é consumido por toda a detecção de dependências, e
  mudar o contrato dele é decisão de escopo próprio.

## 8. Conclusão factual

Do que a issue 021 registra, **apenas o achado secundário foi refutado**: o `S158` não depende de
estado persistido. A hipótese principal segue aberta e não examinada.

A investigação estreitou o espaço de busca para a sondagem de ambiente, e encontrou, de passagem, um
defeito independente e verificável: `which()` reporta ausência quando na verdade não conseguiu
verificar.

**Nenhuma correção é proposta neste documento.**

---

# 9. Medição de 08/08/2026

Síntese dos fatos que passaram a fazer parte da base de conhecimento do projeto. O backlog e o
plano de ação continuam em `docs/issues/021-…` (local, fora do versionamento — ver Seção 10).

## 9.1 Metodologia

30 execuções **isoladas** do `S158` (~13 s cada, uma de cada vez, fora da suíte), registrando código
de saída e log completo de cada rodada. Nenhuma alteração no teste nem no código sob teste.

A pergunta que a medição respondeu vem **antes** do passo 1 do plano da issue: *ele falha isolado?*
Duas execuções isoladas anteriores tinham sugerido que não — amostra pequena demais contra um evento
raro, e foi essa leitura que a medição corrigiu.

## 9.2 Resultado

| Medida | Valor |
|---|---|
| Falhas | **2 em 30 — 6,7%** (rodadas 2 e 27) |
| Asserções que falharam | as mesmas nas duas: **`S158.3` e `S158.4`** |
| Outras asserções | nenhuma falhou em nenhuma das 30 rodadas |

**Assinatura observada:** `S158.3` (*"após a 2ª verificação real bem-sucedida,
`computeConfidenceLevel()` eleva a confiança a `validated`"*) falha, e `S158.4` cai por depender
dela. É uma assinatura estreita e estável — a promoção de conhecimento a `validated` não acontece.

## 9.3 Hipóteses refutadas

| Hipótese | Origem | Por quê caiu |
|---|---|---|
| Estado aprendido persistido entre execuções | achado secundário da issue 021 | O teste usa `:memory:` nos dois bancos; nada acumula |
| Contenção entre testes paralelos | levantada nesta investigação | O runner usa `spawnSync` em laço — execução sequencial |
| "Falha na suíte, passa isolado" | leitura desta investigação | Ele falha isolado, a 6,7%; a distinção era ruído de amostra |

## 9.4 O que a medição NÃO estabeleceu

* **A causa da instabilidade permanece indeterminada.** A assinatura observada é compatível com a
  hipótese principal da issue 021 (o dedup da issue 020 bloqueando a 2ª verificação que a `RFC-003`
  exige), mas o elo central — a 2ª chamada ser de fato deduplicada — **não foi observado
  diretamente**.
* **A explicação da issue para a VARIAÇÃO está refutada**, ainda que a assinatura bata: ela atribui
  a intermitência ao estado acumulado no banco, e não há estado acumulado. O que faz a primeira
  chamada falhar em algumas rodadas e não em outras segue sem explicação.
* **Nenhuma relação causal foi estabelecida entre `which()` e o `S158`.** Ver 9.5.

## 9.5 Por que a ADR-008 existe, e o que ela NÃO resolveu

A `ADR-008` (contrato da sondagem de binário) e as Sprints 034-036 que a implementaram nasceram
**desta investigação**, como **achado lateral**: ao procurar fontes de não-determinismo no `S158`,
encontrou-se que `which()` reportava ausência quando não conseguira verificar — defeito real,
verificável por leitura, medido depois em 3,3% sob CPU saturada
(`INVESTIGACAO_WHICH_AUSENCIA_VS_FALHA_2026-08-07.md`).

**A ADR-008 não explica nem corrige o `S158`.** As asserções que falham são de promoção de
confiança; a sondagem de ambiente ficou fora do caminho. Registrado aqui de forma explícita para que
o histórico do repositório não sugira o contrário: quem encontrar a ADR-008 e esta investigação no
mesmo período deve saber que uma originou a outra, e que a instabilidade original continua aberta.

## 9.6 Causa encontrada (08/08/2026) — e não é o dedup

O passo seguinte não precisou de instrumentação: o dedup **já registra** quando bloqueia
(`ProactiveRecovery.ts:270`, `"repetição bloqueada"`), e os 30 logs guardados respondiam sozinhos.

**Zero bloqueios em 30 rodadas — incluindo as duas que falharam.** A hipótese principal da issue
021 está **refutada no mecanismo**: o dedup nunca disparou. A assinatura que ela previa estava
certa; a explicação, não.

### O que de fato varia

Comparando a rodada 1 (passa) com a 2 (falha), o segundo `OPKNOW-RECORD` grava **um comando
diferente**:

| Rodada | 1º registro | 2º registro | Efeito |
|---|---|---|---|
| 1 | `echo instalando-…` | `echo instalando-…` | mesmo comando → `success_count=2` → elegível |
| 2 | `echo instalando-…` | **`echo verificando-…`** | dois comandos com 1 sucesso cada → nenhum elegível |

A promoção a `validated` exige dois sucessos **do mesmo comando**. Quando a segunda captura grava o
comando de verificação, eles não somam — e `S158.3` cai, levando `S158.4` junto.

### O mecanismo

`OperationalKnowledge.captureFromGoal` escolhe o comando com
[`goal.attempts.find(...)`](../../src/memory/OperationalKnowledge.ts) — o **primeiro** que casar —
e um dos critérios é:

```ts
a.executedAt > blocker.detectedAt
```

Comparação **estrita**, com carimbos de tempo em resolução de milissegundo. O comentário adjacente
nomeia a heurística: *"primeiro sucesso depois do blocker"*.

Timestamps observados na segunda captura de cada rodada:

| Rodada | `blocker.detectedAt` | `fix.executedAt` escolhido | Comando aprendido |
|---|---|---|---|
| 1 | `1786181735142` | `1786181735143` | `instalando` |
| 2 | `1786181745614` | `1786181745616` | `verificando` |

Na rodada 2 o comando de instalação executou **no mesmo milissegundo** em que o blocker foi
detectado. O `>` estrito o descartou da candidatura, e a busca caiu no sucesso seguinte — a
verificação.

**A intermitência é uma corrida em resolução de milissegundo**, não estado, não ambiente, não
dedup. No cenário sintético do teste, blocker e correção acontecem a 1-3 ms de distância; se caírem
no mesmo milissegundo, o comando aprendido é o errado.

### Relação com a ADR-004

A `ADR-004` já tratou uma face deste mesmo defeito — *"verificar não é instalar"* — excluindo
**sondas de existência** (`where`/`which`/`command -v`) da candidatura, depois de a Sprint G ter
observado, em execução real, o sistema aprender um `where` no lugar do comando de instalação.

O filtro dela não alcança este caso: `echo verificando-…` não é sonda de existência. O que a
`ADR-004` corrigiu foi *um tipo de comando errado*; o que resta é a **heurística de ordenação** que
o seleciona — e ela erra sempre que a granularidade do relógio empata com a do fluxo.

### O que isto NÃO conclui

* **Não é proposta de correção.** Decidir entre desempatar por ordem de inserção, usar `>=`, marcar
  o step de instalação explicitamente, ou outra coisa, é desenho — e mexe numa heurística que a
  `ADR-004` já revisou uma vez.
* **Não se sabe se o mesmo empate ocorre em uso real**, fora do cenário sintético do `S158`, onde os
  eventos estão anormalmente próximos. A Sprint G sugere que a família do defeito aparece em
  produção; este empate específico, não foi observado lá.

# 10. Nota de rastreabilidade

O commit `a23428e` (Sprint 030) versionou **apenas este documento**. A atualização correspondente da
`docs/issues/021-…` permaneceu **local**, porque `docs/issues/` está no `.gitignore` (linha 10) — o
`git add -A` a ignorou em silêncio, e a mensagem daquele commit afirma ter corrigido a issue.
Corrigido aqui para manter o histórico preciso.

A separação é deliberada e continua valendo: `docs/issues/` é backlog e espaço de investigação
local; `docs/analises-arquiteturais/` preserva a evidência que influencia o entendimento técnico do
projeto. Pelo mesmo critério, a correção de boot registrada em `.claude/skills/verify/SKILL.md`
permanece local — descreve o ambiente de trabalho deste clone, não o produto.
