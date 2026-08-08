# ADR-008 — Contrato da sondagem de binário

> **Status:** decisão tomada em 07/08/2026. Sprint 033.
>
> Escopo: **o que a sondagem de existência de binário devolve**, e o que cada consumidor faz com
> isso. Não é sobre `which()` — é sobre o contrato que ele implementa.
>
> **Decide contrato, não implementa.** O código é trabalho de Sprints posteriores, incrementais.
>
> Base factual: `docs/analises-arquiteturais/INVESTIGACAO_WHICH_AUSENCIA_VS_FALHA_2026-08-07.md`,
> incluindo a medição da §2.1. Código conferido em `90f0833`.

## 1. Contexto

`commandExists(cmd): boolean` devolve dois estados. A sondagem por baixo produz **três**:

```ts
export function which(cmd: string): string | null {
    try { ... } catch { return null; }   // aqui morrem status, code e signal
}
```

Qualquer falha vira `null`, e `null` vira "o comando não existe".

## 2. Evidência

Medição de 07/08/2026 (Windows 11, 28 CPUs), réplica exata da chamada:

| Cenário | n | máx | Falhas |
|---|---|---|---|
| Comando existente, máquina ociosa | 400 | 196 ms | **0** |
| Comando existente, CPU saturada (56 proc / 28 CPUs) | 150 | 3.581 ms | **5 (3,3%)** |

Todas as falhas por `ETIMEDOUT`, contra um teto de 3.000 ms. Nelas, `commandExists('whoami')`
devolve `false` para um comando que certamente existe.

Dois fatos da medição sustentam esta ADR mais do que a hipótese original:

1. **Ociosa, o defeito é teórico** (margem de ~15×). **Saturada, é real.** E saturação é a condição
   de uso que este projeto persegue: o NewClaw existe para rodar modelos locais, e inferência local
   satura a máquina.
2. **A informação que distingue os três casos já é produzida pelo Node** e descartada:
   ausência = `status: 1`; timeout = `code: 'ETIMEDOUT'` + `signal: 'SIGTERM'`; sondador
   inalcançável = `code: 'ENOENT'`.

Não há mecanismo a construir. Há um `catch` que apaga o que já existe.

## 3. Alternativas consideradas

### A — Aumentar o timeout
**Descartada como solução**, registrada como paliativo. Reduz a frequência sem eliminar a
confusão: qualquer teto tem um percentil acima dele, e a resposta continuaria sendo "não existe".
Também custa latência no caso legítimo de ausência, que hoje responde em ~170 ms.

Registrada aqui para que ninguém "conserte" isso subindo o número.

### B — `which()` lança em vez de devolver `null`
**Descartada.** Mudaria os quatro consumidores de uma vez, e três deles hoje dependem de `null`
significar "não existe". Trocaria um falso negativo silencioso por uma exceção não tratada em
caminhos que hoje funcionam.

### C — Terceiro estado no contrato, colapso decidido por consumidor
**Escolhida.** Ver Seção 4.

### D — Terceiro estado com comportamento único imposto a todos
**Descartada.** Os consumidores têm consequências opostas para o mesmo falso negativo: no
`GoalExecutionLoop` ele produz o resultado seguro (não aprender), no `CapabilityRegistry` produz uma
resposta positiva errada. Um comportamento único degradaria um dos dois lados.

## 4. Decisão

### 4.1 A sondagem passa a expor três estados

O contrato deixa de ser booleano e passa a distinguir:

| Estado | Significado |
|---|---|
| **encontrado** | verificado, existe (com o caminho) |
| **ausente** | verificado, não existe |
| **indeterminado** | **não foi possível verificar** — com a causa observada |

`commandExists(cmd): boolean` **permanece**, como conveniência para quem legitimamente quer colapsar
— mas o colapso passa a ser uma escolha declarada de quem chama, não um efeito colateral do `catch`.

### 4.2 Cada consumidor decide o próprio colapso

**A regra é local, de propósito.** Impor um comportamento único é a alternativa D, descartada.

#### `CapabilityRegistry` — o mais crítico

Hoje:

```ts
if      (which('apt-get')) packageManager = 'apt';
else if (which('yum'))     packageManager = 'yum';
...
```

**Decisão: indeterminado interrompe a cadeia.** `packageManager` fica `undefined` e nenhum candidato
seguinte é testado.

É o único consumidor onde o falso negativo produz **resposta positiva errada** em vez de ausência:
numa máquina Debian cuja sondagem de `apt-get` falhe, a cadeia hoje continua e pode responder `yum`
— e `packageManager` entra no bloco `[CAPACIDADES DO AMBIENTE]` entregue ao LLM
(`CapabilityRegistry.describeEnvironment`). "Não sei" é correto; "yum" é falso.

> **Correção de precisão (Sprint 034).** A primeira redação desta ADR dizia que `packageManager`
> *"alimenta comandos de instalação"*. Verificado na implementação: ele não executa nada — é
> **evidência entregue à camada de julgamento**, e o modelo é quem planeja o comando a partir dela.
> A consequência é pior, não melhor: um valor errado é um **fato falso apresentado como verificado**,
> que é precisamente o que `NUNCA_ADIVINHAR.md` §1 existe para impedir — *"a camada de julgamento
> poder distinguir 'isto é verdade porque foi checado' de 'isto é uma suposição'"*.

`undefined` já é um valor previsto (o ramo macOS o produz), então nenhum consumidor de
`packageManager` precisa mudar.

#### `send_audio` — o segundo

Hoje, uma sondagem indeterminada de `piper` faz `findPiperInstallation()` devolver `null`,
`generateAudio()` **nem entra no bloco do Piper**, nenhum fato é empilhado, e o áudio vai para o
serviço de terceiros em silêncio — reintroduzindo por outro caminho a violação que a Sprint 028
fechou.

**Decisão: indeterminado NÃO apaga a declaração do usuário.** A presença dos modelos em
`PIPER_MODELS_DIR` já estabeleceu que o TTS local foi declarado
(`SOBERANIA_DA_CONFIGURACAO.md` §1.1); a falha da sondagem do binário não desfaz isso.

Consequência: o áudio continua sendo entregue pela engine remota — não se recusa entrega por uma
sondagem que falhou — **e o fato sobre a entrega é produzido**, como em qualquer outra queda do
Piper. O usuário fica sabendo que o texto saiu da máquina.

#### `integrationChecker` — diagnóstico

**Decisão: reportar indeterminação como tal**, em vez de `'not_found'`. É um relatório de auditoria;
dizer "não foi possível verificar" é estritamente mais útil que afirmar ausência. Risco baixo:
nenhuma decisão automática depende deste valor.

#### `GoalExecutionLoop` / `captureFromGoal` — falha segura

**Decisão: não muda o comportamento.** Indeterminado continua significando "não aprende", que é o
que a `ADR-003` já escolheu deliberadamente para o caso de dúvida (*"silêncio em vez de chute"*).

O que muda é o **motivo**: hoje o resultado seguro sai por acidente, de um `catch` que apagou a
causa. Passa a sair por decisão declarada.

### 4.3 A regra que a decisão cria

> Uma sondagem que não conseguiu verificar **reporta indeterminação**. Quem consome decide o que
> fazer com ela — e a decisão fica escrita no ponto de consumo, não escondida na primitiva.

## 5. Gate obrigatório — Extensão antes de Criação

**Nenhum arquivo novo.** Nenhuma Tool, Skill ou Script.

| Candidato | Precisa existir? | O que já existe | Decisão |
|---|---|---|---|
| Sondagem com causa | Não | `which()` em `src/utils/crossPlatform.ts` já executa a sondagem e já recebe `status`/`code`/`signal` do Node | Função nova no módulo existente |
| Classificação de causa | Não | O objeto de erro do `execFileSync` já a carrega | Leitura do que já chega |
| `commandExists` | Já existe | — | Preservado, com o colapso passando a ser declarado |

## 6. O que esta ADR NÃO muda

* **O valor do timeout.** Não é a decisão (ver alternativa A).
* **A assinatura de `commandExists()`.** Consumidores que não precisam do terceiro estado seguem
  iguais.
* **O comportamento do `GoalExecutionLoop`.** Só o motivo dele fica explícito.
* **A relação com o `S158`.** Continua não estabelecida (`INVESTIGACAO_S158…` §6). Esta ADR não a
  assume nem a descarta, e não deve ser lida como correção daquela instabilidade.

## 7. Consequências

* **Um consumidor deixa de poder errar positivamente.** É o ganho principal, e vale mesmo que a
  frequência medida fosse menor.
* **A garantia da Sprint 028 deixa de ter uma porta dos fundos.**
* **Implementação incremental e reversível:** os quatro consumidores são independentes; cada um pode
  ser migrado sozinho, e enquanto não for, continua com o comportamento atual.
* **Ordem sugerida pela evidência**, não obrigatória: `CapabilityRegistry`, depois `send_audio`,
  depois `integrationChecker`; o `GoalExecutionLoop` só ganha comentário.

## 8. Validação exigida

Validação Progressiva. Além dos testes por consumidor, dois cenários que a medição já mostrou serem
produzíveis: **timeout forçado** (teto de 1 ms reproduz `ETIMEDOUT` de forma determinística) e
**PATH vazio** (reproduz `ENOENT`). Ambos permitem testar o terceiro estado sem depender de
saturação real.

O cenário de execução real que a decisão precisa ver funcionando: Piper declarado, máquina sob
carga, sondagem falhando — e a resposta ao usuário mencionando a substituição, em vez de o áudio ir
para o serviço remoto em silêncio.

## 9. Limites conhecidos

* **A medição cobre apenas Windows.** Linux e macOS usam `which`, um binário e um caminho de
  execução diferentes. As formas de erro (`status: 1`, `ETIMEDOUT`, `ENOENT`) **não foram
  verificadas lá**, e a implementação não deve assumir que são idênticas — é o tipo de suposição
  por analogia que `NUNCA_ADIVINHAR.md` §4 proíbe.
* **Permissão e antivírus** aparecem na classificação (`EPERM`/`EACCES`) mas nunca foram observados.
  São categorias previstas, não medidas.
* **A saturação foi induzida artificialmente**, não sob inferência local real — que é o cenário
  equivalente no uso do projeto.
* **3,3% é uma medida daquela máquina, naquela carga.** Não é uma taxa esperada em produção.
