# ADR-037 — Ciclo de vida explícito do modelo de reconhecimento de voz

Data: 31/10/2026. Status: **aprovada pela operadora em 31/10/2026** (direção e decisões D1–D7, abaixo); implementação no
repositório da interface de voz (newclaw-ivox), fora do núcleo; **implementada e provada na GPU em 31/10/2026** (seção
"Resultado da prova").

Relacionadas: ADR-030 (interface de voz), ADR-031 (experiências opcionais não impõem dependências ao núcleo),
`docs/ARCHITECTURE/NUNCA_ADIVINHAR.md`, `docs/ARCHITECTURE/LOCALIDADE_DA_RECUPERACAO.md`,
`docs/ARCHITECTURE/SOBERANIA_DA_CONFIGURACAO.md`.

## Fase 1 — Compreensão

### O pedido

A operadora usa modelos locais na mesma GPU (o NewClaw funciona offline). A interface de voz não deve decidir sozinha
quando ocupar a memória da GPU: carregar o modelo de reconhecimento passa a ser um pedido da pessoa. Nas palavras dela, o
NewClaw deve preservar que **o usuário controla os recursos da própria máquina**.

Ela separou três operações que hoje parecem uma só:

1. **Iniciar a integração** — o serviço de voz fica disponível (PM2, porta local).
2. **Carregar o modelo** — o reconhecimento de voz ocupa memória (VRAM ou RAM).
3. **Abrir a janela** — a interface aparece para a pessoa.

Nenhuma delas deve disparar outra automaticamente.

### Como é hoje (conferido no código do newclaw-ivox em 31/10/2026)

| Fato | Onde |
|---|---|
| O servidor sobe sem carregar modelo | `servidor.py` (nenhuma carga no início) |
| Cada conexão da janela monta um pipeline com um `WhisperSTTService` | `motor.py:146` |
| O `WhisperSTTService` do Pipecat 1.12 carrega o modelo **no construtor** | `pipecat/services/whisper/stt.py:316` |
| O modelo fica num cache do processo e **nunca sai** (fechar a janela não libera) | `stt_local.py`, `_MODELOS_CARREGADOS` |
| Uma cópia do `large-v3-turbo` em float16 ocupa ~2,2 GB de VRAM (três janelas juntas, 31/10) | commit `d4f02ec` do newclaw-ivox |
| `auto` escolhe a GPU porque ela existe, sem olhar a memória livre | `dispositivo.py`, `escolher()` |
| Falha de alocação derruba a conexão sem explicar | `motor.py:146` (exceção sobe ao runner) |
| A síntese (Kokoro, `onnxruntime` sem GPU) roda na CPU e não ocupa VRAM | `requisitos-motor-*.txt` |
| O único acelerador do reconhecimento é CUDA: o faster-whisper usa o CTranslate2, que mede GPUs CUDA | `dispositivo.py`, `medir_motor()` |
| O CTranslate2 4.8.4 oferece `unload_model()` e `load_model()` no modelo | inspeção da biblioteca instalada |

## Fase 2 — Crítica da hipótese

Hipótese inicial: "um botão que carrega o modelo". Motivos para não parar aí:

- **Botão sem estado.** Sem uma máquina de estados explícita, a janela confunde "integração conectada" com "modelo
  carregado", e o núcleo visual não sabe o que mostrar enquanto a carga dura (~9 s na GPU).
- **Medir a VRAM não garante a carga.** Outro processo pode alocar entre a medição e a carga. A medição é um aviso, não
  uma garantia; a falha precisa ser tratada onde acontece (Localidade da Recuperação), sem derrubar a integração.
- **`nvidia-smi` como dependência.** Ele só existe com GPU NVIDIA. Quem usa AMD, Intel ou só CPU não pode depender dele.
  Como o reconhecimento só acelera com CUDA, sem CUDA ele roda na CPU e a pergunta "há VRAM livre?" não se aplica — o
  certo é dizer isso, não fingir uma medição.
- **Descarregar pode não devolver a memória.** Tirar a referência Python não basta se o CTranslate2 guardar a memória
  num cache próprio. Só a medição antes/depois diz se a VRAM voltou.
- **Descarregar no meio de uma transcrição** cortaria a frase da pessoa. O descarregamento espera o fim.
- **O núcleo não pode participar.** Botão no painel do NewClaw para carregar o modelo faria o núcleo conhecer o harness
  (ADR-031, regra 1). O painel continua só com "Abrir".
- **Trocar de GPU para CPU sozinho** contraria a Soberania da Configuração: a troca é sempre uma pergunta.

## Fase 3 — Alternativas

| # | Alternativa | Vantagem | Desvantagem |
|---|---|---|---|
| A | Carregar ao conectar (hoje) | Nada a fazer | Ocupa a GPU sem pedido; nunca libera |
| B | **Gerenciador do modelo no processo**, um por processo, com estados; o serviço da linha só pede o modelo emprestado a cada trecho | Estende o cache que já existe (`stt_local.py`); a carga e a descarga são explícitas | Depende de o CTranslate2 devolver a VRAM ao descarregar (a medir) |
| C | Reconhecimento num **processo filho**, encerrado para descarregar | O sistema operacional devolve toda a memória; uma falha de alocação não toca o processo do harness | Comunicação entre processos para cada trecho de áudio; mais peças |
| D | Controle no painel do NewClaw | Um lugar só | Viola a ADR-031 |

**Escolhida: B**, por estender o que existe. **C fica como plano de troca**, com critério objetivo: se a medição mostrar
que a VRAM não volta depois de descarregar (diferença maior que 10% do consumo medido na carga), a descarga passa a ser
por processo filho, numa etapa própria. D descartada.

## Fase 4 — Decisão

### Decisões da operadora (31/10/2026)

| # | Decisão | Escolha |
|---|---|---|
| D1 | Carregamento | Manual por padrão |
| D2 | Descarregamento automático | Opcional e desligado por padrão |
| D3 | Falta de VRAM ou falha na GPU | Perguntar: tentar na CPU ou cancelar |
| D4 | Local dos controles | Janela da interface de voz |
| D5 | Início da integração | Sobe sem carregar modelo |
| D6 | Fechar a janela | Não descarrega |
| D7 | Reiniciar o computador | O serviço volta (correção do religar, ramo `fix/integracao-volta-apos-reiniciar`); o modelo continua descarregado |
| — | Regra | Nunca descarregar durante uma transcrição: a descarga espera o fim |

### Máquina de estados (uma por processo do harness)

```
descarregado ──carregar──▶ carregando ──ok──▶ carregado ──descarregar──▶ descarregando ──▶ descarregado
      ▲                        │                                                   
      └──────── falha ◀────────┘  (falha guarda o motivo; "carregar" de novo, ou na CPU)
```

- `carregar` em `carregando` ou `carregado`: não faz nada e devolve o estado (várias janelas podem pedir juntas).
- `descarregar` em `carregando`: recusado com o motivo (espera a carga terminar).
- `descarregando`: novos trechos de áudio não são transcritos; os que estão em andamento terminam antes.
- Todas as janelas veem o mesmo estado: o modelo é do processo, não da conexão.

### Memória: medida, nunca suposta

- **Antes de carregar na GPU:** a memória livre de cada GPU, lida da NVML, a biblioteca que vem com o driver da NVIDIA
  (sem `nvidia-smi` e sem pacote novo). Sem a NVML: "não medido". Sem CUDA, o reconhecimento roda na CPU e a VRAM não
  se aplica — a janela diz isso.
- **Estimativa do necessário:** o consumo medido na última carga do mesmo modelo, dispositivo e tipo de cálculo, gravado
  em arquivo local. Na primeira vez, "ainda não medido" — nada de tabela fixa no código.
- **Livre menor que o medido antes:** não carrega; a janela pergunta "tentar na CPU ou cancelar" (D3).
- **Depois de carregar:** grava o consumo, medido pela diferença de memória usada na GPU antes e depois. É a diferença do
  dispositivo inteiro, não só deste processo: outro programa que alocar ao mesmo tempo entra na conta, e a janela mostra a
  fonte da medida.
- **Falha na carga** (qualquer erro do CTranslate2 na GPU): estado `falha` com a mensagem da biblioteca; a integração
  continua no ar; a janela oferece tentar na CPU. O motivo não é classificado por texto: toda falha na GPU oferece a CPU.
- **Depois de descarregar:** mede de novo e mostra quanto voltou. É essa medida que decide entre B e C.

### Onde fica cada coisa

| Peça | Onde |
|---|---|
| Estados, carga, descarga, empréstimo do modelo | `newclaw_ivox/stt_local.py` (o cache por processo vira o gerenciador) |
| Memória da GPU (NVML) | `newclaw_ivox/dispositivo.py` (a medição que já existe) |
| Rotas `GET /api/modelo`, `POST /api/modelo/carregar`, `POST /api/modelo/descarregar` | `newclaw_ivox/servidor.py`, com sessão e checagem de origem, como as outras |
| Botões, estado, pergunta da CPU, preferências D1/D2 | janela (`janela/src/`) |
| Núcleo do NewClaw | **nada muda** além do religar (D7) |

## Fase 5 — Validação

| Pergunta | Resposta |
|---|---|
| Baseada em evidência? | Sim: carga no construtor, cache sem saída, 2,2 GB medidos, `unload_model()` presente na biblioteca instalada. |
| Estrutural ou sintoma? | Estrutural: o modelo ganha dono e estados; a carga deixa de ser efeito colateral da conexão. |
| Reduz complexidade? | Acrescenta um gerenciador pequeno; tira a carga do caminho de toda conexão (conectar fica rápido). |
| Fontes de verdade múltiplas? | Não: um estado por processo, lido por todas as janelas. |
| Incremental e reversível? | Sim: tudo no harness; voltar a carregar ao conectar é uma preferência (D1). |

**Hipóteses não comprovadas:** (1) que `unload_model()` mais a remoção das referências devolva a VRAM — medir, sem
carregar nem descarregar o Strata, com autorização da operadora; (2) que a ordem das GPUs na NVML coincida com a do CUDA
quando há mais de uma — com uma GPU só não há ambiguidade; com várias, a janela mostra todas.

## Plano incremental

| Etapa | Entrega | Teste |
|---|---|---|
| 1 | Máquina de estados do modelo | Transições, recusas, várias janelas pedindo juntas |
| 2 | Carga e descarga explícitas; o serviço da linha não carrega mais no construtor | Conectar não carrega; descarga espera a transcrição em andamento |
| 3 | Memória medida (NVML) e consumo registrado | Sem NVML → "não medido"; livre insuficiente → pergunta |
| 4 | Controles na janela | Estado inicial "Modelo descarregado"; texto e fala continuam |
| 5 | Tentar na CPU com confirmação | Falha na GPU → pergunta; CPU só com o clique |
| 6 | Prova real: carga, uso, descarga e recuperação de falha, com a VRAM medida antes e depois | Só com autorização, sem tocar no Strata |

## Resultado da prova (31/10/2026)

Prova autorizada pela operadora em 31/10/2026: harness isolado na porta 7861, NewClaw falso só para o login, Strata
desligado, nenhuma cota; carga e descarga pelas rotas `/api/modelo`, VRAM medida por fora pela NVML.

| Ciclo | Carga | VRAM ao carregar | VRAM ao descarregar |
|---|---|---|---|
| 1 | 17,4 s (com a inicialização da CUDA) | +1,17 GB | −2,09 GB |
| 2 | 6,4 s | +2,10 GB | −2,09 GB (100%) |

- **Hipótese 1 confirmada:** `unload_model()` mais a remoção das referências devolve a VRAM. A alternativa B fica; a C
  (processo filho) não é necessária.
- **Limite da medida, visto na prática:** no ciclo 1 outro programa liberou memória da GPU durante a carga, e a diferença
  do dispositivo deu 1,17 GB em vez de ~2,1 GB. No Windows (WDDM) o driver não informa a memória por processo; o consumo
  gravado é um aviso antes de carregar, não uma garantia — como a decisão já previa.
- Na CPU (mesmo dia): carga em 22,5 s; descarregar devolveu ~0,87 GB de RAM ao processo.
