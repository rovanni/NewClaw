# ADR-019 — Cofre de segredos: o valor de uma senha nunca circula em claro

Status: aceita (14/10/2026) — implementada na Sprint 3 da campanha de 14/10; validação em ambiente real pendente (etapa 4).
Origem: pergunta da mantenedora — *"Teria como o NewClaw ser mais seguro em relação às senhas?"* — depois de uma senha de
app do Gmail, digitada no chat em 11/10/2026 para configurar o himalaya, aparecer espalhada pela instalação.

## Fase 1 — Compreensão

**Por onde o valor passou** (instância Windows, contagem por hash, sem ler o valor): log de auditoria; 7 arquivos de
`logs/avaliadores`; 1 transcrição em `data/sessions`; tabelas `reflection_annotations` (20), `agent_traces` (5),
`memory_classifications` (4), `messages` (1), `goals` (1); e os prompts enviados aos modelos de nuvem. No Linux, 4 linhas
de log.

**Causa estrutural.** Não havia nenhum ponto em que o sistema reconhecesse uma credencial: o texto do usuário entrava
inteiro em tudo. O primeiro vazamento acontecia antes até do MessageBus — o `TelegramAdapter` logava 50 caracteres do
texto. A única detecção existente era local à ADR-017 (`aprendizadoDeSkills.ts`, só para o texto das skills).

**Decisões que se aplicam.** Princípio da Preservação do Raciocínio (decisão determinística só por segurança —
precedente `isDestructive()`); Quando Extrair Duplicação (os padrões de credencial são o mesmo conhecimento em dois
usos → módulo-folha); Nunca Adivinhar (marcador desconhecido não vira valor plausível).

## Responsabilidade antes do mecanismo

PERGUNTA: "este trecho é um valor secreto que não pode circular?" · RESPONSABILIDADE: proteger a confidencialidade antes
de qualquer persistência · EVIDÊNCIA: formatos inconfundíveis (sk-…, ghp_…, JWT, chave privada) e o par rótulo + valor
com cara de senha; a senha de app (4×4 letras), ambígua em prosa, só perto de uma palavra de credencial · AUTORIDADE:
determinística, como exceção de SEGURANÇA — perguntar ao LLM "isto é uma senha?" já seria o vazamento · ESTADO: o cofre
(`SEGREDO_<NOME>` no .env, onde as chaves de API já vivem) · CONSUMIDOR: só a execução de ferramenta recebe o valor.

## Fase 2 — Crítica

| Risco | Tratamento |
|---|---|
| Falso positivo troca texto comum | Só formatos inconfundíveis ou rótulo + valor com 2+ classes de caractere; o usuário é avisado e desfaz com `/segredo_apagar` |
| Falso negativo (senha sem rótulo, só letras) | `/segredo <nome> <valor>` explícito; e a máscara pega o valor em qualquer lugar depois de guardado |
| O agente perde a capacidade de usar a senha | O marcador vai nos argumentos e a ferramenta recebe o valor só na execução |
| Injeção de instruções manda o marcador para fora | Já era possível com o valor em claro — o marcador não piora; o prompt proíbe enviar marcador a endereço não pedido; chaves de API do NewClaw nunca são resolvidas por marcador |
| Cofre não grava (.env somente leitura) | O valor sai da mensagem mesmo assim (`<SEGREDO:nao_guardado>`) e o usuário é avisado |
| Custo da máscara em cada log/chamada | Lista de valores em cache de 5 s, invalidada quando o cofre muda |

## Fase 3 — Alternativas

- **Só mascarar os logs.** Rejeitada: banco, transcrição e modelos de nuvem continuariam recebendo o valor.
- **Cofre do sistema operacional (Credential Manager / Keychain / libsecret).** Melhor isolamento, mas três
  implementações e dependências nativas para um sistema que já guarda chaves de API no .env; fica como evolução.
- **Escolhida:** detecção na entrada + cofre no .env + marcador; resolução e máscara num único embrulho no
  `ToolRegistry`; máscara de defesa no `AppLogger` e no `ProviderFactory.chatWithFallback`.

## Fase 4 — Síntese (o que mudou)

- `src/shared/segredos.ts` — único lugar dos padrões, do cofre, da máscara e da resolução.
- `MessageBus.processMessage` protege a entrada antes do primeiro log; `TelegramAdapter` loga só o tamanho.
- `ToolRegistry.comSegredos` (em `get`, `getEnabled` e `AgentLoop.registerTool`): resolve nos argumentos, mascara a saída.
- `AppLogger` e `ProviderFactory` mascaram valores do cofre e de chaves de API.
- Comandos `/segredo`, `/segredos`, `/segredo_apagar`; aviso ao usuário nas 3 línguas; seção do prompt do agente.
- `aprendizadoDeSkills.ts` importa os padrões em vez de manter cópia.

**Limitações.** O valor ainda aparece no histórico do próprio canal (o Telegram guarda a mensagem do usuário); dados
anteriores à mudança precisam de limpeza à parte (feita com backup, na mesma sprint).

## Fase 5 — Validação

Evidência real (o incidente), causa estrutural (nenhum ponto reconhecia credencial), uma fonte de verdade para os padrões,
reversível. Teste: `S395` (detecção nas 3 línguas e sem falso positivo em prosa, cofre, máscara, resolução, embrulho de
ferramenta, logger, envio a modelos, ordem no MessageBus).
