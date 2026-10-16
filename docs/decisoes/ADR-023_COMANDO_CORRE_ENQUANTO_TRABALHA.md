# ADR-023 — O comando continua enquanto trabalha (sem prazo fixo)

Data: 16/10/2026. Status: **aceita** pela operadora (T = 30 s; ao chegar em T, encerrar e dizer o fato — opção (i)). Implementação
em 3 partes: entrada fechada (S419), progresso pelos três sinais (S420), teto pelo prazo do objetivo e "Parar" (parte 3).

## Fase 1 — Compreensão

**Problema.** O `exec_command` corta qualquer comando aos 60 s (`PRAZO_PADRAO_MS`), seja um `echo` ou um `npm install`.
No teste real de 16/10 (`goal_1792128547107_ogo6t`), o `npm install` foi cortado no meio e o goal acabou em falha. O agente
pode pedir outro prazo pelo parâmetro `timeout`, mas quase nunca pede.

Nos 126 comandos registrados no Windows:
- mediana de 0,9 s;
- 90% abaixo de 5,6 s;
- o único que chegou aos 60 s foi o `npm install`, cortado.

O número fixo é folgado demais para quase tudo e curto para instalações.

**Pergunta da operadora.** "Limite de tempo é relativo à tarefa; não deve ser fixo." A proposta aceita foi trocar "passou de
X segundos?" por "**ainda está trabalhando?**".

**Medição (16/10/2026).** Script `medir-atividade`, amostrando por segundo a árvore de processos do comando com três sinais:
- **saída:** bytes escritos;
- **CPU:** tempo de CPU da árvore;
- **E/S:** bytes lidos e escritos pela árvore, que já incluem rede nos dois sistemas (`/proc/<pid>/io` rchar/wchar no
  Linux; `GetProcessIoCounters` no Windows).

O Windows foi medido de 2 em 2 s na primeira rodada. "Sem nenhum sinal" significa saída = 0, CPU < 50 ms e E/S < 16 KB na
amostra.

| Cenário | Maior silêncio de **saída** | Maior trecho sem **nenhum** sinal — Windows | — Linux |
|---|---|---|---|
| npm install silencioso | 7–10 s | 2 s | 0 s |
| git clone | 2 s | 0 s | 0 s |
| pip download | 5–12 s | 2 s | 0 s |
| cálculo sem saída | 12–15 s | 2 s | 1 s |
| só disco, sem saída | 12–15 s | 2 s | 0 s |
| **pausa legítima** (trabalha 3 s, espera 8 s, ×3) | 20–25 s | 4 s¹ | **8 s** |
| **"tentando reconectar…" para sempre** | 2 s | 0 s | 1 s |
| **travado parado** | 20–24 s | **18 s (todo)** | **23 s (todo)** |
| **pergunta e espera o teclado** (node, python, `set /p`, `Read-Host`, `read`) | 12–14 s | **12 s (todo)** | **13–14 s (todo)** |

¹ Medição grosseira: cada amostra custava 2,5 s, ver "Custo" abaixo.

**Entrada fechada** (o programa recebe "fim da entrada" em vez de uma entrada aberta e vazia): as 7 perguntas interativas
terminaram em **0–2 s** nos dois sistemas, em vez de ficarem penduradas. Python, Node e `set /p` falham com mensagem.
`Read-Host` (PowerShell) e `read` (sh) **seguem com resposta vazia**: a pergunta não trava, mas a resposta vira "nada".

**Custo de amostrar.**
- **Linux:** ler `/proc` custa **7–8 ms** por amostra.
- **Windows, consulta CIM:** um PowerShell novo por amostra custa **2,5 s**; um PowerShell aberto uma vez com consulta CIM
  custa **~470 ms**, porque lista todos os processos da máquina.
- **Windows, funções do próprio sistema:** um PowerShell aberto uma vez chamando `CreateToolhelp32Snapshot`,
  `GetProcessTimes` e `GetProcessIoCounters` (C# compilado uma vez na sessão) custa **~34 ms** com a árvore inteira.
- **macOS:** não medido; não há máquina para teste. Ver "Riscos".

## Fase 2 — Crítica da hipótese

- **Só a saída não basta.** Quem trabalha calado (npm, pip, cálculo, disco) fica 7–15 s sem escrever nada. Um corte por
  silêncio de saída mataria trabalho legítimo.
- **Os três sinais juntos separam bem os casos medidos.** Quem trabalha nunca ficou mais de 2 s sem nenhum sinal. Quem
  travou ficou sem sinal o tempo todo.
- **Mas uma pausa legítima é indistinguível de um travamento enquanto dura.** Os 8 s esperando apareceram como 8 s sem
  sinal, exatamente como um processo parado. Um script esperando um servidor lento, um `sleep` de propósito ou um retry com
  espera parecem travados durante a espera. Qualquer tolerância a "nenhum sinal" é uma aposta sobre quanto uma pausa
  legítima pode durar. **Ausência de sinal não é prova de travamento.**
- **Há um caso que engana todos os sinais:** "tentando reconectar…" para sempre tem saída e CPU sem avançar nada. Só um teto
  de segurança pega. Registrado como limitação; não deve ser escondido.
- **"Esperando o teclado" não precisa ser detectado:** basta fechar a entrada. O `exec_command` não tem como digitar nada,
  então deixar a entrada aberta só produz travamento. O próprio código já tinha um remendo pontual para isso no `marp`
  (`isMarpWithoutInputFile`), que vira caso particular.
- **Aprender prazos por nome de comando:** adiado, por sugestão da revisão. Os sinais já separam os casos medidos, e
  histórico seria complexidade sem necessidade comprovada.
- **Risco de custo no Windows:** o mecanismo só é viável com as funções nativas. Com CIM, a medição custaria mais que muitos
  comandos.

## Fase 3 — Alternativas

- **(a) Prazo fixo maior (ex.: 10 min).** Descartada: continua fixo, e um comando travado prende o goal por 10 min.
- **(b) Prazo aprendido por comando.** Adiada: ver Fase 2.
- **(c) Silêncio de saída.** Descartada: mata trabalho calado, medido.
- **(d) Três sinais (saída, CPU, E/S) + entrada fechada + teto de segurança.** Recomendada.
- **(e) Execução em segundo plano.** O comando segue rodando, a ferramenta devolve o controle ao agente com os fatos
  ("rodando há N s; último sinal há M s"), e o agente decide esperar, consultar ou encerrar. É a mais fiel a
  "determinismo valida / LLM interpreta", mas é uma mudança maior, com uma ferramenta de consulta nova. Fica como evolução
  possível de (d), não como primeiro passo.

## Fase 4 — Decisão proposta (d)

Separa os três conceitos sugeridos na revisão.

1. **Entrada fechada sempre.** `stdin` do comando = "fim da entrada". Elimina a classe "travado esperando o teclado" nos
   dois sistemas. O remendo do `marp` fica redundante e pode sair.
2. **Progresso observado.** A cada segundo, a árvore do comando produziu saída, **ou** CPU, **ou** E/S? Qualquer um dos três
   é progresso. Não há pontuação ponderada: a regra mais simples separou todos os casos medidos.
3. **Ausência de progresso.** Só depois de **T segundos seguidos sem nenhum dos três sinais**. T é a tolerância a pausas
   (decisão em aberto 1). O resultado diz o fato: "sem nenhum sinal de atividade por T s (saída, CPU e E/S zerados);
   encerrado junto com os processos que abriu; o comando NÃO terminou". O parâmetro passa a ser `tolerancia_sem_atividade`,
   e o agente pode aumentá-lo quando souber que haverá espera longa.
4. **Limite de segurança, não regra operacional.** O teto do comando é o **tempo que ainda resta ao objetivo** (o goal já tem
   seu limite). Nenhum número novo é criado, e um comando nunca passa do objetivo que o pediu.
5. **Amostragem por plataforma.**
   - Linux: `/proc` (8 ms).
   - Windows: funções nativas num PowerShell aberto uma vez por processo do NewClaw (34 ms).
   - Sem amostragem disponível (ex.: macOS até ser medido, ou PowerShell ausente): só o sinal de saída, com a tolerância
     declarada no resultado. Nunca um sinal inventado.

### Decisões em aberto (da operadora)

1. **Quanto vale T?** A medição mostra trabalho real com pausas de até 2 s e uma pausa sintética de 8 s. Qualquer valor é uma
   aposta sobre pausas legítimas. Proposta: T = 30 s, visível no resultado e ajustável pelo agente.
2. **Ao chegar em T:** (i) encerrar e dizer o fato (proposta acima, simples), ou (ii) já ir para a alternativa (e), devolver o
   controle ao agente com o comando ainda vivo e deixar ele decidir.

## Fase 5 — Validação (a cumprir na implementação)

- Baseada em medição real nos dois sistemas.
- Resolve a causa (prazo fixo), não um caso.
- Elimina uma classe inteira: espera de teclado.
- Incremental. Cada parte é reversível isoladamente: entrada fechada; progresso; teto pelo goal.
- **Riscos que permanecem:**
  - "tentando para sempre" só cai no teto;
  - pausa legítima maior que T é cortada (mitigação: o fato no resultado e o parâmetro do agente);
  - macOS não medido;
  - `Read-Host` e `read` seguem com resposta vazia quando a entrada está fechada;
  - processo que sai da árvore (serviço iniciado à parte) não é observado;
  - `ssh://`: o trabalho calado na máquina REMOTA não aparece nos sinais locais (o `ssh` local fica ocioso) — mitigação: o
    fato no resultado e o parâmetro `tolerancia_sem_atividade`.
- **Achado na implementação (S420):** no Windows o amostrador leva alguns segundos para ficar pronto (compila as funções
  nativas uma vez); a contagem de "parado" começa na primeira medição, não no início do comando — senão um cálculo calado
  era cortado antes de haver com o que comparar.
- **Testes planejados:** os cenários desta tabela viram teste de regressão nos dois sistemas (CI Ubuntu e Windows):
  - trabalho calado não é cortado;
  - travado é cortado em ~T;
  - pergunta termina na hora;
  - o resultado diz o fato.
