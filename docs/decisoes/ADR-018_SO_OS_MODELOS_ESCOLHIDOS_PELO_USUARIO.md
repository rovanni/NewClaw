# ADR-018 — Só os modelos escolhidos pelo usuário (nenhum modelo no código, nenhuma reserva)

Status: aceita (14/10/2026) — implementada na Sprint 2 da campanha de 14/10; validação em ambiente real pendente (etapa 4).
Origem: diretiva da mantenedora, 14/10/2026 — *"O sistema é para utilizar somente os modelos escolhidos pelo usuário via
dashboard ou na configuração inicial, não deve ter nenhum modelo em código nem de fallback"* — depois de a investigação do
juiz mostrar tentativas registradas com um modelo que ninguém tinha escolhido (o rótulo da tentativa cancelada, S299.6).

## Fase 1 — Compreensão

**O que existia.** Três caminhos faziam o NewClaw usar um modelo que o usuário não escolheu:

1. **Modelos embutidos.** Os construtores dos 5 provedores nativos traziam um modelo próprio (`gemini-2.0-flash`,
   `deepseek-chat`, `llama-3.3-70b-versatile`, um Claude, `gpt-4o` no OpenAI); o provedor personalizado sem modelo caía
   num id `'default'`; o `EmbeddingService` tinha `nomic-embed-text:v1.5` fixo; a CLI (`newclaw config`), os dois
   instaladores e a rota de provedores tinham listas e padrões próprios — os instaladores escolhiam um modelo de nuvem
   PAGO ao apertar Enter.
2. **A cadeia de reserva.** `getFallbackOrder` devolvia todos os provedores configurados; quando o escolhido falhava,
   outro respondia. A issue 071 (08/10) já filtrava a reserva que sairia da máquina, com a opção
   `PERMITIR_NUVEM_COMO_RESERVA` para religar.
3. **A refação sem streaming no Ollama.** Depois de todas as tentativas, `chatWithFallback` tentava o Ollama sem
   streaming — mesmo quando o escolhido era outro provedor.

**Sinais de que a escolha não chegava.** Para Gemini/DeepSeek/Groq/OpenRouter/Anthropic não havia onde guardar o modelo:
o assistente do painel chamava `aplicarModeloATudo('')` depois de validar a chave e o provedor seguia com o modelo do
construtor; a CLI descartava o modelo digitado para três deles. O embedding em produção não gerava vetores (5 tentativas,
0 gerados) com o modelo fixo.

**Decisões anteriores.** Nunca Adivinhar (ausência se reporta, não se preenche); Soberania da Configuração (troca só
permitida e visível); issue 068 (o Ollama já não tinha modelo embutido: vazio → avisa); issue 071 (reserva local).

## Fase 2 — Crítica

| Motivo para não fazer | Resposta |
|---|---|
| Sem reserva, uma queda do provedor vira erro para o usuário | É o comportamento pedido: a falha do escolhido é o resultado, dita com o nome do provedor. A reserva já tinha produzido respostas de nuvem para quem escolheu local (RFC-005) |
| Instalações existentes sem `<PROVEDOR>_MODEL` param de responder com nativos | O ProviderFactory devolve a mensagem "nenhum modelo escolhido para X — escolha no painel"; o assistente do painel agora pergunta o modelo. Risco aceito e anunciado |
| Embeddings desligados por padrão | Já não funcionavam em produção; a busca por palavras (S236) não depende deles. `EMBED_MODEL` religa |
| O painel deixa de sugerir modelos | A lista vem da descoberta real (catálogo do provedor, `ollama list`) e do que o usuário digita — nunca de uma lista que envelhece no código (a antiga tinha nomes que nem existiam) |

## Fase 3 — Alternativas

- **Manter a reserva desligada por padrão, com opção.** Rejeitada: é o estado da issue 071, e a diretiva pede que não
  exista reserva.
- **Manter os modelos embutidos só como sugestão no painel.** Rejeitada: sugestão no código envelhece e vira padrão de
  fato quando o usuário aperta Enter (foi o que os instaladores fizeram).
- **Escolhida:** cadeia de um só provedor (o declarado), nenhum modelo no código, a escolha guardada em variáveis por
  provedor (`GEMINI_MODEL`, `DEEPSEEK_MODEL`, `GROQ_MODEL`, `OPENROUTER_MODEL`, `ANTHROPIC_MODEL`, `EMBED_MODEL`),
  lidas no boot e gravadas pelo painel com o mesmo mapa (`VARIAVEL_DO_MODELO_NATIVO`).

## Fase 4 — Síntese (o que mudou)

- `ProviderFactory`: `getFallbackOrder` → só o declarado; a refação sem streaming só quando o declarado JÁ é o Ollama;
  sem modelo escolhido → `mensagemSemModelo(provedor)`; sem provedor → `mensagemSemProvedor`; a opção
  `PERMITIR_NUVEM_COMO_RESERVA` e o filtro de reserva saíram. `modeloPermitidoPelaSoberania` fica só para SUGESTÕES
  (lista de candidatos a juiz): quem roda local não recebe sugestão de nuvem.
- Construtores dos nativos e do OpenAI sem modelo (nem `baseUrl`) padrão; `setModeloNativo` aplica a troca na hora.
- Embeddings: `modeloDeEmbedding()` lê `EMBED_MODEL` a cada uso; vazio desliga sem chamada de rede.
- Painel: etapa `nativeModelSelect` (obrigatória) depois da validação da chave; o Model ID do personalizado também
  passou a ser obrigatório; saíram a opção de reserva, os 5 atalhos de download e os textos "reserva automática"
  (pt-BR/en-US/es-ES).
- Instaladores (`install.sh`, `install.ps1`) e CLI: sem padrão — perguntam (mostrando o que o Ollama já tem) e vazio =
  escolher no painel. Removido `scripts/setup.ts` (código morto desde o commit inicial, gravava variáveis que ninguém lê).

**Código que ficou sem uso — removido na Sprint 4.** O anúncio de substituição (RFC-005 §1.4:
`mensagensComFatoDaSubstituicao`, `substituicaoAtravessaFronteira`, `anunciarSubstituicao`, `LLMResult.substitution`) e a
política de substituição (`estrita`/`anunciada`/`livre`, `SUBSTITUTION_POLICY`, `CustomProviderConfig.substitutionPolicy`,
`policy_strict`) ficaram sem caminho que os acionasse e saíram do código; RFC-005 marcada como revogada, a seção 6 da
Soberania anotada. S207 (a política) foi removido; S208 trava a remoção.

## Fase 5 — Validação

Evidência real (logs e bancos de produção), causa estrutural (a cadeia e os padrões, não um caso), reduz complexidade
(sai a política de reserva e suas listas), elimina fontes de verdade concorrentes (o modelo existe num lugar só: a escolha
do usuário), reversível por commit. Testes: S243 (embedding), S254 (assistente nativo), S250/S251 (assistente),
S208 (nenhuma substituição em 4 cenários), S364 (soberania), S190 (cadeia).
