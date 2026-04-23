# Plano de Implementação — Thorial

**Data:** 08/04/2026
**Status:** Rascunho para aprovação
**Autor:** IAL (com base nas specs + lições do IalClaw)

---

## Princípios

1. **Simples > Complexo** — Sem 4 camadas de decisão
2. **LLM decide, sistema executa** — Apenas protege contra destruição
3. **100% local** — SQLite + Whisper + Edge-TTS
4. **Multi-LLM** — Gemini, DeepSeek, Groq via ProviderFactory
5. **Hot-reload** — Skills em SKILL.md, sem restart

---

## Fase 0: Setup do Projeto (1 dia)

### Estrutura
```
NewClaw/
├── src/
│   ├── core/
│   │   ├── AgentController.ts      # Facade principal
│   │   ├── SimpleDecisionEngine.ts  # 3 categorias: EXECUTE/DIRECT_REPLY/CONFIRM
│   │   └── ProviderFactory.ts       # Troca de LLMs
│   ├── input/
│   │   └── TelegramInputHandler.ts  # Grammy + Whitelist + STT
│   ├── output/
│   │   └── TelegramOutputHandler.ts # Strategy: Text/Chunk/File/Audio
│   ├── loop/
│   │   └── AgentLoop.ts             # ReAct simples (5 iterações)
│   ├── memory/
│   │   ├── MemoryManager.ts         # Facade
│   │   ├── ConversationRepository.ts
│   │   ├── MessageRepository.ts
│   │   └── ContextManager.ts        # lastResult + contexto
│   ├── skills/
│   │   ├── SkillLoader.ts           # Hot-reload de SKILL.md
│   │   ├── SkillRouter.ts           # LLM escolhe skill
│   │   └── SkillExecutor.ts         # Executa skill no loop
│   ├── tools/
│   │   ├── ToolRegistry.ts          # Registro de tools
│   │   ├── exec_command.ts          # Executar comandos
│   │   ├── web_search.ts            # Busca web
│   │   ├── file_ops.ts              # Criar/ler/mover arquivos
│   │   └── crypto_report.ts         # Relatório cripto
│   └── index.ts                      # Entry point
├── skills/                           # Skills em SKILL.md
├── data/                             # SQLite
├── tmp/                              # Arquivos temporários
├── .env                              # Config
├── tsconfig.json
└── package.json
```

### Dependências
```json
{
  "grammy": "Telegram Bot API",
  "better-sqlite3": "SQLite síncrono",
  "edge-tts": "TTS local",
  "pdf-parse": "Leitura de PDFs"
}
```

### .env
```env
TELEGRAM_BOT_TOKEN=
TELEGRAM_ALLOWED_USER_IDS=
APP_LANG=pt-BR
DEFAULT_PROVIDER=gemini
GEMINI_API_KEY=
DEEPSEEK_API_KEY=
GROQ_API_KEY=
MAX_ITERATIONS=5
MEMORY_WINDOW_SIZE=20
```

---

## Fase 1: Core + Memória (2 dias)

### 1.1 MemoryManager (SQLite)
- [ ] Criar banco com WAL
- [ ] Tabelas: conversations, messages
- [ ] Repository Pattern (ConversationRepository, MessageRepository)
- [ ] Window de contexto (MEMORY_WINDOW_SIZE)
- [ ] lastResult por chat (contexto entre mensagens)

### 1.2 ContextManager
- [ ] Manter lastResult da última execução
- [ ] Detectar continuação de conversa
- [ ] Fornecer contexto para o AgentLoop

### 1.3 SimpleDecisionEngine
- [ ] 3 categorias: EXECUTE, DIRECT_REPLY, CONFIRM
- [ ] Keywords de ação → EXECUTE
- [ ] Perguntas → DIRECT_REPLY
- [ ] Ações destrutivas → CONFIRM
- [ ] Sem confidence score complexo

---

## Fase 2: Input + Output (2 dias)

### 2.1 TelegramInputHandler
- [ ] Grammy polling
- [ ] Whitelist por user ID
- [ ] Texto → direto para o pipeline
- [ ] PDF → pdf-parse → texto
- [ ] Áudio/Voz → Whisper local → texto
- [ ] Sinalizar requires_audio_reply quando input é voz
- [ ] Limpeza automática de tmp/

### 2.2 TelegramOutputHandler
- [ ] TextOutputStrategy — texto direto
- [ ] ChunkStrategy — fatiar > 4096 chars
- [ ] FileOutputStrategy — enviar .md como documento
- [ ] AudioOutputStrategy — Edge-TTS (pt-BR-ThalitaNeural)
- [ ] Fallback: áudio falha → envia texto

---

## Fase 3: Loop + Skills (2 dias)

### 3.1 AgentLoop (ReAct)
- [ ] Loop com MAX_ITERATIONS=5
- [ ] Thought → Action → Observation
- [ ] Tool calls via ToolRegistry
- [ ] Executar tool e injetar resultado
- [ ] Parar quando LLM der resposta final
- [ ] Parar se exceder MAX_ITERATIONS

### 3.2 SkillLoader + SkillRouter
- [ ] Ler skills/ em hot-reload
- [ ] Frontmatter YAML → nome + descrição
- [ ] SkillRouter: LLM escolhe skill baseado no input
- [ ] SkillExecutor: injeta SKILL.md no system prompt
- [ ] Sem skill → chat normal

### 3.3 ProviderFactory
- [ ] Interface ILlmProvider
- [ ] GeminiProvider (google-gemini)
- [ ] DeepSeekProvider
- [ ] GroqProvider
- [ ] Fallback automático

---

## Fase 4: Tools (1 dia)

### 4.1 ToolRegistry
- [ ] Registro dinâmico de tools
- [ ] Schema JSON para cada tool
- [ ] Descrição para o LLM escolher

### 4.2 Tools Iniciais
- [ ] exec_command — rodar comandos shell
- [ ] web_search — busca na web
- [ ] file_ops — criar/ler/mover/deletar arquivos
- [ ] crypto_report — análise de criptomoedas

---

## Fase 5: Testes + Deploy (1 dia)

### 5.1 Testes
- [ ] Testar fluxo: texto → decisão → loop → resposta
- [ ] Testar STT (Whisper)
- [ ] Testar TTS (Edge-TTS)
- [ ] Testar chunking
- [ ] Testar skills
- [ ] Testar fallback de provider

### 5.2 Deploy
- [ ] Rodar na VPS Venus (your-server-ip)
- [ ] PM2 para gerenciar processo
- [ ] Logs em arquivo

---

## Cronograma

| Fase | Duração | Descrição |
|------|---------|-----------|
| **0** | 1 dia | Setup do projeto |
| **1** | 2 dias | Core + Memória |
| **2** | 2 dias | Input + Output |
| **3** | 2 dias | Loop + Skills |
| **4** | 1 dia | Tools |
| **5** | 1 dia | Testes + Deploy |
| **Total** | **9 dias** | |

---

## O que NÃO vamos fazer (lições do IalClaw)

| IalClaw fez | Thorial NÃO vai fazer |
|---|---|
| 4 camadas de decisão | Apenas SimpleDecisionEngine |
| Confidence score complexo | Sem threshold de 0.90 |
| CognitiveOrchestrator (2256 linhas) | Decisão simples (~300 linhas) |
| ActionRouter + DecisionEngine | Integrado no SimpleDecisionEngine |
| SHORT-CIRCUIT que bypassa tools | Sem short-circuit |
| "Não tenho certeza absoluta" | Nunca dizer que não consegue |
| Respostas em inglês | Sempre no idioma configurado |
| Perda de contexto | lastResult sempre disponível |

---

## Métricas de Sucesso

| Métrica | Target |
|---------|--------|
| "Pode instalar whisper" → executa | 100% |
| "Pode enviar áudio" → executa | 100% |
| "O que é BTC?" → responde em pt-BR | 100% |
| "1" (continuação) → usa contexto | 100% |
| "rm -rf /" → pede confirmação | 100% |
| Uptime | 99% |
| Latência input → output | < 5s |