# ADR-024 — O trabalho do modelo se mede em tokens, não em segundos

Data: 16/10/2026. Status: **proposta**. A ideia é da operadora ("trocar o cálculo de tempo por cálculo de tokens; aí não
importa se é online ou local lento"). A fase de medição está concluída.

## Fase 1 — Compreensão

**Problema.** Os prazos das chamadas ao modelo são em segundos e foram calibrados com modelos de nuvem rápidos:
- **juiz:** orçamento = o maior entre 4 × a latência típica e 8 s por mil caracteres (medido no `glm-5.3-flash:cloud`),
  com teto de 300 s;
- **agente:** de 45 a 420 s, proporcional ao contexto;
- **conexão:** teto fixo de 240/420 s;
- **turno:** 10 min fixos;
- **objetivo:** 30 min fixos.

Um modelo local é ~10× mais lento. Esses prazos cortariam trabalho legítimo, e "não avaliável" viraria a regra.

**Defeito encontrado.** A latência típica é medida **por provedor**, não por modelo. Todo modelo que passa pelo Ollama, da
nuvem ou local, entra na mesma média (`ProviderFactory.getBudgetAuxiliar` → `circuitBreakers.getOrCreate({ name: provedor })`).

**Medição (16/10/2026).**
- **Velocidade.** Nuvem: mediana de ~370 tokens/s de geração (≈2.900 chamadas dos logs; varia muito). Local, Bonsai 27B no
  `llama-server` (RTX 5060 Ti): **35–40 tokens/s de geração** e **400–880 tokens/s de leitura do prompt**.
- **Juízes reais.** Cinco prompts do gravador de voo, todos do teste "instalar o genoffice" de 16/10:

| Caso | Nuvem (glm-5.3-flash, com raciocínio) | Bonsai com raciocínio | Bonsai sem raciocínio |
|---|---|---|---|
| risco do plano (A) | aprovado, 14 s | veredito, 162 s, 6,0 mil tokens | **aprovado**, 19 s, 640 tokens |
| risco do plano (B) | **cortado aos 70 s** (~32 mil caracteres pensados) | **veredito, 232 s, 8,6 mil tokens** | reprovado, 21 s, 717 tokens |
| saída × evidência (C) | **cortado aos 92 s** (~48 mil caracteres) | sem veredito ao chegar em 12 mil tokens | reprovado, 30 s, 1,1 mil tokens |
| saída × evidência grande (D) | reprovado, 99 s, 9,1 mil tokens | sem veredito ao chegar em 12 mil tokens | **reprovado**, 66 s, 1,3 mil tokens |
| conclusão do objetivo (E) | não chamado (disjuntor) | veredito, 183 s, 6,2 mil tokens | reprovado, 35 s, 0,8 mil tokens |

- **Limite de tokens no provedor.** O Ollama Cloud respeita `num_predict`: 2 chamadas com limite de 60 tokens, as duas pararam
  em 60 com `done_reason=length`. Com raciocínio, **o raciocínio consome o limite**: as 60 saíram todas em raciocínio e não
  sobrou resposta. Lembrete: o mesmo provedor **ignora** `num_ctx` (medido em 15/10).

**O que os números dizem:**
1. O caso B **não era espiral**. O juiz precisava de ~8,6 mil tokens e foi cortado pelo **relógio** perto do fim; com tempo,
   o modelo local concluiu.
2. A quantidade de tokens **depende do modelo**. O caso D custou 9,1 mil na nuvem e mais de 12 mil no Bonsai, que "pensa por
   extenso".
3. **Sem raciocínio**, o modelo local concluiu os 5 casos com ~10× menos tokens, em 19–66 s. Ficou mais rápido que a nuvem
   pensando. Nos 2 casos em que a nuvem decidiu (A e D), o veredito foi o **mesmo**. Nos 3 restantes, os vereditos batem com
   os fatos do teste: a instalação realmente ficou incompleta.

## Fase 2 — Crítica da hipótese ("trocar segundos por tokens")

- **Correta como medida de trabalho.** A mesma tarefa recebe o mesmo orçamento em qualquer modelo; a velocidade só muda
  quanto tempo leva.
- **Furo 1: antes do primeiro token não há o que contar.** A leitura do prompt local leva 13–21 s para 11–18 mil tokens, e
  mais se o servidor estiver atendendo outro pedido. → A espera pelo primeiro token tem que ser proporcional aos tokens do
  prompt e à velocidade de leitura **medida daquele modelo**.
- **Furo 2: modelo travado não gera tokens, e o contador nunca chega ao limite.** → Mesmo princípio da ADR-023: continua
  enquanto saem tokens; parou de sair, conta a tolerância.
- **Furo 3: juiz que pensa sem fim gera tokens o tempo todo.** → Teto de tokens por tarefa, enviado ao **próprio provedor**
  (`num_predict`/`max_tokens`): o modelo para sozinho, sem relógio. **Mas um número único não serve** (furo do ponto 2 da
  Fase 1): o teto precisa partir do que aquele modelo gasta naquela tarefa.
- **Furo 4: tokens resolvem o corte injusto, não a demora.** Juiz local pensando leva 3–6 min por conferência; um objetivo
  com 10 conferências passaria de meia hora. → O modo sem raciocínio é o que torna o juiz local viável. O perfil do juiz
  (ADR-016) já alterna os modos, mas escolhe por "deu veredito?", não pelo **custo** de cada modo.
- **Risco de qualidade:** cinco casos e um modelo local é pouco para afirmar que "sem raciocínio julga igual". É evidência
  inicial, não prova. O período de sombra deve comparar os vereditos.

## Fase 3 — Alternativas

- **(a) Prazos maiores.** Descartada: continua fixo e só empurra o problema.
- **(b) Prazo × fator por modelo "lento".** Descartada: é rótulo à mão, receita.
- **(c) Tokens com velocidade medida por modelo.** Recomendada:
  - orçamento de trabalho em tokens;
  - velocidades medidas por modelo (leitura e geração), que convertem tokens em tempo só para avisar o usuário e para a
    espera do primeiro token;
  - progresso pelo fluxo de tokens;
  - teto de tokens no provedor.
- **(d) Só desligar o raciocínio dos juízes em modelos locais.** Descartada como regra fixa ("local → sem raciocínio" seria
  receita). O certo é o perfil **medir** o custo de cada modo e preferir o mais barato que dá veredito.

## Fase 4 — Decisão proposta (c)

1. **Velocidade medida por modelo**, não por provedor: tokens/s de geração e de leitura. Os dados já chegam em toda resposta
   (`eval_count`/`eval_duration` e `prompt_eval_count`/`prompt_eval_duration` no Ollama; `timings` no `llama-server`).
   A latência típica por provedor deixa de ser usada para orçamento.
2. **Orçamento de trabalho em tokens por tipo de chamada** (cada juiz, agente, planejador), aprendido do que aquele modelo
   gastou naquele tipo quando deu certo (percentil alto + folga). Sem histórico, vale um ponto de partida declarado, medido
   nos casos acima. O teto de geração vai ao provedor (`num_predict`/`max_tokens`).
3. **Progresso = tokens saindo** (ADR-023 aplicada à conexão com o modelo). A espera pelo primeiro token é
   `tokens do prompt ÷ leitura medida + folga`. Depois disso, o corte só acontece por inatividade (nenhum token pela
   tolerância) ou pelo teto de tokens.
4. **Perfil do juiz escolhe o modo pelo custo medido.** Entre os modos que dão veredito, prefere o que gasta menos tokens
   **naquele modelo**. Sem nome de modelo no código, como a ADR-016 já exige.
5. **Turno e objetivo.** Os 10 min do turno e os 30 min do objetivo deixam de ser relógios de corte. O objetivo continua
   limitado por ciclos (trabalho), e o tempo vira **aviso**: o usuário é informado do andamento. Com isso, o teto do
   `exec_command` (ADR-023) passa a vir dos ciclos do objetivo, e não de um prazo dele.
6. **Aviso de demora.** Quando a estimativa (tokens ÷ velocidade) passar de um limite, o usuário é avisado ("juiz local
   trabalhando, ~3 min"), em vez de esperar sem saber.

## Fase 5 — Validação (plano)

- **Etapas incrementais, cada uma reversível:**
  - (1) velocidade por modelo, só medindo e logando;
  - (2) orçamento em tokens em sombra, logando "cortaria / não cortaria" ao lado do relógio atual;
  - (3) troca do corte nos juízes;
  - (4) perfil do juiz por custo;
  - (5) agente e conexão;
  - (6) turno e objetivo.
- **Teste real em cada etapa** com o modelo local liberado e com o `glm-5.3-flash:cloud` (cota pedida antes).
- **Hipóteses não comprovadas:**
  - o modo sem raciocínio julga tão bem quanto o com raciocínio. Base: 5 casos, 1 modelo; o período de sombra decide;
  - o percentil de tokens por tipo é estável o bastante para virar teto.

## Registro de implementação (16/10/2026)

A operadora autorizou seguir; tudo é incremental e reversível, e nenhuma etapa encurta um prazo.

| Etapa | O que mudou | Cobertura | Como reverter |
|---|---|---|---|
| 1 — medição (sombra) | `medidorDeTrabalho.ts`. Velocidade por **modelo + modo**; tokens por tipo de chamada; linha `[TOKENS-SOMBRA]` em toda chamada (entrada, raciocínio≈, resposta≈, fonte servidor/estimado, "teria cortado" × "relógio cortou"); `data/medicao-de-tokens.json` | S422 | não muda comportamento |
| 3 — juízes | `ProviderFactory.orcamentoPeloTrabalho`: p95 × 1,5 dos tokens do que concluiu ÷ velocidade medida × 1,25 + 5 s, com teto no que resta ao objetivo. O juiz só **estende** o prazo, e o limite de tokens vai ao provedor (`num_predict` / `max_tokens`). Sem histórico (< 5 conclusões): prazo de sempre | S423 | reverter o commit; sem histórico não age |
| 4 — modo pelo custo | Entre modos confiáveis, o mais barato em tokens. **Em sombra** (`[JUIZ-MODO-SOMBRA]`); age só com `JUIZ_MODO_PELO_CUSTO=1` | S424 | desligado por padrão |
| 5 — agente | O prazo da chamada do agente também estende pelo trabalho medido; **sem** limite de tokens (a saída do agente varia demais) | S425 | reverter o commit |
| 6 — limites globais | `LIMITE_DO_OBJETIVO_MIN` (padrão 30). Modo experimental `LIMITE_DO_OBJETIVO_COMO_AVISO=1`: avisa e prorroga até `LIMITE_DURO_DO_OBJETIVO_MIN` (padrão 3×). O teto dos comandos acompanha a prorrogação | S426 | desligado por padrão |
| 1 (complemento, 21/10) — medição no compatível com OpenAI | `OpenAIProvider` entrega à telemetria `usage` e `timings` do llama-server (tokens lidos agora = `prompt_n`, sem o cache). Antes, a velocidade dos modelos locais nunca era medida — a etapa 5 nunca agia para eles | S440 | reverter o commit |
| 5 (complemento, 21/10) — ponto de partida (decisão 2) | Sem histórico do modelo no tipo, o agente e o classificador de objetivos usam um ponto de partida declarado em tokens (`medidorDeTrabalho.pontoDePartidaEmTokens`: p95 medido na produção × folga). Só estende; os juízes não usam (o orçamento deles vira limite de tokens). Quebra a armadilha "cortado sempre → nunca conclui → nunca forma orçamento". Validado no modelo local real: agente 210 s → 828 s, resposta entregue após 733 s de geração | S440 | reverter o commit |

**Achado na etapa 6.** Os "10 min do turno" **não cortam trabalho**. O chat web já é assíncrono: responde 202 e entrega a
resposta depois. Os 10 min só valem para a rota de aprovação de ação perigosa (`dashboard/routes/chat.ts`). O único corte
global de tempo era o do objetivo.

**Validação com dados reais** (produção Windows, 01–16/10, sem chamar modelo). Na maioria dos cortes do relógio, a chamada
caberia no orçamento por tokens:
- roteador de intenção (glm-5.3): 10 de 12;
- juiz saída × evidência: 2 de 2;
- juiz de risco: 1 de 1;
- juiz de grounding: 2 de 2.

O RiskAnalyzer com o glm-5.3 tem 22 cortes para 3 conclusões, o que é histórico insuficiente para orçamento: o prazo é
curto demais para esse modelo.
