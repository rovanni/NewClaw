# NewClaw 🪐

> **Language / Idioma:**
> 🇺🇸 **English** | 🇧🇷 [Português](README.pt-br.md) | 🇪🇸 [Español](README.es.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D%2022-green.svg)](https://nodejs.org/)
[![Platform](https://img.shields.io/badge/platform-Linux%20%7C%20Windows%20%7C%20macOS-blue.svg)](https://github.com/rovanni/NewClaw)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/rovanni/NewClaw/pulls)


> **Security:** [Security Policy](SECURITY.md) — how to report a vulnerability privately.
>
> **Technical docs:** [Technical Overview](docs/TECHNICAL_OVERVIEW.md) — architecture, the goal-driven
> execution engine, the groundedness barrier, memory internals, and how model routing (including
> fully offline `.gguf`/llamafile support) actually works under the hood.

---

> **You:** "My daughter loves math."
>
> *Two days later:*
>
> **You:** "What do you know about my family?"
> **NewClaw:** "Your daughter loves math."
>
> *No fine-tuning. No injected context. No repeating yourself.*

---

## The AI assistant that actually remembers you

Every AI assistant today forgets you the moment the session ends. You repeat yourself constantly. The context you built last week is gone. The AI never grows into knowing who you are.

**NewClaw is different.**

It runs locally on your machine, builds a persistent memory of who you are, and stays with you across Telegram, WhatsApp, and Discord — even after weeks or months. Same agent. Same memory. Always.

---

## See it in action

### Memory that persists across time

```
You: "I'm working on a project called Orion — it's a customer management system."
NewClaw: "Got it. I've added Orion to your known projects."

[One week later]

You: "What projects am I working on?"
NewClaw: "You have Orion — a customer management system you mentioned last week."
```

### Context that shapes future responses

```
You: "I really dislike meetings before 10am."

[Later that week]

You: "Schedule a team meeting for tomorrow."
NewClaw: "I'll suggest times after 10am, since you prefer that."
```

### The same agent, everywhere

You send a voice note on Telegram in the morning. Later you open the web dashboard. Tonight you reply on Discord. It's the same NewClaw — with the same memory and the same context — every time.

---

![NewClaw Memory Graph](docs/assets/newclaw-graph-2x.png)
*Real memory graph — 65 nodes, 167 edges. Labels removed for privacy.*

---

## Quick Install

**Linux/macOS:**
```bash
curl -fsSL https://raw.githubusercontent.com/rovanni/NewClaw/main/install.sh | bash
```

**Windows (PowerShell as Administrator):**
```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/rovanni/NewClaw/main/install.ps1).TrimStart([char]0xFEFF)))
```

### Requirements

- Windows 10 (1809+) / Windows 11, or Linux/macOS
- Node.js 22.22.2+ or 24.15.0+ (the installer installs it for you if missing)
- npm (any recent version; with npm 12.2+ the project's install-script allowlist is also enforced)
- The local Cognitive Kernel adapter is optional; for development with the sibling repository and its dependencies installed, link it with `node scripts/link-local-kernel-adapter.cjs`
- 2GB+ RAM, 5GB+ free disk space
- No chat channel is required to get started — NewClaw runs standalone through the local
  Web Dashboard (`http://localhost:3090`). Add Telegram, Discord, WhatsApp or Signal later
  anytime with `newclaw channels enable <channel>`.

### Installation troubleshooting

- **Windows — "cannot be loaded because running scripts is disabled on this system"**: this
  only happens if you downloaded the file and ran `.\install.ps1` directly instead of the
  `irm | iex` one-liner above (which isn't affected by this restriction). Fix it once with:
  ```powershell
  Set-ExecutionPolicy RemoteSigned -Scope CurrentUser
  ```
  This only affects your own user account, not the whole machine, and also prevents the same
  block from hitting `npm` commands later. The installer checks and fixes this automatically
  when it can run.
- **Windows — PM2 fails to connect / the bot doesn't stay running**: usually a leftover PM2
  daemon started under a different privilege level (`EPERM` on the named pipe). Run
  `newclaw doctor` for a full diagnosis, or fall back to `npm start` (no auto-restart, but works).
- **`newclaw update` fails to compile (TypeScript error about a missing module)**: `npm ci`
  is run automatically on every update, so this should be rare — but if it happens (e.g. a
  flaky network mid-install, or a native dependency that failed to build), fix it by hand:
  ```bash
  cd <your NewClaw install folder>
  npm ci
  npm run build
  newclaw restart --daemon
  ```
- **Anytime**: run `newclaw doctor` to check Node, PM2, Ollama, configured channels, disk space,
  and Windows auto-start in one pass.

---

## How NewClaw compares

| Every other assistant | NewClaw |
|---|---|
| Forgets everything after each session | Persistent memory — remembers across days, weeks, months |
| Your data lives on someone else's servers | Local-first — with a local model nothing leaves your machine; with a cloud model, requests go only to the provider you chose |
| One interface (usually just a chat window) | Telegram, WhatsApp, Discord, Signal, Web — one agent |
| Starts from zero every conversation | Builds a world model of you that evolves over time |
| Requires expensive API subscriptions | Runs on the model you choose — local (Ollama, `.gguf`) or cloud — and never swaps it for another behind your back |

---

## What you can do with it

- **Ask anything about your history** — preferences, decisions, projects, people you've mentioned
- **Use any channel** — Telegram, WhatsApp, Discord, web dashboard, or all at once
- **Keep your data private** — with a local model everything stays on your machine; cloud only if you choose it
- **Let it learn your patterns** — it creates shortcuts (skills) based on how you actually work, and tells you when it does
- **Run it on your server** — persistent background service, SSH support, multi-instance

---

## Features

| Feature | What it does for you |
|---|---|
| 🧠 **Semantic Memory** | Remembers people, preferences, projects, facts — and the connections between them |
| 🔀 **Multi-Channel** | Telegram, Discord, WhatsApp, Signal, Web — one agent across all channels |
| 🛡️ **Local-First** | No cloud required. No data harvesting. Runs entirely on your hardware |
| 🎓 **Skill Learning** | Observes how you work and creates reusable shortcuts; tells you about each new skill (`/skills` lists them, `/skill_desativar` turns one off) |
| 🎯 **Only the model you chose** | Ollama (local or cloud), `.gguf`/llamafile, Gemini, DeepSeek, Groq, OpenRouter, Anthropic or any OpenAI-compatible endpoint. No automatic swap: if the chosen one fails, NewClaw tells you what it answered |
| 🎯 **Checked goals** | Multi-step requests become a planned goal; what an answer states as tool data is checked against what the tools actually returned |
| 🔐 **Secret vault** | A password sent with a label (`password: …`) or with `/segredo <name> <value>` is removed from the message and stored in the vault — it never reaches logs, history or the models (`/segredos` lists, `/segredo_apagar` removes) |
| 💾 **Knowledge backup** | Saves what NewClaw has learned to a `.zip`, restores it, or merges it with another installation (`newclaw backup`, `restore`, `import`) |
| 📊 **Web Dashboard** | Visual memory graph, real-time chat, full configuration interface — see below |
| 🌐 **Web Search** | Researches topics and synthesizes answers from multiple sources |
| 🖥️ **SSH Exec** | Run commands on remote servers directly from your chat |
| 📸 **Memory Snapshots** | Version your agent's knowledge — create, restore, and compare states |
| 🛡️ **Self-Audit** | The agent inspects and fixes its own runtime using `/audit` |

---

![NewClaw Dashboard](docs/assets/dashboard-graph.png)
*Web Dashboard — interactive graph visualization with node types: Identity, Preference, Project, Context, Fact, Skill.*

---

## CLI Reference

| Command | Description |
|---|---|
| `newclaw start` | Start the agent (`--daemon` runs it in the background, ideal for a VPS) |
| `newclaw stop` / `newclaw restart` | Stop / restart the service |
| `newclaw status` | Show health, PID, uptime and settings |
| `newclaw logs -f` | Tail execution logs |
| `newclaw doctor` | Full diagnosis: Node, PM2, Ollama, channels, disk |
| `newclaw repair` | Fix auto-start on Windows (Scheduled Task) |
| `newclaw update` | Pull the latest code from GitHub and rebuild (`update restart` also restarts; `update channel` picks Stable/Preview/Development) |
| `newclaw passwd` | Set or change the Dashboard password |
| `newclaw onboard` | Configure providers and API keys |
| `newclaw lang` | Show the configured language (change it in the Dashboard) |
| `newclaw channels` | Show channel status (Telegram, Discord, WhatsApp, Signal) |
| `newclaw channels enable <name>` / `disable <name>` | Enable / disable a channel |
| `newclaw backup` | Save what NewClaw has learned to a `.zip` (options: `--historico`, `--workspace`, `--segredos`) |
| `newclaw restore [file.zip]` | Restore knowledge from a backup (without a file, opens the wizard) |
| `newclaw import <file.zip>` | Merge knowledge from another installation, deleting nothing |
| `newclaw uninstall` | Remove NewClaw and clean up the system |
| `newclaw help` | List every command |

---

## Self-Diagnosis Auditor

NewClaw can inspect its own code and runtime behavior using the local LLM.

> **Owner-only.** Works on any channel (Telegram, Discord, etc.).

| Command | Description | Time |
|---|---|---|
| `/audit` | Full audit — code, runtime, data, integrations | ~1-3 min |
| `/audit fix` | Auto-fix pipeline — applies only low-risk, validated fixes | ~1-5 min |
| `/cancel` | Cancel the current operation (`/cancelar`, `/stop`, `/pare` also work) | instant |

---

<details>
<summary>⚙️ How it works internally</summary>

### Message Flow

```mermaid
flowchart LR
    U["👤 Users"] --> C["🌐 Channel Adapters"]
    C --> B["🚌 MessageBus"]
    B --> R["🧭 Intent router"]
    R -->|"chat / tool"| A["🧠 AgentLoop"]
    R -->|"multi-step"| G["🎯 GoalOrchestrator"]
    G -->|"each step"| A
    A --> J["⚖️ Validation judges"]
    J -->|"checked answer"| B

    subgraph Adapters
        T["Telegram"]
        D["Discord"]
        W["WhatsApp"]
        S["Signal"]
        WB["Web Dashboard"]
    end

    T --> C
    D --> C
    W --> C
    S --> C
    WB --> C

    subgraph AgentLoop
        A1["🗜️ ContextCompressor"]
        A2["📝 Prompt Assembly"]
        A3["🤖 LLM — Tool Calling"]
        A4["🎓 SkillLearner"]
        A1 --> A2 --> A3 --> A4
    end

    A3 -->|"tool_calls"| S2["🛠️ Tools"]
    B --> C
    C --> U
```

For the full architectural philosophy behind this (why channels never touch AI logic, what's
forbidden to import where, how to add a new channel), see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

### Session System (v2)

| Component | Purpose |
|---|---|
| **SessionTranscript** | JSONL append-only log, every event recorded with sequence number and metadata |
| **SessionManager** | Mutex per session, hybrid compression (10 msgs OR 2500 tokens) |
| **SessionContext** | Builds LLM context: system prompt → checkpoint → recent messages → semantic memory |
| **SessionLearner** | Extracts facts from conversations into the cognitive graph |

### Operation Modes

An intent router (LLM) decides, for each message, how it is handled:

1. 💬 **Direct** — natural conversation using long-term context, no tools
2. 🛠️ **Tool** — a single action (web search, memory, command, file)
3. 🗺️ **Planned** — several tools in sequence within the same answer
4. 🎯 **Goal** — a multi-step task: the `GoalOrchestrator` plans, executes, checks each step and replans when something fails

</details>

---

## Roadmap

Detailed roadmap in [docs/ROADMAP.md](docs/ROADMAP.md).

## License

MIT — [opensource.org/licenses/MIT](https://opensource.org/licenses/MIT)

---

*NewClaw — The AI that remembers you.* 🪐
