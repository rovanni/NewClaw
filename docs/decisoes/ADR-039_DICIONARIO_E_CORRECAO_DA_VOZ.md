# ADR-039 — Dicionário da voz, correção pelo balão e "Corrigir e reenviar"

Data: 04/11/2026. Status: **proposta**. A ordem de trabalho e o "Corrigir e reenviar" foram aprovados pela operadora em
04/11/2026. A medição com a voz dela (Sprint 0) decide qual apoio de vocabulário vale e se o modelo muda. Implementação no
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

O ditado do painel fica fora: ele usa o reconhecimento do próprio navegador, que não aceita vocabulário.
