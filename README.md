<a name="inicio"></a>
<a name="english"></a>
**[English Version](#english)** | **[Versão em Português](#português)**
# NewClaw 🪐

A local cognitive agent with semantic memory, native tool calling, and a Telegram interface.

![NewClaw Logo Banner](docs/assets/banner.png)

NewClaw is a local-first cognitive system built with Node.js and TypeScript. It combines persistent semantic memory, native tool calling, multi-provider fallback, and a web dashboard so the agent can reason over context, use tools structurally, and keep long-term knowledge across interactions.

Instead of acting like a simple reactive bot, NewClaw maintains an evolving world model with identities, preferences, projects, facts, and infrastructure represented as a semantic graph. That allows the agent to respond with more continuity, make better decisions, and reuse context over time.

Inspired by [Hermes Agent](https://github.com/NousResearch/Hermes-Agent) and [OpenClaw](https://github.com/openclaw/openclaw).

## 🧠 Atomic Cognition: Unified Decision Core

The core of NewClaw is its **Atomic Cognition Architecture**. Unlike traditional agents that follow a slow, linear chain of separate validation and critic steps, NewClaw processes all strategic intelligence in a single, unified atomic turn:

1.  **Unified Reasoning**: The agent thinks, decides on an action, and evaluates its own completion status in a single structured JSON response.
2.  **Extreme Efficiency**: Eliminates the latency of multiple sequential LLM calls, typically resolving tasks in just 1 or 2 high-value decision cycles.
3.  **Internal Self-Evaluation**: Confidence scoring and goal validation happen naturally within the model's internal reasoning, rather than through external supervisors.
4.  **Robust & Resilient**: Features advanced JSON parsing with automatic recovery from formatting errors and markdown leaks.
5.  **Clean & Direct**: Prioritizes useful, evidence-based answers over aesthetic perfection or over-execution.

This ensures the agent **"thinks once, but thinks deep,"** providing professional-grade autonomy with minimal latency.

## 🚀 The NewClaw Edge

What sets NewClaw apart is its focus on **Long-Term Cognitive Consistency** and **Structural Reliability**:

*   🛡️ **Local-First & Private**: Your data, memories, and models stay under your control. No third-party data harvesting.
*   🗺️ **Evolving World Model**: Unlike reactive bots that treat every session as new, NewClaw builds a persistent semantic graph of your preferences, projects, and infrastructure.
*   🏗️ **Native Structural Reasoning**: It doesn't "guess" how to use tools through text parsing. It uses native function calling to interact with the world with surgical precision.
*   🔄 **Extreme Resilience**: With a multi-provider fallback chain and an intelligent model router, the system ensures continuity even if a specific model or provider fails.
*   🎓 **Self-Optimizing Skills**: The agent doesn't just perform tasks; it observes patterns in its own execution and proposes new, reusable skills to become more efficient over time.

### 🔄 The Learning Cycle
NewClaw doesn't just store data; it evolves. The system follows a continuous optimization loop:
```mermaid
graph LR
    A["👁️ Observe"] --> B["🧠 Learn"]
    B --> C["💡 Propose"]
    C --> D["✅ Approve"]
    D --> E["🚀 Apply"]
```
*Observe patterns → Learn interactions → Propose reusable skills → User approval → Apply in future tasks.*

## ⚙️ Core Operation Modes
The agent operates in four distinct modes depending on the task complexity:
1.  💬 **Respond**: Natural conversation and reasoning using long-term context.
2.  🔍 **Search**: Multi-source synthesis and evidence-based research.
3.  🧭 **Explore**: Active web navigation and deep page interaction.
4.  ⚡ **Execute**: Direct system commands and precise file operations.

## ✨ Features

| Feature | Description |
|---------|-----------|
| 🧠 **Semantic Memory** | SQLite + FTS5 + embeddings, 7 node types, 14+ relationships with advanced curation (merge/delete). |
| 📞 **Native Tool Calling** | Structural function calling (Ollama/Gemini) for precision without fragile text parsing. |
| 🧭 **Model Router** | Intelligent LLM routing to specialized models (Chat, Code, Vision, Analysis) with failover. |
| 🔄 **Provider Fallback** | Multi-provider resilience: Ollama → Gemini → DeepSeek → Groq. |
| 🎓 **SkillLearner** | Autonomous pattern recognition that feeds the **Learning Cycle** for user-approved efficiency. |
| 🌐 **Web Search** | Iterative multi-source research with grounded synthesis and page reading. |
| 🧭 **Active Exploration**| **Exploration Layer**: Terminal-style web navigation for deep site interaction (supports `w3m`). |
| 📊 **Web Dashboard** | Real-time chat, config suite, memory curation, and interactive graph visualization. |
| 📱 **Telegram Interface** | Full mobile control, voice support (Whisper/Edge-TTS), and natural language skill review. |
| 📸 **Snapshots** | Graph versioning with create, restore, list, and delete operations. |

## 🏗️ Architecture

### Message Flow

```mermaid
flowchart LR
    U["👤 User"] --> T["📨 Telegram Bot"]
    T --> A["🧠 AgentLoop"]

    subgraph AgentLoop
        A1["🗜️ ContextCompressor"]
        A2["📝 Prompt Assembly"]
        A3["🤖 LLM — Tool Calling"]
        A4["🎓 SkillLearner"]
        A1 --> A2 --> A3 --> A4
    end

    A3 -->|"tool_calls"| S["🛠️ Tools"]
    A3 -->|"response"| U

    subgraph Tools
        S1["🌐 web_search"]
        S2["🧠 memory_search"]
        S3["✏️ memory_write"]
        S4["🔊 send_audio"]
        S5["⚡ exec_command"]
        S6["📄 file_ops"]
    end

    S --> S1
    S --> S2
    S --> S3
    S --> S4
    S --> S5
    S --> S6
    S -->|"result"| A3

    A <--> M["💾 Memory — SQLite"]
    A <--> D["🖥️ Dashboard"]
```

### Tool Calling Flow

```mermaid
flowchart TD
    A["User sends message"] --> B["ContextCompressor"]
    B --> C["Prompt Assembly — SOUL + USER + MEMORY"]
    C --> D["LLM receives message + tool definitions"]
    D --> E{"LLM decides"}
    E -->|"Direct response"| F["Format & send to user"]
    E -->|"Tool call needed"| G["Execute tool"]
    G --> H["Tool result → back to LLM"]
    H --> D
    F --> I["✅ User receives natural reply"]
```

### Provider Fallback Chain

```mermaid
flowchart LR
    A["🤖 LLM Request"] --> B{"Ollama"}
    B -->|"✅ Success"| Z["Response"]
    B -->|"❌ Fail"| C{"Gemini"}
    C -->|"✅ Success"| Z
    C -->|"❌ Fail"| D{"DeepSeek"}
    D -->|"✅ Success"| Z
    D -->|"❌ Fail"| E{"Groq"}
    E -->|"✅ Success"| Z
    E -->|"❌ Fail"| F["⚠️ All providers failed"]
```

### Model Router — Intelligent Model Selection

```mermaid
flowchart TD
    A["👤 User message"] --> B["🧭 ModelRouter"]
    B --> C["🤖 LLM Classifier"]
    C --> D{"Category?"}
    D -->|"💬 chat"| M1["glm-5.1:cloud"]
    D -->|"💻 code"| M2["gemma4:31b-cloud"]
    D -->|"👁️ vision"| M3["gemma4:31b-cloud"]
    D -->|"⚡ light"| M4["glm-5.1:cloud"]
    D -->|"📊 analysis"| M5["glm-5:cloud"]
    C -->|"❌ Fallback"| M1
    M1 --> E["🧠 AgentLoop with selected model"]
    M2 --> E
    M3 --> E
    M4 --> E
    M5 --> E
    E -->|"❌ Error"| F["🔄 Auto-fallback to next model"]
    F --> E
```

The ModelRouter uses a lightweight LLM to classify each user message into one of 5 categories, then selects the best model for that task type. If the classifier fails, deterministic keyword matching is used as fallback. On model error, it automatically falls back to the next available model.

**Categories & Models:**

| Category | Use Case | Model |
|----------|----------|-------|
| 💬 chat | General conversation, reasoning | glm-5.1:cloud |
| 💻 code | Programming, file editing, scripts | gemma4:31b-cloud |
| 👁️ vision | Image analysis, OCR, screenshots | gemma4:31b-cloud |
| ⚡ light | Short responses (hi, ok, thanks) | glm-5.1:cloud |
| 📊 analysis | Crypto, market data, statistics | glm-5:cloud |

### Semantic Memory Graph

```mermaid
flowchart TD
    U["👤 core_user"] -->|"prefers"| P1["📊 pref_crypto"]
    U -->|"works_on"| P2["💻 proj_newclaw"]
    U -->|"runs_on"| I1["🖥️ infra_venus"]

    P2 -->|"uses"| S1["🧠 semantic_search"]
    P2 -->|"depends_on"| I2["🗄️ infra_timescaledb"]

    style U fill:#00d4aa,color:#000
    style P1 fill:#a78bfa,color:#000
    style P2 fill:#38bdf8,color:#000
    style I1 fill:#fb923c,color:#000
    style I2 fill:#fb923c,color:#000
    style S1 fill:#f472b6,color:#000
```

**7 Node Types:** identity, preference, project, skill, context, fact, infrastructure.

**14+ Relationship Types:** prefers, works_on, runs_on, uses, depends_on, contains, references, related_to, belongs_to, owns, created, reads, writes, hosts, plus automatic inverse links.

### Session System (v2)

NewClaw uses an **event-sourced session architecture** for full conversational continuity:

```
data/sessions/
├── telegram:8071707790.jsonl     # Append-only transcript (source of truth)
└── telegram:8071707790.idx.json  # Seek index for fast replay
```

| Component | Purpose |
|-----------|---------|
| **SessionTranscript** | JSONL append-only log, every event recorded with sequence number and metadata |
| **SessionManager** | Mutex per session, hybrid compression (20 msgs OR 3000 tokens), checkpoint as structured system role |
| **SessionContext** | Builds LLM context: system prompt → checkpoint → recent messages → semantic memory |
| **SessionLearner** | Extracts facts from conversations into the cognitive graph (names, preferences, projects, skills) |
| **EventRanker** | Scores events by importance (role weight, recency, question/decision detection) |

**Token Estimation:** pt-BR aware — 3.5 chars/token for text, 3 chars/token for code/JSON.

**Compaction:** `compactSession()` physically rewrites JSONL (checkpoint + recent events), with `.bak` backup.

**`/clear` command:** Creates a new session (preserves old transcript).

### Memory Governance

NewClaw's memory is **self-regulating** — it learns AND unlearns:

```mermaid
flowchart TD
    A["💬 Conversation"] -->|"SessionLearner"| B["🧠 Cognitive Graph"]
    B -->|"MemoryGovernor"| C{"Governance Cycle"}
    C -->|"decay"| D["📉 Confidence -2%/day"]
    C -->|"conflict"| E["⚖️ Detect & Resolve"]
    C -->|"gc"| F["🗑️ Archive (not delete)"]
    C -->|"feedback"| G["🔁 Reinforce/Decay"]
    D --> B
    E --> B
    F --> H["📦 Archived nodes"]
    G --> B
```

| Mechanism | Rule |
|-----------|------|
| **Confidence Decay** | 2%/day (inferred facts decay 5% faster). Protected nodes never decay. |
| **Conflict Detection** | Contradictions (same domain, different values), duplicates (>85% Jaccard similarity) |
| **Conflict Classification** | `coexist` (both explicit), `replace` (explicit beats inferred), `uncertain` (reduce both) |
| **Garbage Collection** | Archive instead of delete. `metadata.archived=true`, `original_type` preserved for recovery. |
| **Anti-Reinforcement Loop** | Confidence ceiling at 0.95. Diminishing returns: each boost gives 75% of previous (0.75^n). |
| **Usage Feedback** | Helpful facts: +0.05 confidence. Unhelpful: -0.02. Weighted by access count. |
| **Source Classification** | `explicit` (user stated directly) → strong. `inferred` (extracted) → decays faster. |
| **Protected Nodes** | `core_user`, `user_identity`, and all `identity` type nodes never decay or get GC'd. |

**Governance cycle** runs automatically on boot + every 24 hours.

#### Archived Memory Recovery

Archived nodes can be revived if the same fact appears again:

```typescript
// Automatic revival in SessionLearner
if (existingNode.metadata?.archived === 'true') {
    // Revive: restore original type, boost confidence
    memory.addNode({
        ...existingNode,
        type: existingNode.metadata.original_type,
        confidence: Math.min(0.95, (existingNode.confidence || 0.1) + 0.2),
        metadata: { ...existingNode.metadata, archived: undefined }
    });
}
```

> **Result:** Memory with reversible forgetting — old knowledge can come back when relevant again.

## 🚀 Setup

### Install Flow

```mermaid
flowchart TD
    A["📦 Run install.sh"] --> B["✅ Verificar Sistema"]
    B --> C["🔄 Atualizar Ubuntu + Deps"]
    C --> D["🟢 Instalar Node.js 22"]
    D --> E["🤖 Instalar Ollama"]
    E --> F{"Escolher Modelo"}
    F -->|"1"| G1["glm-5:cloud — Recomendado"]
    F -->|"2"| G2["llama3.1:8b — Rápido"]
    F -->|"3"| G3["mistral:7b — Conversação"]
    F -->|"4"| G4["qwen2.5:3b — Leve"]
    G1 --> H["📥 git clone + npm install + build"]
    G2 --> H
    G3 --> H
    G4 --> H
    H --> I["🔑 Configurar Token + ID do Telegram"]
    I --> J["▶️ newclaw start --daemon"]
    J --> K{"Opcional"}
    K -->|"Sim"| L["🖥️ systemd + firewall"]
    K -->|"Não"| M["🪐 Pronto!"]
    L --> M

    style A fill:#38bdf8,color:#000
    style I fill:#f472b6,color:#000
    style M fill:#00d4aa,color:#000
```

### Quick Install (Recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/rovanni/NewClaw/main/install.sh | bash
```

### Manual Install

```bash
git clone https://github.com/rovanni/NewClaw.git
cd NewClaw
npm install
cp .env.example .env
# Edit .env with your Telegram Token, User ID and OLLAMA_MODEL
npm run build
newclaw start --daemon
```

### 🪟 Windows Install

**Quick install (PowerShell — run as Administrator):**

```powershell
irm https://raw.githubusercontent.com/rovanni/NewClaw/main/install.ps1 | iex
```

**Options:**

```powershell
# With pre-set credentials
.\install.ps1 -Token "YOUR_TOKEN" -UserId "YOUR_ID" -NoPrompt

# Dry run (simulate without changes)
.\install.ps1 -DryRun

# Specific model
.\install.ps1 -Model "llama3.1:8b"

# Skip Windows service creation
.\install.ps1 -NoService
```

**What it does:**
- Verifies system (RAM, disk, internet)
- Installs Node.js 22 LTS via `winget`
- Installs Git via `winget`
- Installs and starts Ollama
- Downloads your chosen AI model
- Clones the repo and builds
- Configures `.env` interactively
- Optionally creates a Windows Service for auto-start
- Optionally opens firewall port

> **Requirements:** Windows 10 1809+ or Windows 11. Run PowerShell as Administrator for service/firewall features.

### Optional Dependency: `w3m`

`web_navigate` works in two modes:
- **With `w3m` installed:** Real terminal-style page rendering for stronger step-by-step navigation.
- **Without `w3m`:** Automatic HTML fallback with readable text extraction and link discovery.

Ubuntu/Debian users get the best navigation experience because the installer adds `w3m` automatically.

## 🗺️ Roadmap v1.x
- [x] **Model Router**: Intelligent intent-based model selection. ✅
- [ ] **Multimodal Vision**: Native image and screenshot processing.
- [ ] **Autonomous Navigation**: Real-time web exploration with deep interaction.
- [ ] **Python Sandbox**: Secure execution environment for data analysis.
- [ ] **Collaborative Graphs**: Multi-agent memory synchronization.

---

## 📱 CLI Reference

| Command | Description |
|---|---|
| `newclaw start` | Start the agent (foreground) |
| `newclaw start --daemon` | Run in background (VPS mode) |
| `newclaw stop` | Gracefully stop the service |
| `newclaw status` | Show health, PID, and uptime |
| `newclaw logs -f` | Tail execution logs |
| `newclaw update` | Pull latest version and rebuild |

### 🗑️ Uninstall

The uninstaller backs up your data (database, workspace, skills) before removing.

**Linux/macOS:**

```bash
./uninstall.sh                   # Interactive (recommended)
./uninstall.sh --backup-only     # Just create a backup
./uninstall.sh --keep-data       # Remove code, keep data
```

**Windows (PowerShell):**

```powershell
.\uninstall.ps1                  # Interactive (recommended)
.\uninstall.ps1 -BackupOnly      # Just create a backup
.\uninstall.ps1 -KeepData        # Remove code, keep data
```

Backups are saved to `~/newclaw-backups/` with a timestamp.

---
<a name="português"></a>
# 🇧🇷 Versão em Português

# NewClaw Cognitive System v1.0 🪐

### Agente cognitivo autônomo com tool-calling nativo, grafo de memória semântica e fallback multi-provider.

![NewClaw Logo Banner](docs/assets/banner.png)

O NewClaw é um **Agente Cognitivo Avançado** (100% local e privado), desenvolvido em Node.js (TypeScript). Ele é especializado na execução autônoma de tarefas através de chamadas de ferramentas nativas e gerenciamento de memória semântica de longo prazo.

## 🧠 Cognição Atômica: Núcleo de Decisão Unificado

O diferencial do NewClaw é a sua **Arquitetura de Cognição Atômica**. Diferente de agentes tradicionais que seguem uma cadeia lenta e linear de etapas separadas, o NewClaw processa toda a inteligência estratégica em um único turno atômico unificado:

1.  **Raciocínio Unificado**: O agente pensa, decide a ação e avalia sua própria completude em uma única resposta JSON estruturada.
2.  **Eficiência Extrema**: Elimina a latência de múltiplas chamadas LLM sequenciais, resolvendo tarefas em apenas 1 ou 2 ciclos de decisão de alto valor.
3.  **Auto-Avaliação Nativa**: O cálculo de confiança e a validação de objetivos acontecem naturalmente dentro do raciocínio interno do modelo, sem supervisores externos.
4.  **Robusto e Resiliente**: Possui parsing avançado de JSON com recuperação automática de erros de formatação e vazamentos de markdown.
5.  **Limpo e Direto**: Prioriza respostas úteis e baseadas em evidências sobre perfeccionismo estético ou execução excessiva.

Isso garante que o agente **"pense uma vez, mas pense profundo"**, oferecendo autonomia de nível profissional com o mínimo de latência.

## 🚀 O Diferencial NewClaw

O que torna o NewClaw único é o seu foco em **Consistência Cognitiva de Longo Prazo** e **Confiabilidade Estrutural**:

*   🛡️ **Privacidade Local-First**: Seus dados, memórias e modelos permanecem sob seu controle total, sem coleta de dados por terceiros.
*   🗺️ **Modelo de Mundo Evolutivo**: Diferente de bots reativos, o NewClaw constrói um grafo semântico persistente de suas preferências, projetos e infraestrutura.
*   🏗️ **Raciocínio Estrutural Nativo**: O agente não "adivinha" como usar ferramentas via texto; ele utiliza chamadas de função nativas para interagir com o sistema com precisão cirúrgica.
*   🔄 **Resiliência Extrema**: Com uma cadeia de fallback multi-provider e roteamento inteligente, o sistema garante continuidade mesmo se um provedor ou modelo falhar.
*   🎓 **Auto-Otimização de Skills**: O agente observa padrões em sua própria execução e propõe novas habilidades reutilizáveis para se tornar mais eficiente com o tempo.

### 🔄 Ciclo de Aprendizado
O NewClaw não apenas armazena dados; ele evolui. O sistema segue um loop contínuo de otimização:
```mermaid
graph LR
    A["👁️ Observe"] --> B["🧠 Learn"]
    B --> C["💡 Propose"]
    C --> D["✅ Approve"]
    D --> E["🚀 Apply"]
```
*Observar padrões → Aprender interações → Propor skills → Aprovação do usuário → Aplicar no futuro.*

## ⚙️ Modos de Operação
O agente atua em quatro modos distintos dependendo da complexidade da tarefa:
1.  💬 **Responder**: Conversa natural e raciocínio usando contexto de longo prazo.
2.  🔍 **Buscar**: Síntese multi-fonte e pesquisa baseada em evidências.
3.  🧭 **Explorar**: Navegação web ativa e interação profunda com páginas.
4.  ⚡ **Executar**: Comandos diretos no sistema e operações de arquivo precisas.

## ✨ Funcionalidades

| Feature | Descrição |
|---------|-----------|
| 🧠 **Memória Semântica** | SQLite + FTS5 + embeddings, 7 tipos de nó, 14+ relações e curadoria avançada (mesclagem/deleção). |
| 📞 **Tool Calling Nativo** | Chamada estrutural (Ollama/Gemini) para precisão absoluta sem parsing de texto. |
| 🧭 **Model Router** | Roteamento inteligente para modelos especializados (Chat, Code, Vision, Analysis). |
| 🔄 **Provider Fallback** | Resiliência multi-provider: Ollama → Gemini → DeepSeek → Groq. |
| 🎓 **SkillLearner** | Reconhecimento de padrões que alimenta o **Ciclo de Aprendizado**. |
| 🌐 **Busca Web** | Pesquisa iterativa multi-fonte com síntese e leitura de páginas. |
| 🧭 **Exploração Ativa** | **Camada de Exploração**: Navegação web em modo terminal para interação profunda (suporte a `w3m`). |
| 📊 **Dashboard Web** | Chat em tempo real, config, curadoria de memória e grafo interativo. |
| 📱 **Interface Telegram** | Controle total, áudio (Whisper/Edge-TTS) e revisão de skills em linguagem natural. |
| 📸 **Snapshots** | Versionamento do grafo: criar, restaurar, listar e deletar snapshots. |

## 🏗️ Arquitetura

### Message Flow

```mermaid
flowchart LR
    U["👤 Usuário"] --> T["📨 Telegram Bot"]
    T --> A["🧠 AgentLoop"]

    subgraph AgentLoop
        A1["🗜️ ContextCompressor"]
        A2["📝 Montagem de Prompt"]
        A3["🤖 LLM — Tool Calling"]
        A4["🎓 SkillLearner"]
        A1 --> A2 --> A3 --> A4
    end

    A3 -->|"tool_calls"| S["🛠️ Ferramentas"]
    A3 -->|"resposta"| U

    subgraph Tools
        S1["🌐 web_search"]
        S2["🧠 memory_search"]
        S3["✏️ memory_write"]
        S4["🔊 send_audio"]
        S5["⚡ exec_command"]
        S6["📄 file_ops"]
    end

    S --> S1
    S --> S2
    S --> S3
    S --> S4
    S --> S5
    S --> S6
    S -->|"resultado"| A3

    A <--> M["💾 Memória — SQLite"]
    A <--> D["🖥️ Dashboard"]
```

### Fluxo de Chamada de Ferramentas (Tool Calling)

```mermaid
flowchart TD
    A["Usuário envia mensagem"] --> B["ContextCompressor"]
    B --> C["Montagem de Prompt — ALMA + USUÁRIO + MEMÓRIA"]
    C --> D["LLM recebe mensagem + definições de ferramentas"]
    D --> E{"LLM decide"}
    E -->|"Resposta direta"| F["Formatar e enviar ao usuário"]
    E -->|"Uso de ferramenta"| G["Executar ferramenta"]
    G --> H["Resultado → volta para o LLM"]
    H --> D
    F --> I["✅ Usuário recebe resposta natural"]
```

### Cadeia de Fallback de Provedores

```mermaid
flowchart LR
    A["🤖 Requisição LLM"] --> B{"Ollama"}
    B -->|"✅ Sucesso"| Z["Resposta"]
    B -->|"❌ Falha"| C{"Gemini"}
    C -->|"✅ Sucesso"| Z
    C -->|"❌ Falha"| D{"DeepSeek"}
    D -->|"✅ Sucesso"| Z
    D -->|"❌ Falha"| E{"Groq"}
    E -->|"✅ Sucesso"| Z
    E -->|"❌ Falha"| F["⚠️ Todos falharam"]
```

### Model Router — Roteamento Inteligente de Modelos

```mermaid
flowchart TD
    A["👤 Mensagem do usuário"] --> B["🧭 ModelRouter"]
    B --> C["🤖 Classificador LLM"]
    C --> D{"Categoria?"}
    D -->|"💬 chat"| M1["glm-5.1:cloud"]
    D -->|"💻 code"| M2["gemma4:31b-cloud"]
    D -->|"👁️ vision"| M3["gemma4:31b-cloud"]
    D -->|"⚡ light"| M4["glm-5.1:cloud"]
    D -->|"📊 analysis"| M5["glm-5:cloud"]
    C -->|"❌ Fallback"| M1
    M1 --> E["🧠 AgentLoop com modelo selecionado"]
    M2 --> E
    M3 --> E
    M4 --> E
    M5 --> E
    E -->|"❌ Erro"| F["🔄 Auto-fallback para próximo modelo"]
    F --> E
```

O ModelRouter usa um LLM leve para classificar cada mensagem em 5 categorias e selecionar o melhor modelo para a tarefa. Se o classificador falhar, usa busca por palavras-chave. Em caso de erro no modelo selecionado, ele tenta automaticamente o próximo da lista de fallback.

| Categoria | Caso de Uso | Modelo Recomendado |
|----------|----------|-------|
| 💬 **chat** | Conversa geral, raciocínio | `glm-5.1:cloud` |
| 💻 **code** | Programação, edição de arquivos, scripts | `gemma4:31b-cloud` |
| 👁️ **vision** | Análise de imagens, OCR, screenshots | `gemma4:31b-cloud` |
| ⚡ **light** | Respostas curtas (oi, ok, valeu) | `glm-5.1:cloud` |
| 📊 **analysis** | Cripto, dados de mercado, estatísticas | `glm-5:cloud` |
| 🧠 **execution** | Loop de ferramentas / Tarefas complexas | `kimi-k2.6:cloud` |

### Grafo de Memória Semântica

```mermaid
flowchart TD
    U["👤 core_user"] -->|"prefers"| P1["📊 pref_crypto"]
    U -->|"works_on"| P2["💻 proj_newclaw"]
    U -->|"runs_on"| I1["🖥️ infra_venus"]

    P2 -->|"uses"| S1["🧠 semantic_search"]
    P2 -->|"depends_on"| I2["🗄️ infra_timescaledb"]

    style U fill:#00d4aa,color:#000
    style P1 fill:#a78bfa,color:#000
    style P2 fill:#38bdf8,color:#000
    style I1 fill:#fb923c,color:#000
    style I2 fill:#fb923c,color:#000
    style S1 fill:#f472b6,color:#000
```

**7 Tipos de Nó:** identity, preference, project, skill, context, fact, infrastructure.

**14+ Tipos de Relação:** prefers, works_on, runs_on, uses, depends_on, contains, references, related_to, belongs_to, owns, created, reads, writes, hosts (com links inversos automáticos).

## 🚀 Instalação

### Fluxo de Instalação

```mermaid
flowchart TD
    A["📦 Run install.sh / install.ps1"] --> B["✅ Verificar Sistema"]
    B --> C["🔄 Instalar Dependências"]
    C --> D["🟢 Instalar Node.js 22"]
    D --> E["🤖 Instalar Ollama"]
    E --> F{"Escolher Modelo"}
    F -->|"1"| G1["glm-5:cloud — Recomendado"]
    F -->|"2"| G2["llama3.1:8b — Rápido"]
    F -->|"3"| G3["mistral:7b — Conversação"]
    F -->|"4"| G4["qwen2.5:3b — Leve"]
    G1 --> H["📥 git clone + npm install + build"]
    G2 --> H
    G3 --> H
    G4 --> H
    I --> I["🔑 Configurar Token + ID do Telegram"]
    I --> J["▶️ newclaw start --daemon"]
    J --> K{"Opcional"}
    K -->|"Linux"| L1["🐧 systemd + firewall"]
    K -->|"Windows"| L2["🪟 Windows Service + firewall"]
    K -->|"Não"| M["🪐 Pronto!"]
    L1 --> M
    L2 --> M

    style A fill:#38bdf8,color:#000
    style I fill:#f472b6,color:#000
    style M fill:#00d4aa,color:#000
```

### Instalação Rápida — Linux/macOS (Recomendado)

```bash
curl -fsSL https://raw.githubusercontent.com/rovanni/NewClaw/main/install.sh | bash
```

### Instalação Rápida — Windows 🪟

**Execute o PowerShell como Administrador:**

```powershell
irm https://raw.githubusercontent.com/rovanni/NewClaw/main/install.ps1 | iex
```

**Opções PowerShell:**

```powershell
# Com credenciais pré-definidas
.\install.ps1 -Token "SEU_TOKEN" -UserId "SEU_ID" -NoPrompt

# Dry run (simular sem executar)
.\install.ps1 -DryRun

# Modelo específico
.\install.ps1 -Model "llama3.1:8b"
```

> **Requisitos Windows:** Windows 10 1809+ ou Windows 11. Execute como Administrador para criar serviço e configurar firewall.

### Comandos CLI

| Comando | Descrição |
|---|---|
| `newclaw start` | Inicia o agente |
| `newclaw start --daemon` | Execução em segundo plano (VPS) |
| `newclaw stop` | Encerra o serviço graciosamente |
| `newclaw status` | Health check e uptime |
| `newclaw logs -f` | Logs em tempo real |
| `newclaw update` | Atualiza e recompila o projeto |

### 🗑️ Desinstalação

O desinstalador faz backup dos seus dados (banco, workspace, skills) antes de remover.

**Linux/macOS:**

```bash
./uninstall.sh                   # Interativo (recomendado)
./uninstall.sh --backup-only     # Apenas criar backup
./uninstall.sh --keep-data       # Remover código, manter dados
```

**Windows (PowerShell):**

```powershell
.\uninstall.ps1                  # Interativo (recomendado)
.\uninstall.ps1 -BackupOnly      # Apenas criar backup
.\uninstall.ps1 -KeepData        # Remover código, manter dados
```

Backups são salvos em `~/newclaw-backups/` com timestamp.

---

## 🗺️ Roadmap v1.x
- [x] **Model Router**: Roteamento inteligente de modelos. ✅
- [ ] **Visão Multimodal**: Processamento nativo de imagens.
- [ ] **Navegação Autônoma**: Exploração web em tempo real.
- [ ] **Python Sandbox**: Execução segura para análise de dados.
- [ ] **Grafos Colaborativos**: Sincronização de memória multi-agente.

---

## 📄 Licença

Este projeto está sob a licença MIT.

---

*NewClaw — The Future of Local Cognitive Agents* 🪐

[⬆️ Back to top / Voltar ao topo](#NewClaw)
