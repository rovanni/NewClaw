# ADR-025 — O trabalho não se perde: comando em segundo plano e raciocínio que continua

Data: 16/10/2026. Status: **proposta** (direção aprovada pela operadora; fases de medição e implementação a seguir).
Complementa a ADR-023 (o comando continua enquanto trabalha) e a ADR-024 (trabalho do modelo em tokens).

## Fase 1 — Compreensão

**A pergunta da operadora:** "É muito injusto: o agente está trabalhando, vence o tempo, para tudo e recomeça do zero. Um
pedreiro fazendo um muro: deu o tempo, pare e recomece. Não tem lógica." Hoje, mesmo depois da ADR-023, o NewClaw perde
trabalho de três formas:

| O que é interrompido | O que se perde hoje |
|---|---|
| **Comando** (exec_command) parado 30 s ou no fim do prazo do objetivo | O que ele gravou no disco fica, mas **ele não continua**. Quem chamou recebe uma falha e, em geral, roda tudo de novo. |
| **Raciocínio do modelo** cortado pelo relógio (juiz, agente) | **Tudo é jogado fora** (`OllamaProvider`: "interrupted reasoning is never an answer"). No teste de 16/10 foram 32 mil e 48 mil caracteres de raciocínio, e o Bonsai mostrou que um deles concluiria com tempo. |
| **Passo do objetivo** | Os resultados das ferramentas ficam (`goal.attempts`, "o que já foi feito" para o replanejamento), mas o plano é refeito. |

**Como os agentes atuais fazem (pesquisa de 16/10/2026, documentação oficial):**
- **OpenClaw:**
  - um comando que passa de 10 s **vai para segundo plano**: retorna "rodando" com um número de sessão e o final da saída;
  - o agente usa `process` com as ações `poll`, `log`, `list` e `kill`;
  - quando o comando termina, a sessão **é acordada** (`notifyOnExit`);
  - o único corte é o teto de 30 min, configurável (com `0`, sem corte);
  - mesmo no corte, a orientação é **verificar o efeito antes de repetir**.
- **Hermes Agent:**
  - `background=true` e a ferramenta `process` (list, poll, wait, log, kill, write);
  - o resultado de um comando que já terminou **fica guardado** (64 resultados, até 7 dias).
- **Cline:**
  - o botão "Proceed while running" deixa o comando continuar;
  - um **checkpoint** (foto dos arquivos) é guardado a cada uso de ferramenta.
- **O próprio ambiente que desenvolve o NewClaw** (Claude Code): um comando que passa do limite **vai para segundo plano em
  vez de ser interrompido**, e o agente é avisado quando termina. Foi observado várias vezes nesta campanha.

## Fase 2 — Crítica da hipótese

- **Processo órfão.** Um comando em segundo plano precisa de dono. Se o objetivo termina, é cancelado ou o NewClaw
  reinicia, o comando não pode ficar rodando esquecido. O Hermes e o OpenClaw registram cada processo e fazem limpeza. O
  NewClaw já encerra a árvore inteira (ADR-023): falta o **registro** dos processos vivos e a **limpeza** quando o objetivo
  acaba.
- **Passo do objetivo é síncrono.** O `GoalExecutionLoop` espera o resultado do passo (`dispatchToolStep` →
  `proactiveRecovery.execute` → `tool.execute`). Para o objetivo, "segundo plano" significa **esperar sem cortar**:
  - o passo aguarda enquanto o comando dá sinal de vida;
  - o que muda é o caso **sem sinal**: hoje o comando é encerrado; com a mudança, o fato vai ao planejador (ou ao agente),
    que decide se espera mais, consulta ou encerra.
- **O agente esquece de consultar.** No turno de conversa (AgentLoop), o modelo recebe "rodando" e pode simplesmente
  responder sem acompanhar. → O aviso de término (como o `notifyOnExit`) evita isso: o resultado volta à conversa.
- **Continuar o raciocínio exige suporte do servidor.** É preciso mandar o pedaço já gerado e pedir ao modelo que continue
  de onde parou: no `llama-server`, um pré-preenchimento do assistente; no Ollama, uma mensagem final do assistente. Não
  está medido se isso funciona **dentro do bloco de raciocínio**, em cada modelo. **Hipótese a medir antes de adotar.**
- **Custo de manter o raciocínio:** 48 mil caracteres guardados por chamada cortada. É pouco; o registro vai para o disco,
  no gravador de voo.
- **Gate de extensão (Diretriz).** Não é preciso criar uma ferramenta nova "process": o `exec_command` pode ganhar o
  acompanhamento como parâmetro (`acompanhar: <número>` com `acao: consultar | aguardar | encerrar`). Decidir na Fase 3.

## Fase 3 — Alternativas

1. **Comando:**
   - (a) só aumentar os limites — descartada: continua desperdiçando;
   - (b) segundo plano + acompanhamento + aviso de término — escolhida, padrão do mercado;
   - (c) checkpoint de arquivos à la Cline — útil para desfazer, mas não resolve o "não continua"; fica fora.
2. **Ferramenta de acompanhamento:**
   - (a) uma ferramenta nova `processo`;
   - (b) **estender o `exec_command`** com `acompanhar` — preferida pelo gate de extensão. Menos uma ferramenta no
     catálogo (ADR-021) e o mesmo lugar do registro.
3. **Raciocínio:**
   - (a) descartar, como hoje;
   - (b) **guardar sempre** no gravador de voo — barato, e permite auditar por que não concluiu;
   - (c) **continuar de onde parou** quando o corte for por relógio/inatividade e o servidor suportar — escolhida **se a
     medição comprovar**.

## Fase 4 — Decisão proposta

1. **Registro de processos** (um por NewClaw):
   - cada comando ganha um número, o dono (objetivo ou conversa), a saída acumulada (final guardado), o estado e o código de
     saída;
   - o resultado de um comando terminado fica disponível depois que ele acaba.
2. **exec_command em segundo plano:**
   - se o comando não termina em poucos segundos, o agente recebe
     `[rodando — nº N, há X s; últimas linhas: …; use exec_command com acompanhar=N]`, e o comando **continua**;
   - com `acompanhar`, o agente consulta, aguarda ou encerra;
   - o encerramento continua derrubando a árvore inteira (ADR-023).
3. **Sem sinal de atividade** (ADR-023, 30 s): **não encerra mais por conta própria**. Vira fato para quem decide (agente
   ou planejador): "sem nenhum sinal há N s; vivo; acompanhar=N". O teto do objetivo, o "Parar" e a limpeza no fim do
   objetivo continuam encerrando.
4. **Passo do objetivo:**
   - o loop aguarda o comando enquanto ele trabalha, sem limite próprio;
   - se ele para de dar sinal, o fato vai ao replanejamento **com o processo ainda vivo e a saída até ali**, e não como
     "falhou".
5. **Aviso de término:** um comando em segundo plano que termina sem ninguém aguardando gera um fato na conversa ou no
   objetivo dono. Não se perde.
6. **Raciocínio cortado:**
   - **sempre guardado** no gravador de voo (com o tamanho e o motivo do corte);
   - **continuado** quando a medição mostrar que o modelo retoma bem.
7. **Fim do objetivo ou do NewClaw:** os processos daquele dono são encerrados (com a árvore) e isso é registrado. Não há
   processo órfão.

## Fase 5 — Validação (plano)

- **Medição primeiro:**
  - (a) continuação do raciocínio no `llama-server` (Bonsai) e no Ollama Cloud (cota pedida antes): o modelo retoma o
    raciocínio do ponto em que parou e chega a um veredito? Com quantos tokens a mais?
  - (b) tempo até o retorno "rodando" que não atrapalha comandos rápidos: a mediana medida é 0,9 s e 90% terminam em menos
    de 5,6 s.
- **Etapas incrementais e reversíveis:**
  - (1) registro + `acompanhar`, sem mudar o retorno;
  - (2) retorno "rodando" no turno de conversa;
  - (3) passo do objetivo aguardando sem limite próprio;
  - (4) aviso de término;
  - (5) guardar o raciocínio;
  - (6) continuar o raciocínio, se a medição aprovar.
- **Testes:** os cenários reais (npm install longo, comando parado, objetivo cancelado no meio, reinício do NewClaw) no
  Windows e no Linux (CI).
- **Hipóteses não comprovadas:**
  - o modelo retoma bem o raciocínio interrompido;
  - o agente usa o `acompanhar` em vez de repetir o comando.

## Medição (a) — o raciocínio interrompido pode ser reaproveitado? (16/10/2026)

**Montagem:** Bonsai 27B (`llama-server`, raciocínio visível no texto), com o caso real "risco do plano" que a nuvem perdeu.
Sem corte, esse caso tinha precisado de 8.630 tokens e 232 s.

| Etapa | Tokens | Tempo | Resultado |
|---|---|---|---|
| 1. gerar até o corte (4.000 tokens, no meio do raciocínio) | 4.000 | 105 s | interrompido |
| 2. devolver o pedaço como mensagem do assistente e pedir para continuar | 1.354 | 40 s | **concluiu** (reprovado) |
| **total** | **5.354** | 145 s | contra 8.630 tokens e 232 s sem corte |

**Achado:**
- O modelo **não emenda literalmente** o texto. Ele abre um raciocínio novo e curto, mas **usa o que já pensou como
  contexto**.
- O trabalho interrompido não é perdido: terminou com +1,3 mil tokens, em vez de recomeçar do zero.
- O veredito bate com o que o mesmo modelo deu para o caso antes.
- **Limite:** 1 caso e 1 modelo. No Ollama Cloud, a forma de devolver o pedaço (mensagem do assistente com `thinking`) ainda
  não foi medida.

**Consequência para a decisão:** a etapa (5), "guardar o raciocínio", vale por si. A etapa (6) troca "continuar de onde
parou" por **"devolver o raciocínio parcial ao modelo como contexto"**, que é o que o dado mostra funcionar.

## Implementação das etapas 1 e 2 (16/10/2026) — EXPERIMENTAL

**Como ligar:** `EXEC_EM_SEGUNDO_PLANO=1`. Desligado por padrão: tudo como antes, e o log registra
`[EXEC-SEGUNDO-PLANO-SOMBRA]` quando um comando **teria** ido para segundo plano.

**Registro** (`src/tools/registroDeProcessos.ts`):
- cada comando que vai para segundo plano ganha um número;
- quando ele termina, guarda só o resultado (≤ 16 mil caracteres) e libera o buffer da saída;
- mantém até 64 resultados, por até 6 h;
- comando que termina a tempo não fica guardado;
- ao sair, o NewClaw encerra a árvore de tudo o que ainda roda.

**`exec_command`:**
- Depois de `EXEC_SEGUNDO_PLANO_APOS_S` (padrão 10 s), devolve
  `[nº N — segue rodando em segundo plano … O comando NÃO terminou ainda. Para acompanhar: exec_command com acompanhar=N e acao="consultar" | "aguardar" | "encerrar"]`,
  mais o final da saída até ali, e o comando **continua**.
- Com `acompanhar=N`:
  - `consultar` devolve o estado, há quanto tempo roda, o último sinal de atividade e a saída;
  - `aguardar` espera mais um pouco pelo fim;
  - `encerrar` encerra a árvore e diz o fato.
- **Em segundo plano, ficar sem sinal de atividade não encerra o comando**: vira fato na consulta. O teto do objetivo, o
  "Parar" e o `encerrar` continuam encerrando.

**Passo direto do objetivo** (sem modelo para acompanhar): aguarda o fim (`executarAguardandoComandos` no
`dispatchToolStep`).

**Cobertura:** `S427`. O caso da pausa legítima que voltou a trabalhar: antes seria cortado, agora segue vivo.

**Situação medida em 21/10/2026 (campanha de sprints):**
- **(5) guardar o raciocínio cortado** — no Ollama (streaming) **já acontece**: a telemetria da tentativa leva o raciocínio
  acumulado (`thinkingText`, registrado também no corte) e o gravador de voo dos juízes o grava quando a gravação de
  conteúdo está ligada (a mesma regra de privacidade do resto do conteúdo). No servidor compatível com OpenAI (modelo local,
  **sem** streaming) **é impossível hoje**: numa chamada cortada nada chega ao NewClaw (as 3 tentativas cortadas registradas
  em 18/10 são todas do modelo local, sem texto). O caminho é o streaming no `OpenAIProvider` — o mesmo que a ADR-024 (decisão
  3, "progresso = tokens saindo") pede para a conexão. Proposta, não implementada.
- **(4) aviso de término** e **encerramento por dono** dependem de o registro de processos saber o DONO (objetivo ou conversa)
  e de um canal para entregar o fato fora do turno — não existe hoje. Proposta: o `exec_command` recebe o dono pelo contexto da
  ferramenta (`setContext`, como as de envio) e o registro chama, no término, quem estiver inscrito para aquele dono.
- **(6)** segue dependendo da medição no Ollama Cloud (cota a pedir).

**Pendentes (próximas etapas):**
- (4) avisar o usuário ou o agente quando um comando em segundo plano termina sem ninguém aguardando;
- (5) guardar o raciocínio cortado — feito para o Ollama; para o compatível com OpenAI, depende do streaming (acima);
- (6) devolver o raciocínio parcial ao modelo (medição (a) acima);
- encerramento por **dono** (objetivo ou conversa) no fim do objetivo — hoje fica coberto pelo teto do objetivo e pelo
  encerramento ao sair.
