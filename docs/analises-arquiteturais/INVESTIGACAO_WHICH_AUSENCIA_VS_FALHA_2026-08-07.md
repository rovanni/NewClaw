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

**Não foi medido** se a falha de fato ocorre nesta ou em qualquer máquina. O que esta investigação
estabelece é o que aconteceria se ocorresse — e isso varia muito por consumidor.

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
`packageManager` alimenta comandos de instalação.

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

* **Não foi medida** a frequência real de falha de `where.exe`/`which` em nenhuma plataforma. Todo o
  documento trata de consequência condicional.
* Não foi verificado se `execFileSync` com `timeout: 3000` chega a estourar nas condições de uso
  deste projeto.
* Não foram examinados consumidores indiretos que recebam `commandExists` por injeção além dos dois
  pontos do `GoalExecutionLoop`.
* A relação com a instabilidade do `S158` **permanece não estabelecida** — este documento não a
  assume nem a descarta.

## 6. Conclusão factual

`which()` reporta ausência quando não conseguiu verificar, o que `NUNCA_ADIVINHAR.md` §4 proíbe. O
alcance é de quatro consumidores, com consequências que vão de inofensiva a **selecionar o
gerenciador de pacotes errado** e a **anular silenciosamente a garantia de visibilidade da Sprint
028**.

A correção exige decisão por consumidor, não um ajuste na primitiva.

**Nenhuma correção é proposta neste documento.**
