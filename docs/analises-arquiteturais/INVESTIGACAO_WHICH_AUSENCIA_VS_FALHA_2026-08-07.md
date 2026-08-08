# Investigação — `which()` não distingue ausência de falha

**Data:** 2026-08-07
**Estado do código investigado:** `a23428e`
**Natureza:** investigação (Fases 1-2). **Não é RFC, não é ADR, não contém proposta de correção.**

## 1. Objetivo

Mapear o alcance de um defeito verificável por leitura, encontrado de passagem na investigação do
`S158` (`INVESTIGACAO_S158_FONTES_DE_INSTABILIDADE_2026-08-07.md` §5), e determinar se a correção é
local ou exige mudança de contrato.

## 2. O defeito

`src/utils/crossPlatform.ts`:

```ts
export function which(cmd: string): string | null {
    try {
        const result = execFileSync(bin, [cmd], { timeout: 3000, ... });
        return result || null;
    } catch { return null; }
}
export function commandExists(cmd: string): boolean { return which(cmd) !== null; }
```

Qualquer falha do `try` — timeout de 3 s, erro de spawn, permissão negada, PATH corrompido — vira
`null`, e `commandExists()` traduz `null` em **"o comando não existe"**.

O chamador não tem como distinguir *"verifiquei e não há"* de *"não consegui verificar"*. É o que
`docs/ARCHITECTURE/NUNCA_ADIVINHAR.md` §4 proíbe explicitamente, e a mesma distinção que a Sprint
020 precisou introduzir em `readLocalRuntimeRecord` (`absent` × `unreadable`).

A frequência real foi **medida** em 07/08/2026 — ver Seção 2.1. Resumo: não falha com a máquina
ociosa; falha em **3,3%** das sondagens com a CPU saturada, sempre por timeout.

### 2.1 Medição (07/08/2026, Windows 11 26200, 28 CPUs)

Réplica exata da chamada de `which()`, registrando o que o `catch` descarta.

| Cenário | n | p50 | p99 | máx | Falhas |
|---|---|---|---|---|---|
| Comando existente, máquina ociosa | 400 | 157 ms | 196 ms | 196 ms | **0** |
| Comando existente, CPU saturada (56 processos / 28 CPUs) | 150 | 152 ms | **3.418 ms** | 3.581 ms | **5 (3,3%)** |
| Comando inexistente, ociosa | 200 | 168 ms | 217 ms | 219 ms | — (todas `exit 1`) |

**Com a máquina ociosa a margem é de ~15×** (196 ms contra o teto de 3.000 ms) — nessas condições o
defeito é teórico. **Sob saturação, o p99 ultrapassa o teto** e a sondagem falha por `ETIMEDOUT`;
nesses casos `commandExists('whoami')` devolve `false` para um comando que certamente existe.

O cenário de saturação **não é artificial para este projeto**: o NewClaw existe para rodar modelos
locais, e inferência local é exatamente o tipo de carga que satura a máquina. A condição que produz
o falso negativo é a condição de uso que o projeto persegue.

**Causas observadas, todas distinguíveis no objeto de erro:**

| Situação | Como se apresenta |
|---|---|
| Comando não existe | `status: 1` (código de saída do `where.exe`) |
| Timeout | `code: 'ETIMEDOUT'`, `signal: 'SIGTERM'`, `status: null` |
| Binário de sondagem inalcançável (PATH vazio) | `code: 'ENOENT'` |

Este é o achado que mais importa para uma decisão futura: **a informação que distingue ausência de
falha já existe e é descartada**. `catch { return null }` joga fora `status`, `code` e `signal`.
Não é preciso construir mecanismo novo — basta parar de apagar o que o Node já entrega.

Não foram medidas outras plataformas (Linux/macOS usam `which`, binário e comportamento
diferentes), nem cenários de permissão ou antivírus.

## 3. Consumidores e consequência de um falso negativo

| # | Consumidor | Consequência | Severidade |
|---|---|---|---|
| 1 | `CapabilityRegistry.ts:324-327` | Escolhe o gerenciador de pacotes **errado** | **Alta** |
| 2 | `send_audio.ts:292` (`findPiperInstallation`) | Anula a garantia da Sprint 028 | **Alta** |
| 3 | `integrationChecker.ts:165` | Reporta integração configurada como ausente | Média |
| 4 | `GoalExecutionLoop.ts:1385`, `:1995` | Deixa de aprender | Baixa |

### 3.1 `CapabilityRegistry` — o falso negativo vira resposta positiva errada

```ts
if      (which('apt-get')) packageManager = 'apt';
else if (which('yum'))     packageManager = 'yum';
else if (which('pacman'))  packageManager = 'pacman';
else if (which('apk'))     packageManager = 'apk';
```

Numa máquina Debian, se a sondagem de `apt-get` falhar, a cadeia **continua** e pode responder
`yum`. O resultado não é "não sei qual é" — é **outro gerenciador**, afirmado como fato. E
`packageManager` entra no bloco `[CAPACIDADES DO AMBIENTE]` que vai para o LLM
(`CapabilityRegistry.describeEnvironment`) — ele não executa nada; é evidência apresentada à camada
de julgamento como fato verificado. *(Precisão corrigida na Sprint 034: a redação original dizia
"alimenta comandos de instalação".)*

É o caso mais grave do levantamento porque o `else if` encadeado converte uma sondagem falha numa
afirmação positiva incorreta. Os demais consumidores degradam para ausência; este degrada para
erro.

### 3.2 `send_audio` — anula a garantia recém-construída

```ts
if (!existsSync(model) || !existsSync(config)) return null;   // o usuário DECLAROU o TTS local
const piperBin = process.env.PIPER_BIN || which('piper');
if (!piperBin) return null;                                    // ...e a declaração é perdida aqui
```

A declaração do usuário é visível no `existsSync` — os modelos do Piper estão em disco, e
`SOBERANIA_DA_CONFIGURACAO.md` §1.1 trata a presença deles como sinal de intenção. Mas se a
sondagem do binário falhar, `findPiperInstallation()` devolve `null`, `generateAudio()` **nem entra
no bloco do Piper**, nenhum fato é empilhado, e o áudio vai para o serviço da Microsoft **em
silêncio**.

Ou seja: o defeito reintroduz exatamente a violação que a Sprint 028 fechou, por um caminho
diferente — e sem deixar rastro, porque o `catch` que produz o fato nunca é alcançado.

Quem define `PIPER_BIN` explicitamente não é afetado.

### 3.3 `integrationChecker` — diagnóstico que mente na direção errada

`which(signalCliPath) ? signalCliPath : 'not_found'`. Uma auditoria de integrações reportaria
`not_found` para um `signal-cli` presente e configurado. Erra na direção que gera trabalho inútil,
não na que esconde problema.

### 3.4 `GoalExecutionLoop` — falha para o lado seguro

`captureFromGoal(goal, commandExists)` usa o veredito para decidir se credita aprendizado. Um falso
negativo faz o sistema **não aprender** — que é o comportamento que `ADR-003` escolheu
deliberadamente para o caso de dúvida (*"silêncio em vez de chute"*). Aqui o defeito produz, por
acidente, o resultado que a arquitetura já queria.

## 4. Local ou de contrato?

**De contrato.** Uma correção puramente local em `which()` — por exemplo, relançar em vez de
devolver `null` — mudaria o comportamento dos quatro consumidores de uma vez, e três deles hoje
dependem de `null` significar "não existe" para não quebrar.

Cada consumidor precisa de uma decisão própria sobre o que fazer diante de "não consegui verificar":

* o `CapabilityRegistry` precisa parar de encadear `else if` sobre sondagens que podem falhar;
* o `send_audio` precisa decidir se sondagem indeterminada conta como declaração perdida ou como
  motivo para anunciar;
* o `integrationChecker` precisa poder dizer "não verificável";
* o `GoalExecutionLoop` provavelmente não muda.

Isso é desenho, não conserto — e por isso nada foi alterado aqui.

## 5. Limites

* A medição da §2.1 cobre **apenas Windows**. Linux e macOS usam `which`, um binário e um caminho de
  execução diferentes — a latência e o comportamento sob carga não foram medidos lá.
* **Permissões e antivírus não foram testados** como causa. A classificação prevê `EPERM`/`EACCES`,
  mas nenhuma ocorrência foi observada.
* A saturação foi induzida artificialmente (processos ocupando CPU). Não foi medida sob a carga
  real de uma inferência local em andamento, que é o cenário equivalente no uso do projeto.
* A medição usou um comando conhecido (`whoami`). Binários em diretórios de rede ou em PATH longo
  podem se comportar diferente.
* Não foram examinados consumidores indiretos que recebam `commandExists` por injeção além dos dois
  pontos do `GoalExecutionLoop`.
* A relação com a instabilidade do `S158` **permanece não estabelecida** — este documento não a
  assume nem a descarta.

## 6. Conclusão factual

`which()` reporta ausência quando não conseguiu verificar, o que `NUNCA_ADIVINHAR.md` §4 proíbe. O
alcance é de quatro consumidores, com consequências que vão de inofensiva a **selecionar o
gerenciador de pacotes errado** e a **anular silenciosamente a garantia de visibilidade da Sprint
028**.

A falha **ocorre na prática**: 3,3% das sondagens sob CPU saturada, no Windows, sempre por timeout —
e nenhuma com a máquina ociosa. A condição que a produz é a mesma que o projeto persegue (inferência
local saturando a máquina), o que a torna mais provável em uso real do que a medição ociosa sugeriria.

A informação que separa "não existe" de "não consegui verificar" **já é produzida pelo Node** e
descartada pelo `catch`. Uma decisão futura sobre o terceiro estado não precisa construir mecanismo
novo; precisa decidir o que cada consumidor faz com ele.

A correção exige decisão por consumidor, não um ajuste na primitiva.

**Nenhuma correção é proposta neste documento.**
