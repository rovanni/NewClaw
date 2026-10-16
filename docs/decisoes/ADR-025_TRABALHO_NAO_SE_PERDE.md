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
