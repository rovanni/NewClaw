# NewClaw Roadmap 🪐

This document outlines the strategic development path for NewClaw.

## ✅ Shipped

Major capabilities already implemented and in daily use — not tracked as "in progress" anymore:

| Area | What exists |
| :--- | :--- |
| **Multi-channel** | Telegram, Discord, WhatsApp, Signal, and a full Web Dashboard — all through a single Core (`MessageBus` → `GoalOrchestrator`/`AgentLoop`). |
| **Goal-based execution** | Multi-step autonomous goals with planning, risk review, semantic step validation, and post-generation grounding against real tool evidence (`GoalPlanner`, `RiskAnalyzer`, `StepSemanticValidator`, `ObserverValidator`). |
| **Model Router** | Intent-based model selection per category (chat/code/vision/analysis/execution), with automatic multi-provider fallback and circuit breakers. |
| **Multimodal Vision** | Image/screenshot analysis and OCR reach every provider that supports it (OpenAI-compatible, Gemini, Anthropic), including local/self-hosted models. |
| **Autonomous Web Navigation** | Real browsing and page interaction via `web_navigate`, not just search. |
| **Local model hosting** | Load, serve, and manage local GGUF models (llama.cpp/llamafile) from the Dashboard — including a guided setup wizard. |
| **Cognitive memory** | Long-term memory graph with confidence decay, conflict detection/resolution, reflection on past failures, and case-based reasoning (`MemoryGovernor`, `ReflectionMemory`, `CaseMemory`, `OperationalKnowledge`). |
| **Skills system** | Install, audit, and dynamically activate third-party skills at runtime, with static security auditing before activation. |
| **Security hardening** | Ongoing dedicated effort — SSRF, path traversal, command injection, XSS, CSRF, and dependency-vulnerability fixes, each with a regression test tied to the incident. |

## 🗺️ Roadmap v1.x (Current Phase)

| Feature | Status | Description |
| :--- | :---: | :--- |
| **Collaborative Graphs** | ⏳ | Multi-agent memory synchronization — today's memory graph is per-instance, not shared/synced across agents. |

Dropped from the roadmap: a dedicated **Python Sandbox**. NewClaw's own runtime is TypeScript/Node — a secure, isolated Python execution environment would be a substantial cross-language subsystem, not a natural extension of the stack. Python already runs today via the general shell tool (`exec_command`, unsandboxed) when a task needs it; that's the accepted way this gets done, not a placeholder for a future dedicated sandbox.

---

## 🇧🇷 Versão em Português

### ✅ Já entregue

| Área | O que existe |
| :--- | :--- |
| **Multi-canal** | Telegram, Discord, WhatsApp, Signal e um Dashboard web completo — todos passando pelo mesmo Core (`MessageBus` → `GoalOrchestrator`/`AgentLoop`). |
| **Execução por objetivos** | Goals autônomos de múltiplos passos, com planejamento, revisão de risco, validação semântica de step e verificação pós-geração contra evidência real de ferramenta. |
| **Model Router** | Seleção de modelo por categoria (chat/código/visão/análise/execução), com fallback automático entre múltiplos providers e circuit breakers. |
| **Visão Multimodal** | Análise de imagem/screenshot e OCR chegam a qualquer provider compatível (OpenAI-Compatible, Gemini, Anthropic), incluindo modelos locais. |
| **Navegação Web Autônoma** | Navegação e interação real com páginas via `web_navigate`, não só busca. |
| **Hospedagem de modelo local** | Carregar, servir e gerenciar modelos GGUF locais (llama.cpp/llamafile) pelo Dashboard — com assistente de configuração guiado. |
| **Memória cognitiva** | Grafo de memória de longo prazo com decaimento de confiança, detecção/resolução de conflitos, reflexão sobre falhas passadas e raciocínio baseado em casos. |
| **Sistema de skills** | Instalar, auditar e ativar skills de terceiros em runtime, com auditoria estática de segurança antes da ativação. |
| **Reforço de segurança** | Esforço contínuo e dedicado — correções de SSRF, path traversal, injeção de comando, XSS, CSRF e dependências vulneráveis, cada uma com teste de regressão amarrado ao incidente. |

### Fase atual (v1.x)

| Funcionalidade | Status | Descrição |
| :--- | :---: | :--- |
| **Grafos Colaborativos** | ⏳ | Sincronização de memória entre múltiplos agentes — hoje o grafo de memória é por instância, não compartilhado/sincronizado. |

Tirado do roadmap: um **Python Sandbox** dedicado. O runtime do próprio NewClaw é TypeScript/Node — um ambiente Python isolado e seguro seria um subsistema cross-language substancial, não uma extensão natural da stack. Python já roda hoje via a ferramenta de shell geral (`exec_command`, sem isolamento) quando a tarefa precisa; é assim que isso é resolvido, não um placeholder pra um sandbox dedicado futuro.

---

## 🇪🇸 Versión en Español

### ✅ Ya entregado

| Área | Qué existe |
| :--- | :--- |
| **Multi-canal** | Telegram, Discord, WhatsApp, Signal y un Dashboard web completo — todos a través del mismo Core (`MessageBus` → `GoalOrchestrator`/`AgentLoop`). |
| **Ejecución por objetivos** | Goals autónomos de múltiples pasos, con planificación, revisión de riesgo, validación semántica de cada paso y verificación posterior a la generación contra evidencia real de herramientas. |
| **Model Router** | Selección de modelo por categoría (chat/código/visión/análisis/ejecución), con fallback automático entre múltiples providers y circuit breakers. |
| **Visión Multimodal** | Análisis de imagen/captura y OCR llegan a cualquier provider compatible (OpenAI-Compatible, Gemini, Anthropic), incluyendo modelos locales. |
| **Navegación Web Autónoma** | Navegación e interacción real con páginas vía `web_navigate`, no solo búsqueda. |
| **Alojamiento de modelo local** | Cargar, servir y gestionar modelos GGUF locales (llama.cpp/llamafile) desde el Dashboard — con asistente de configuración guiado. |
| **Memoria cognitiva** | Grafo de memoria a largo plazo con decaimiento de confianza, detección/resolución de conflictos, reflexión sobre fallos pasados y razonamiento basado en casos. |
| **Sistema de skills** | Instalar, auditar y activar skills de terceros en tiempo de ejecución, con auditoría estática de seguridad antes de activar. |
| **Refuerzo de seguridad** | Esfuerzo continuo y dedicado — correcciones de SSRF, path traversal, inyección de comandos, XSS, CSRF y dependencias vulnerables, cada una con test de regresión ligado al incidente. |

### Fase actual (v1.x)

| Funcionalidad | Estado | Descripción |
| :--- | :---: | :--- |
| **Gráficos Colaborativos** | ⏳ | Sincronización de memoria entre múltiples agentes — hoy el grafo de memoria es por instancia, no compartido/sincronizado. |

Eliminado del roadmap: un **Python Sandbox** dedicado. El runtime del propio NewClaw es TypeScript/Node — un entorno Python aislado y seguro sería un subsistema cross-language sustancial, no una extensión natural de la stack. Python ya corre hoy vía la herramienta de shell general (`exec_command`, sin aislamiento) cuando la tarea lo necesita; así es como esto se resuelve, no un placeholder para un sandbox dedicado futuro.

---

## 📈 Long-Term Vision (v2.x and beyond)
- [x] **Self-Repairing Loops**: Automatic retry with backoff, argument mutation, and tool fallback chains before ever exposing a failure to the LLM (`ProactiveRecovery`) — live today; still open: strategy adaptation that *learns* across goals, not just recovers within one.
- [ ] **Native Mobile App**: Dedicated mobile interface beyond Telegram.
- [ ] **Decentralized Knowledge**: P2P graph synchronization.
- [ ] **Hardware Integration**: Controlling local devices and smart home infra.
