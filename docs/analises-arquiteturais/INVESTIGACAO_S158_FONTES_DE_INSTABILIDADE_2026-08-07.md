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
