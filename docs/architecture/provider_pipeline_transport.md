# Arquitetura de Transporte: Tool Layer para Providers

Este documento normatiza a arquitetura e o fluxo de transporte de dados no NewClaw, cobrindo o ciclo completo desde a execução de ferramentas físicas até o empacotamento HTTP e comunicação com os provedores de Modelos de Linguagem (LLMs).

---

## 1. Visão Geral

O pipeline de transporte de dados do NewClaw segue um fluxo linear e unidirecional em camadas:

```
Tool Layer (Execução Física)
  ↓ [ToolResult]
AgentLoop (Decisor Cognitivo / FSM)
  ↓ [LLMMessage[]]
ProviderFactory (Resolução de Modelos & Fallback)
  ↓ [LLMMessage[] + ToolDefinition[]]
LLM Provider (Serialização e Adaptação)
  ↓ [Payload HTTP (JSON)]
API Externa / LLM (Inferência)
```

Este pipeline garante o isolamento entre o ambiente operacional onde as ferramentas rodam e a lógica cognitiva do LLM.

---

## 2. Responsabilidades e Autoridades

Cada camada no pipeline possui autoridade estrita e exclusiva sobre determinados tipos de informação:

*   **Tool Layer (Autoridade de Execução)**: É a autoridade única sobre a execução física no sistema operacional (processos, escrita de arquivos, comandos bash). Ela produz o `ToolResult` contendo o resultado bruto (stdout, stderr, exitCode).
*   **AgentLoop (Autoridade Cognitiva e FSM)**: Controla a máquina de estados (FSM) do agente. É a única camada que recebe o `ToolResult` rico e decide o próximo passo com base nele. Ela converte o resultado em uma representação textual simplificada (`content`) para alimentar o histórico de conversação do LLM, descartando metadados de execução física desnecessários para a cognição.
*   **ProviderFactory (Autoridade de Resolução e Resiliência)**: Resolve qual provedor e modelo usar com base nas configurações e regras de fallback. É transparente em termos de conteúdo das mensagens.
*   **LLM Provider (Autoridade de Protocolo)**: Traduz o formato padronizado de mensagens do NewClaw (`LLMMessage`) para o dialeto e esquema de payload específico da API do modelo (OpenAI, Gemini, Anthropic, Ollama, etc.).
*   **LLM (Autoridade de Inferência)**: Interpreta o histórico de chat fornecido e gera a resposta em linguagem natural ou uma nova requisição de ferramenta (`toolCalls`). Nunca possui autoridade sobre a execução física direta do sistema.

---

## 3. Fluxo do ToolResult

O ciclo de vida de uma execução e transporte de resultado segue as seguintes etapas estruturais:

1.  **Geração (`ToolResult`)**: A ferramenta conclui sua execução física e a Tool Layer gera um objeto `ToolResult` estruturado.
2.  **Filtro (`AgentLoop`)**: O `AgentLoop` intercepta o `ToolResult`. Ele salva metadados de execução para fins de rastreabilidade interna, mas constrói um `LLMMessage` de role `tool` contendo apenas:
    *   `content`: O texto bruto da saída (`output`) da ferramenta.
    *   `tool_call_id`: O identificador da chamada da ferramenta.
    Os metadados físicos (`stdout`, `stderr`, `exitCode`, `artifactPaths`, `success`, `error`) são propositalmente omitidos do prompt do LLM para evitar poluição do contexto de inferência.
3.  **Encaminhamento (`ProviderFactory`)**: O array de mensagens acumulado é enviado à factory, mantendo a integridade da conversação.
4.  **Serialização (`Provider`)**: A classe do provedor selecionado mapeia as mensagens. Se for um provedor compatível com OpenAI, as mensagens de tipo `tool` contendo `tool_call_id` são enviadas no formato nativo. Se for um provedor como o `GeminiProvider` ou `AnthropicProvider`, a estrutura é convertida para seus formatos proprietários de blocos de resultado de ferramentas.
5.  **Envio (`Payload HTTP`)**: O corpo da requisição HTTP (JSON) é transmitido à API externa.

---

## 4. Transformações e Perdas de Informações

Durante a transição entre camadas, certas propriedades são preservadas, transformadas ou descartadas. Abaixo, distinguimos o motivo de cada ação:

### A. Preservadas
*   `role` e `content`: Preservados em todas as camadas (Decisão do NewClaw).

### B. Transformadas
*   `toolCalls` e `tool_call_id`: 
    *   *Anthropic*: Transformados em blocos estruturados de mensagens do tipo `tool_use` (assistant) e `tool_result` (user) exigidos pela Messages API da Anthropic.
    *   *Gemini*: Transformados em instâncias de `FunctionCall` e `FunctionResponse` no esquema do SDK da Google.

### C. Perdidas / Descartadas
1.  **Metadados do ToolResult (`stdout`, `stderr`, `exitCode`, `success`, `error`, `artifactPaths`, `metadata`)**:
    *   *Onde ocorre:* Na transição `ToolResult` → `AgentLoop`.
    *   *Justificativa:* Decisão arquitetural do NewClaw para manter o contexto de tokens do LLM focado apenas no output útil, evitando sobrecarga de tokens com saídas duplicadas ou códigos de saída técnicos que o modelo não precisa processar.
2.  **Imagens (`images`) em Gemini e Anthropic**:
    *   *Onde ocorre:* Na transição `LLMMessage` → `HTTP Payload` do respectivo Provider.
    *   *Justificativa:* Limitação conhecida da nossa implementação atual dos serializadores do `GeminiProvider` e `AnthropicProvider`, que descartam o array de imagens brutas em mensagens do tipo `user`.
3.  **Chamadas e IDs de Ferramentas (`toolCalls`, `tool_call_id`) no Gemini e Ollama-stream**:
    *   *Onde ocorre:* Na transição `LLMMessage` → `HTTP Payload`.
    *   *Justificativa:* Limitação de API do Provider/SDK. O Gemini e o Ollama (em modo stream) não aceitam a passagem transparente de históricos ricos de ferramentas no formato OpenAI, exigindo tratamento especial de estados que é descartado em nossa serialização padrão.

---

## 5. Definição de Contratos

Os contratos de dados entre as camadas do NewClaw são definidos pelas seguintes interfaces TypeScript:

### Contrato de Execução (`ToolResult`)
```typescript
interface ToolResult {
    success: boolean;
    output: string;
    error?: string;
    stdout?: string;
    stderr?: string;
    exitCode?: number;
    artifactPaths?: string[];
    metadata?: Record<string, any>;
}
```

### Contrato do Pipeline de Mensagens (`LLMMessage`)
```typescript
interface LLMMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
    images?: string[]; // Base64 ou caminhos locais
    toolCalls?: ToolCall[]; // Presente em role 'assistant'
    tool_call_id?: string; // Presente em role 'tool'
}

interface ToolCall {
    id: string;
    name: string;
    arguments: Record<string, any>;
}
```

### Contrato de Provedor (`ILLMProvider`)
Cada provider implementado deve satisfazer a interface `ILLMProvider` exposta em `src/core/providerTypes.ts`, implementando o método `chat(messages: LLMMessage[], tools?: ToolDefinition[]): Promise<ProviderResponse>`.

---

## 6. Comportamento e Capacidades dos Providers

Com base na infraestrutura de testes desenvolvida, mapeia-se o seguinte comportamento esperado dos provedores:

| Provedor | Nome Técnico | Preserva Imagens | Preserva Tool Calls / IDs | Comportamento Esperado nos Testes |
| :--- | :--- | :---: | :---: | :--- |
| **OpenAI** | `openai` | ✓ | ✓ | Preservação integral canônica de payloads e hashes. |
| **DeepSeek** | `deepseek` | ✓ | ✓ | Compatibilidade integral 1-para-1 com o padrão OpenAI. |
| **Groq** | `groq` | ✓ | ✓ | Compatibilidade integral 1-para-1 com o padrão OpenAI. |
| **OpenRouter** | `openrouter` | ✓ | ✓ | Compatibilidade integral 1-para-1 com o padrão OpenAI. |
| **Ollama (Non-Stream)** | `ollama_nonstream` | ✓ | ✓ | Mantém a fidelidade completa das chaves de ferramentas. |
| **Ollama (Stream)** | `ollama_stream` | ✓ | ✗ | Descarta as chaves `toolCalls` e `tool_call_id` em modo stream. |
| **Gemini** | `gemini` | ✗ | ✗ | Descarta imagens, chamadas de ferramenta e mapeamentos de ID. |
| **Anthropic** | `anthropic` | ✗ | ✓ (Assistant/Tool) | Descarta imagens em mensagens de role `user`. Preserva chamadas. |

---

## 7. Matriz de Preservação Oficial

A tabela abaixo define formalmente quais propriedades do pipeline chegam a cada componente:

| Campo / Variável | AgentLoop | ProviderFactory | Provider (Gemini) | Provider (Ollama Stream) | Provider (OpenAI/Compat) | Provider (Anthropic) | HTTP Payload |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **role** | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| **content** | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| **images** | ✓ | ✓ | ✗ | ✓ | ✓ | ✗ | ✗/✓ (Depende do Provedor) |
| **toolCalls** | ✓ | ✓ | ✗ | ✗ | ✓ | ✓ | ✗/✓ (Depende do Provedor) |
| **tool_call_id** | ✓ | ✓ | ✗ | ✗ | ✓ | ✓ | ✗/✓ (Depende do Provedor) |
| **success** | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| **error** | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| **stdout** | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| **stderr** | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| **exitCode** | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| **artifactPaths** | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| **metadata** | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |

---

## 8. Regras Arquiteturais e Princípios Permanentes

1.  **Autoridade Operacional**: A Tool Layer é a única autoridade sobre a execução física e o estado real dos arquivos no sistema operacional. O LLM atua apenas como um planejador cognitivo que propõe intenções.
2.  **Isolamento de Erro Físico**: Falhas de execução física (ex: comando com exit code > 0) devem ser reportadas no `output` do `ToolResult` como texto legível para o modelo, mas nunca devem interromper o fluxo de transporte de mensagens do NewClaw.
3.  **Adaptação sem Efeito Colateral**: Provedores são livres para mapear ou omitir chaves conforme exigido pelas respectivas APIs externas. Limitações nativas dos modelos ou de suas APIs REST (como descarte de imagens ou falta de suporte nativo a ferramentas) não caracterizam bugs estruturais no NewClaw.
4.  **Preservação Contratual**: Qualquer refatoração futura nas classes de provedores deve, obrigatoriamente, garantir no mínimo a preservação dos campos definidos na coluna de recursos suportados da matriz (Seção 6).
5.  **Processo de Alteração de Contratos**: Qualquer modificação em componentes centrais (Tool Layer, AgentLoop, Providers, ToolResult, LLMMessage) deve consultar e respeitar esta documentação, a suíte S114, as especificações por provedor, as golden payloads e a matriz de preservação. Alterações contratuais exigem justificativa técnica formal no Pull Request.

### Processo para Alterações Arquiteturais

Qualquer evolução ou alteração de arquitetura no pipeline de transporte deve seguir rigorosamente as seguintes fases do processo de engenharia:

1.  **Compreensão**: Análise profunda da causa raiz do problema e verificação do histórico e decisões de design anteriores.
2.  **Crítica**: Identificação ativa de falhas, trade-offs, acoplamentos indesejados ou regressões potenciais na proposta inicial.
3.  **Pesquisa**: Estudo de alternativas mais simples baseadas em padrões estabelecidos de engenharia de software.
4.  **Síntese**: Justificativa técnica clara da recomendação adotada, explicitando limitações e impactos.
5.  **Validação**: Testes locais em ambiente sandbox sem dependências ativas e com dados representativos.
6.  **Implementação**: Execução incremental da mudança apenas quando todos os critérios de sucesso e trade-offs estiverem alinhados.
7.  **Auditoria pós-implementação**: Análise detalhada pós-merge para certificar que nenhum comportamento indesejado surgiu em produção.

---

## 9. Rastreabilidade de Engenharia

Para fins de navegação e auditoria técnica do pipeline de transporte, as ligações cruzadas entre a especificação, as decisões e os testes de regressão estão listadas abaixo:

*   **ADR 0001 (Decisão Arquitetural)**: O registro formal das motivações técnicas para a sanitização de metadados no AgentLoop e mapeamento de hashes está em [0001-provider-pipeline-transport-integrity.md](file:///d:/IA/newclaw/docs/architecture/decisions/0001-provider-pipeline-transport-integrity.md).
*   **Suíte S114 (Validação de Regressão)**: O runner automatizado e as asserções de contratos de transporte estão implementados em [S114_TransportIntegrity.test.ts](file:///d:/IA/newclaw/src/__tests__/regression/S114_TransportIntegrity.test.ts).
*   **Provider Specifications (Especificações Técnicas)**: As definições de capacidades de cada provedor estão integradas sob o objeto `providerSpecifications` em [S114_TransportIntegrity.test.ts](file:///d:/IA/newclaw/src/__tests__/regression/S114_TransportIntegrity.test.ts#L48).
*   **Golden Payloads (Fixtures de Snapshots)**: Os formatos de payload JSON canônicos e serializados estão armazenados sob a pasta de fixtures do projeto em [fixtures/golden/](file:///d:/IA/newclaw/src/__tests__/fixtures/golden/).

---

## 10. Checklist de Pull Request (Alterações no Pipeline)

Qualquer Pull Request que realize alterações nas estruturas do pipeline de transporte (`ToolResult`, `LLMMessage`, `AgentLoop`, `ProviderFactory` ou `Providers`) deve atender de forma obrigatória aos seguintes itens de controle antes do merge:

- [ ] **Existe evidência que justifique a alteração?**
- [ ] **A autoridade existente foi preservada?**
- [ ] **Há duplicação de responsabilidade?**
- [ ] **A S114 continua válida?**
- [ ] **Os Golden Payloads permanecem consistentes?**
- [ ] **As Provider Specifications foram revisadas?**
- [ ] **A documentação normativa foi atualizada?**
- [ ] **Um novo ADR é necessário?**
