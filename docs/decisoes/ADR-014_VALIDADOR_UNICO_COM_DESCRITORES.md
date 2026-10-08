# ADR-014 — Validador único com descritores de validação

> **Status:** **proposta**, aguardando aprovação do operador. Nada implementado.
> **Data:** 08/10/2026
> **Origem:** proposta do operador — *"ao invés de ter vários validadores diferentes, ter um padrão e apenas um
> validador; ele recebe o tipo de validação e todos os dados necessários — entrada, saída, risco etc. Como o MCP:
> uma camada que traduz para a IA e que ela descobre de forma autônoma. Assim facilita a manutenção."* E: *"o validador
> vai ter o campo opcional para o LLM registrar problemas e dificuldades, para utilizar como logs."*
> **Relacionadas:** `INFORMACAO_COMPLETA_PARA_DECIDIR.md` (o que toda decisão recebe — este ADR é como isso passa a
> ser garantido pela estrutura), `RESPONSABILIDADE_ANTES_DO_MECANISMO.md`, `ADR-010` (juiz de grounding), `ADR-013`
> (responsabilidades de verificação; gravador de voo D0), `QUANDO_EXTRAIR_DUPLICACAO.md`, `SOBERANIA_DA_CONFIGURACAO.md`.

---

## Fase 1 — Compreensão

### 1.1 O problema

O NewClaw tem seis componentes que **validam** com o LLM, cada um escrito do seu jeito:

| Validador | Arquivo | Pergunta |
|---|---|---|
| Juiz de grounding | `ObserverValidator.validateGrounding` | os dados da resposta batem com as ferramentas? |
| Validador de qualidade | `ObserverValidator.validate` | a resposta atende o pedido? |
| Validador do passo | `StepSemanticValidator` | o resultado do passo serve ao passo? |
| Validador de conclusão | `GoalExecutionLoop` (completion-validator) | o objetivo foi cumprido? |
| Análise de risco | `RiskAnalyzer` | o plano tem passo faltando, ordem errada, dependência solta? |
| Detector de conteúdo-molde | `contentStubClassifier` | o texto é conteúdo real ou molde? |

Cada um monta o próprio prompt, corta do seu jeito, lê o JSON do seu jeito, escolhe o próprio modelo e trata falha
do seu jeito. O mapeamento de 08/10 (`MAPA_INFORMACAO_DAS_DECISOES_LLM_2026-10-08.md`) mostrou o custo disso: cada um
tinha divergido num ponto diferente — 500, 600, 800, 1000 caracteres de corte; um sem o pedido, outro com um resumo,
outro com a última ferramenta só. As Sprints V1–V6 corrigiram um por um. Nada impede que divirjam de novo.

### 1.2 Tentativas anteriores

- **ADR-013 D0 (gravador de voo)** já unificou a **observação** dos três avaliadores (juiz, qualidade, risco):
  `gravarAvaliacao`, `CallTelemetry`, campo `faltou`. É o primeiro pedaço do padrão — só a parte de registro.
- **ADR-013 D1 (checklist do juiz)** foi testado e não confirmado: o formato do pedido, sozinho, não mudou o tempo.
  Lição: padronizar a forma não basta; o que pesa é o que entra e quanto o modelo raciocina.
- **`QUANDO_EXTRAIR_DUPLICACAO.md`**: a duplicação aqui passa nos dois testes — (1) conhecimento compartilhado que já
  divergiu (cortes, pedido ausente, leitura de JSON) e (2) a extração cria um módulo-folha neutro que os seis
  importam, nenhum importando o outro.

### 1.3 Questionário (RESPONSABILIDADE_ANTES_DO_MECANISMO)

- **PERGUNTA:** cada tipo de validação tem a sua — declarada no descritor, não no motor.
- **RESPONSÁVEL:** o motor executa o contrato; o descritor é dono da pergunta, das entradas e do checklist.
- **EVIDÊNCIA:** declarada no descritor com o **papel** de cada entrada (objeto, fonte de verdade, contexto do
  usuário, contexto da execução) — o motor recusa a chamada sem as entradas obrigatórias.
- **AUTORIDADE:** inalterada — cada consumidor continua decidindo o que fazer com o veredito (bloquear, rebaixar,
  replanejar). O motor só valida.
- **ESTADO:** veredito padrão `{ estado: aprovado | reprovado | nao_avaliavel, itens[], confianca, faltou?, dificuldade? }`;
  cada tipo traduz para o formato que o seu consumidor já usa (sem mudar o resto do sistema).
- **CONSUMIDOR:** os mesmos de hoje (AgentLoop, GoalExecutionLoop, GoalPlanner, sanitizePlanSteps).
- **MECANISMO:** composição — o LLM interpreta (o checklist do tipo); o determinismo valida o que é estrutural
  (entradas presentes, orçamento, JSON, citação existente na evidência).

## Fase 2 — Crítica da hipótese

Motivos para **não** fazer:

1. **Risco de "God Object".** Um validador que sabe tudo de seis domínios. Mitigação: o motor não conhece nenhum
   domínio — só executa descritores (dados). Pergunta, entradas e checklist ficam no descritor de cada tipo, em
   arquivo próprio. O motor nunca ganha um `if (tipo === 'risco')`.
2. **Formatos de saída diferentes.** O risco hoje devolve um plano reescrito; o passo devolve `relevant|mismatch`;
   o juiz devolve afirmações. Mitigação: o veredito padrão é comum; cada descritor declara um **adaptador** para o
   formato do consumidor. E a análise de risco deixa de reescrever o plano — passa só a validar, devolvendo os riscos
   ao planejador (resolve o "segundo planejador" da ADR-013 §2.5).
3. **Migração grande.** Seis componentes, muitos testes. Mitigação: um tipo por sprint, com modo sombra (§4.5).
4. **Perda de otimizações locais.** O atalho determinístico do validador do passo, o atalho `KNOWN_GOOD_TOOLS` do
   validador de qualidade. Mitigação: o descritor pode declarar **pré-verificações determinísticas** — mas elas
   passam a ser declaradas e medidas, não escondidas (e as que decidem semântica por palavra-chave ficam sob a
   proibição de `RESPONSABILIDADE_ANTES_DO_MECANISMO.md`).
5. **Abstração prematura?** Não: seis instâncias reais, com divergência medida (§1.1).

## Fase 3 — Alternativas

| Alternativa | Prós | Contras |
|---|---|---|
| A. Manter seis validadores, cobrar a regra por teste (S356) | sem migração | a regra é verificada, não garantida; cada correção é feita seis vezes |
| B. Biblioteca de funções comuns (montar prompt, ler JSON) que cada validador chama | migração leve | cada um ainda decide o que chamar; a divergência volta pelo que se esquece de chamar |
| **C. Motor único + descritores (proposta)** | a regra vira estrutura; correção feita uma vez; tipo novo = descritor novo | migração em etapas; exige adaptadores por consumidor |
| D. Usar o protocolo MCP de fato | padrão externo | MCP serve para expor ferramentas a um modelo, entre programas; aqui as validações são internas — o encaixe é o **princípio** do MCP (contrato declarativo descoberto pelo cliente), não o protocolo |

**Gate Extensão antes de Criação** (arquivos novos propostos):

1. `src/validation/ValidationEngine.ts` (motor) — precisa existir? **Sim.** O que já existe e resolve parte:
   `evaluatorFlightRecorder.ts` (registro, `faltou`), `ObserverValidator` (orçamento, corte declarado, leitura de JSON
   do juiz). Extensão pequena resolveria? Não: estender `ObserverValidator` com os outros quatro domínios o tornaria
   exatamente o God Object da Fase 2. O motor nasce **puxando** o que já existe (recorder, teto, leitura de JSON),
   não duplicando.
2. `src/validation/descritores/*.ts` (um por tipo) — precisam existir? **Sim**, mas substituem os prompts que hoje
   vivem dentro de cada validador; não somam arquivos — cada um sai de um arquivo existente.

## Fase 4 — Síntese (decisão proposta)

### 4.1 Contrato do descritor

```ts
interface DescritorDeValidacao {
  tipo: string;                       // 'saida_contra_evidencia', 'risco_do_plano', 'resultado_do_passo', ...
  pergunta: string;                   // o que exatamente está sendo decidido
  entradas: Array<{
    nome: string;
    papel: 'objeto' | 'fonte_de_verdade' | 'contexto_do_usuario' | 'contexto_da_execucao';
    obrigatoria: boolean;
    corte?: { maxChars: number };     // só para contexto; objeto e fonte de verdade nunca são cortados
  }>;
  checklist: string[];                // perguntas que o modelo responde, uma a uma
  preVerificacoes?: string[];         // verificações estruturais declaradas (ex.: citação existe na evidência)
  raciocinio: 'desligado' | 'curto' | 'livre';   // ver 4.3
  modeloConfig: string;               // chave da configuração do painel (ex.: OBSERVER_MODEL)
  adaptador: (v: VereditoPadrao) => unknown;     // formato que o consumidor de hoje já usa
}
```

### 4.2 O que o motor faz, igual para todo tipo

1. Confere as entradas obrigatórias — faltou alguma: `nao_avaliavel`, **sem chamar o modelo**.
2. Monta o prompt sempre com as mesmas seções e na mesma ordem: pergunta → contexto do usuário (pedido) → objeto →
   fontes de verdade → contexto da execução → checklist → formato de saída. Corte só onde o descritor declara, e
   **declarado no prompt**.
3. Respeita o teto `DECISION_PROMPT_MAX_CHARS`: não cabe → `nao_avaliavel` (nunca um pedaço).
4. Chama o modelo do tipo (escolhido no painel), com o modo de raciocínio do tipo.
5. Lê a saída num formato só; roda as pré-verificações determinísticas declaradas.
6. Registra tudo no gravador de voo (antes/durante/depois/efeito).
7. Devolve o veredito padrão — e o adaptador traduz para o consumidor.

### 4.3 Sugestões incorporadas

- **Campos de observação `faltou` e `dificuldade`** (operador): opcionais em todo tipo; `faltou` = informação que
  faltou; `dificuldade` = outro problema (pedido ambíguo, evidências que se contradizem, regra que não se aplica bem).
  Vão só para o gravador; nenhuma decisão os lê; o relatório semanal agrupa os repetidos.
- **Modo de raciocínio por tipo.** Medido em 07–08/10: o juiz passou 83% do tempo raciocinando; numa sondagem, o
  mesmo pedido levou 12,7 s com raciocínio e 1,7 s com `think: false`. Hoje não é configurável. O descritor declara;
  o provedor aplica quando suporta (Ollama `think`; os demais ignoram, registrado na telemetria).
- **Modelo por tipo, visível no painel.** Substitui `OBSERVER_MODEL`/`RISK_MODEL`/`CLASSIFIER_MODEL` espalhados por
  uma lista de tipos no painel — sem modelo escolhido, o modelo padrão do provedor (issue 068).
- **Tela "Validadores" no painel:** por tipo — modelo, tempo médio, % não avaliável, `faltou` mais repetidos.
- **Recenseamento por registro:** o teste S356 passa a ler o registro de descritores, não a varrer o código.

### 4.4 Fora do escopo

Classificadores de roteamento (UnifiedIntentRouter, GoalExtractor, DomainRegistry, ModelProfileRegistry), o
planejador e o AgentLoop — não validam, produzem decisão de fluxo ou trabalho. Podem virar tipos depois, se o padrão
se provar; não nesta ADR.

### 4.5 Migração (um tipo por sprint)

| Sprint | Entrega |
|---|---|
| M0 | Motor + contrato + veredito padrão + `faltou`/`dificuldade`, sem nenhum tipo migrado; testes do motor |
| M1 | `saida_contra_evidencia` (juiz de grounding) em **modo sombra**: roda junto do juiz atual, não muda veredito, registra discordâncias |
| M2 | Troca do juiz pelo tipo, se a sombra concordar (critério: §5) |
| M3 | `qualidade_da_resposta` (sombra → troca) |
| M4 | `resultado_do_passo` e `conteudo_molde` |
| M5 | `risco_do_plano` — só validação; riscos voltam ao planejador como fato |
| M6 | `conclusao_do_objetivo`; S356 lê o registro; tela "Validadores" no painel |

Cada sprint: regressão completa, teste de navegação como leigo, validação ao vivo (modelos offline quando a cota da
nuvem não permitir), commit separado.

## Fase 5 — Validação

- **Baseada em evidência real?** Sim — seis validadores com divergência medida (mapa de 08/10) e seis correções
  feitas uma a uma (V1–V6).
- **Resolve estrutura ou sintoma?** Estrutura: torna impossível chamar uma validação sem as entradas declaradas.
- **Reduz a complexidade total?** Sim no médio prazo: seis montadores de prompt, seis leitores de JSON e seis
  tratamentos de falha viram um; cada tipo fica com a pergunta e o checklist.
- **Elimina fontes de verdade múltiplas?** Sim — teto, corte declarado, formato de saída, observação e registro.
- **Mantém a filosofia do Cognitive Kernel?** Sim: LLM interpreta, determinismo valida; o motor não decide nada do
  domínio.
- **Incremental e reversível?** Sim: um tipo por sprint, com modo sombra; trocar de volta = apontar o consumidor
  para o validador antigo, que só é removido depois de a troca se provar.

### Critério de sucesso para trocar cada tipo (M2, M3...)

Na sombra, por pelo menos alguns dias de uso real: o tipo novo concorda com o antigo nos casos rotulados; nos
desacordos, o novo está certo na maioria (conferido à mão contra a evidência); o tempo médio não piora; e as
observações `faltou` não apontam entrada obrigatória ausente.

### Riscos que permanecem

- O modo de raciocínio desligado foi medido numa sondagem só (1 caso); a qualidade dos vereditos sem raciocínio em
  casos longos não foi medida — M1 mede, na sombra.
- O formato único de veredito pode não cobrir bem um tipo futuro; o adaptador por tipo absorve, mas se precisar de
  campos novos o contrato muda (versão do contrato registrada no gravador).
