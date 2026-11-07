# ADR-039 — Dicionário da voz, correção pelo balão e "Corrigir e reenviar"

Data: 04/11/2026; Revisão 2 em 07/11/2026. Status: **aceita** (ordem de trabalho, "Corrigir e reenviar", D2 revista e
D3–D7 da Revisão 2), com a D1 em aberto até a medição.
A ordem de trabalho e o "Corrigir e reenviar" foram aprovados pela operadora em 04/11/2026; a D2 foi decidida no mesmo dia
("Operação Zero Pendências": manter o comportamento atual). "Corrigir e reenviar" já está na janela (newclaw-ivox `25fd7d9`). A medição com a voz dela (Sprint 0) decide qual apoio de vocabulário vale e se o modelo muda. Implementação no
repositório da interface de voz (newclaw-ivox), fora do núcleo, como na ADR-030 e na ADR-037.

Relacionadas:
- ADR-030 (canal de voz com Pipecat);
- ADR-037 (ciclo de vida do modelo de voz);
- ADR-028 (memória com confirmação: o padrão "o sistema propõe, a pessoa confirma");
- `docs/ARCHITECTURE/NUNCA_ADIVINHAR.md`;
- `docs/ARCHITECTURE/RESPONSABILIDADE_ANTES_DO_MECANISMO.md`.

## Fase 1 — Compreensão

**O relato (04/11/2026):** a transcrição da janela de voz é bem pior que o ditado do navegador.

**O que foi medido:**
- **O que a janela ouviu:** 38 trechos de 30/10 a 02/11, nas sessões `voz-` do NewClaw de produção no Windows e no log
  do motor.
- **Configuração:** `large-v3-turbo` na GPU (`cuda/float16`), idioma `pt`, os padrões do faster-whisper (beam 5) e o
  filtro `no_speech_prob` 0,4 do Pipecat. Nenhum apoio de vocabulário: `hotwords` e `initial_prompt` vazios.
- **Os erros reais:**
  - **Nomes próprios e palavras raras:**
    - "Cornelia Procobre" no lugar de Cornélio Procópio;
    - "Rigger" no lugar de River;
    - "Corrego de Salomão" no lugar de Código de Salomão;
    - "senhor do tempo" e "operação do tempo" no lugar de "previsão do tempo".
  - **Frases curtas ditas rápido.** "E a minha escrita lua em você" foi, provavelmente, "E as minhas criptomoedas, como
    está o River?", repetida logo depois.
- **Não eram erros:** frases como "Obrigado por assistir" e "A unanimidade em 106 urnas" eram o áudio de um vídeo do
  TikTok tocando perto, transcrito corretamente (a operadora corrigiu a primeira leitura). Isso indica que o modelo vai
  bem com fala limpa e completa.
- **Por que o navegador acerta mais:** o ditado do Chrome e do Edge envia o áudio aos servidores do Google ou da
  Microsoft. Não é uma comparação entre modelos locais.

**Conclusão:** a causa principal é o Whisper não receber o vocabulário de quem usa. O modelo não é ruim.

## Fase 2 — Crítica

- **Lista grande demais:** um dicionário grande pode piorar a transcrição de frases sem nenhum dos termos, porque o
  modelo passa a "ouvir" os termos onde eles não estão. Por isso a medição separa as frases com termo das frases sem
  termo.
- **Guardar sozinho a partir da correção viola o Nunca Adivinhar:** uma correção pode ser erro de digitação, ou uma
  troca de ideia em vez de erro de escuta. O sistema compara o texto antes e depois (determinismo) e propõe; quem decide
  guardar é a pessoa (padrão da ADR-028).
- **A nota de confiança por palavra não basta para pedir correção:** no caso real, o Whisper escreveu "Rigger" com
  segurança. O botão de corrigir existe sempre; o destaque de dúvida, se vier, é só um aviso extra.
- **Corrigir depois não desfaz o pedido errado:** na voz, o pedido vai direto ao agente. Daí o "Corrigir e reenviar".

## Fase 3 — Alternativas

| Alternativa | Por que não sozinha |
|---|---|
| Trocar para `large-v3` | Mais lento, ~3 GB de VRAM, e não resolve nomes que o modelo nunca viu. Entra na medição. |
| STT na nuvem (como o navegador) | Áudio sai da máquina, com custo e chave. Já existe (`VOZ_STT_MOTOR=url`), é escolha de quem instala. |
| Versão do Whisper ajustada para português | Licença e conversão para CTranslate2 a conferir antes; fica para depois da medição. |
| Dicionário só nos Ajustes | Ninguém lembra de cadastrar antes do erro. A correção no balão é onde o leigo percebe o erro. |

**Gate de extensão antes de criação:** a medição foi feita estendendo `stt_local.servico_da_linha`, que agora aceita
`hotwords` e `initial_prompt`, e ganhou o comando `medir-stt` em `comandos.py`, ao lado do `testar-stt`. Nenhum arquivo
de código novo; só o teste `tests/test_medir_stt.py`.

## Fase 4 — Proposta, em sprints

0. **Medição com a voz da operadora** (ferramenta pronta: `python -m newclaw_ivox medir-stt`):
   - umas 10 frases gravadas por ela, com os termos que erram e frases sem termo nenhum;
   - comparação: `large-v3-turbo` e `large-v3`, cada um sem apoio, com `hotwords` e com `initial_prompt`;
   - métrica: taxa de erro de palavras, separada entre frases com termo e frases sem termo, mais o tempo.
1. **Dicionário e lista nos Ajustes:**
   - "Palavras que eu conheço", com adicionar e remover;
   - o arquivo fica só nesta máquina, fora do repositório, como as outras preferências da janela;
   - o motor lê a lista a cada conexão e passa pelo apoio que a Sprint 0 escolher.
2. **Corrigir pelo balão:**
   - ✏️ "Corrigir" embaixo do texto ouvido;
   - ao confirmar, o sistema compara as palavras trocadas e pergunta: *"Guardar 'Cornélio Procópio' no dicionário para eu
     entender da próxima vez?"*.
3. **Corrigir e reenviar** (pedido da operadora):
   - o texto corrigido vai ao NewClaw como o pedido certo;
   - na conversa fica visível que é a versão corrigida da fala anterior;
   - a oferta de guardar no dicionário vale do mesmo jeito.
4. **Destaque de dúvida** (só se a medição mostrar que a nota de confiança do Whisper aponta os erros reais): as
   palavras de nota baixa aparecem sublinhadas, com o mesmo botão de corrigir.

## Fase 5 — Validação

- **Baseada em evidência real:** os 38 trechos dos testes dela.
- **Resolve a causa** (falta de vocabulário), não o sintoma.
- **Complexidade:** soma pouca, só uma lista e um botão; o vocabulário entra pelo mecanismo que o Whisper e o Pipecat
  já têm.
- **Incremental e reversível:** com a lista vazia, tudo funciona como hoje.

## Decisões para a operadora

- **D1.** Baixar o `large-v3` (~2,9 GB, Hugging Face, licença MIT) para entrar na medição, ou medir só o turbo?
- **D2.** Se o agente ainda estiver respondendo quando a pessoa aperta "Corrigir e reenviar", a resposta em andamento é
  interrompida (como a interrupção pela voz que já existe) ou termina antes?
  - **Decidida em 04/11/2026: manter o comportamento atual.** Com pedido em andamento, o "Corrigir e reenviar" não age: a
    resposta segue, e parar é decisão da pessoa (botão Parar). Coberto pelo teste da janela "com pedido em andamento,
    recusa: parar a resposta é decisão da pessoa" (`janela/src/conversa.test.ts`).
  - **Revista em 07/11/2026 pela operadora:** "não adianta ele ficar trabalhando, pensando, tentando resolver um problema
    errado". Com pedido em andamento, o botão da fala é **Parar e corrigir**: cancela o pedido, corta a fala e abre o
    texto. Na caixa, o botão é **Enviar**. A resposta do pedido parado é descartada. Na janela desde newclaw-ivox
    `02a9901`.
- **D1 continua em aberto:** depende da medição com as gravações da operadora (Sprint 0), que é ação dela.

O ditado do painel fica fora: ele usa o reconhecimento do próprio navegador, que não aceita vocabulário.

## Revisão 2 (07/11/2026): o dicionário antes da medição, guardado no NewClaw

**Pedido da operadora:** fazer as Sprints 1 e 2 já, com a lista valendo no reconhecimento, "pensando no usuário leigo".
O limite provisório fica anotado como provisório até a D1. Três pontos dela mudam a proposta da Fase 4:
- **Backup:** "se eu fizer backup das minhas informações, isso vai junto? Porque isso é importante". Na Sprint 1, a
  lista ficava num arquivo da pasta da voz, que o backup do NewClaw (ADR-020) não leva.
- **Erro de digitação:** "e se a pessoa digitou errado e enviou sem querer?". Errar é comum, então a lista precisa de
  uma tela para listar e corrigir, e não só de adicionar e remover.
- **Aprender:** sempre perguntando antes, nunca sozinho. É a opção 1 dela, o padrão da ADR-028.

### Fase 1: o que existe (conferido no código em 07/11)

- **Backup (ADR-020, `backupDoConhecimento.ts`):**
  - leva o banco `data/newclaw.db` inteiro, as skills e o perfil dos juízes; o histórico, o workspace e o `.env` só se
    a pessoa marcar;
  - a pasta da voz (newclaw-ivox) não entra, e os ajustes da janela ficam no navegador.
- **Sincronização (ADR-034, `syncAgent.ts`):**
  - só compartilha `memory_nodes`, `memory_edges` e `auto_skills`, cada tabela com regra própria de junção em
    `importarPacote`;
  - a tabela `memory` (chave e valor) fica fora, porque guarda dados desta máquina, como o resumo da senha do painel.
- **Chave e valor já existentes:** `MemoryManager.getSetting`/`setSetting` gravam na tabela `memory`.
- **O Whisper (Pipecat 1.12, faster-whisper):**
  - o `WhisperSTTService.run_stt` lê `hotwords` a cada trecho, então a lista muda sem recarregar o modelo
    (`STTUpdateSettingsFrame`);
  - o faster-whisper corta `hotwords` em `max_length // 2 - 1` tokens: 223 no Whisper, de `max_length` 448, lido do
    modelo. Ele guarda o começo e joga fora o resto sem avisar.
- **O harness** só repassa as rotas do contrato do turno (`ROTAS_DO_CONTRATO`).

### Fase 2: crítica

- **Memória do agente (`memory_nodes`)** daria a sincronização de graça, mas cada palavra viraria contexto do agente
  nas buscas, e o curador (`MemoryCurator`) pode juntar ou apagar nós. O dicionário mudaria sem a pessoa pedir. Recusado.
- **Tabela própria** pediria uma regra de junção nova na sincronização. Ela ainda não está ligada (falta a prova do
  Syncthing), então isso pode vir depois, sem perder nada.
- **Corte silencioso do Whisper:** com a lista maior que o teto, as últimas palavras deixariam de valer sem ninguém
  saber. Por isso o motor conta os tokens com o tokenizador do modelo carregado, e a janela mostra quantas palavras cabem.
- **Quando oferecer o cartão:** a correção pode ser uma troca de ideia. A comparação é só de forma (determinismo): um
  único trecho trocado, com palavras iguais em volta. Uma frase reescrita inteira não oferece nada, e quem decide
  guardar é sempre a pessoa.
- **Erro de digitação:** três camadas. O cartão mostra a palavra e deixa mudar antes; logo depois, "Desfazer"; e, a
  qualquer hora, a tela das palavras, com editar e apagar (com "Desfazer", sem caixa de "tem certeza?").

### Decisões

- **D3. Onde fica:** no banco do NewClaw, `memory`, chave `voz_vocabulario`, categoria `voz`, pelo
  `getSetting`/`setSetting` que já existem. O valor é `{ "revisao": n, "palavras": [{ "palavra", "ouvia": [], "vezes",
  "criadaEm", "atualizadaEm" }] }`.
  - Vai no backup e volta na restauração.
  - **Não** vai na importação entre instalações nem na sincronização (ADR-034). Isso fica como extensão da ADR-034,
    quando a sincronização for ligada.
- **D4. Rota:** `GET` e `PUT /api/voz/vocabulario`, com o login do painel.
  - O `PUT` leva a lista inteira e a `revisao` lida. Se outra janela mudou antes, o `PUT` responde 409 e não sobrescreve.
  - O "Desfazer" é um `PUT` da lista anterior.
  - Tetos de proteção contra abuso: 200 palavras, 60 caracteres por palavra e 10 "eu ouvia" por palavra. Não são o
    tamanho bom da lista: esse vem da D1.
  - `GET /api/status` anuncia `contracts.voz_vocabulario: 1`. Com um NewClaw sem a rota, a janela não oferece o
    dicionário e diz por quê.
  - O harness repassa só essas duas rotas.
- **D5. Apoio no Whisper (provisório até a D1):** `hotwords`, com as palavras na ordem da lista: as mais corrigidas e,
  no empate, as mais recentes primeiro, porque o corte do Whisper descarta o fim.
  - Na prova da CPU, `hotwords` e `initial_prompt` deram 0% cada. O `hotwords` foi feito para isso, e o
    `initial_prompt` também muda o estilo da transcrição.
  - A janela manda a lista ao motor a cada conexão e a cada mudança (protocolo do motor, versão 4:
    `{"t": "vocabulario", "d": {"palavras": [...]}}`). O motor não fala com o NewClaw: a fonte é uma só.
- **D6. Teto (provisório até a D1):** o do próprio modelo (`max_length // 2 - 1` tokens), contado com o tokenizador do
  modelo carregado. A tela mostra "N de M palavras cabem". Com o modelo descarregado, mostra que a conta aparece quando
  ele carregar. Um teto de qualidade menor que esse só com a medição.
- **D7. A janela:**
  - o cartão "Quer que eu aprenda **X**? Eu tinha ouvido Y", com [Aprender], [Mudar a palavra] e [Agora não], só em fala
    por voz;
  - "Aprendi X. [Desfazer]" logo depois;
  - a tela "Palavras que eu conheço", em Ajustes e pelo link do cartão: editar a palavra e os "eu ouvia", apagar com
    "Desfazer", ensinar palavra nova e buscar quando a lista crescer.

### Fase 5: validação

- **Evidência real:** os erros dos 38 trechos ("Rigger", "Cornelia Procobre"), as correções reais de 07/11 e o código
  medido acima.
- **Complexidade:** soma uma rota, uma mensagem do motor e uma tela. A chave e valor do banco, o apoio do Whisper e o
  backup já existiam.
- **Reversível:** lista vazia funciona como hoje; com a rota ausente, a janela esconde o dicionário.
- **Hipóteses não comprovadas:** que `hotwords` vale mais que `initial_prompt` com a voz dela, e que o teto do modelo é
  um tamanho bom. As duas ficam para a D1.
