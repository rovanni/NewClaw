# ADR 0001: Sanitização do Histórico e Integridade do Transporte de Mensagens

*   **Status**: Aprovado
*   **Data**: 2026-07-14
*   **Autor**: Antigravity AI
*   **Origem**: Investigações do comportamento de loop infinito ("modo enrolação") do agente.

---

## Contexto

Durante as execuções cognitivas do NewClaw, o agente entrava ocasionalmente em loops infinitos de replanejamento ou chamadas repetitivas de ferramentas desnecessárias ("modo enrolação"). A investigação apontou que esse comportamento decorria de perdas e contaminações estruturais de dados no pipeline de transporte de mensagens:
1. Contaminação do histórico de chat (`LLMMessage[]`) com metadados físicos detalhados de execução (como stdout, stderr, exitCode).
2. Perda ou descarte incorreto de identificadores de chamadas de ferramentas (`toolCalls` e `tool_call_id`), impossibilitando o LLM de correlacionar qual resultado pertencia a qual ação planejada.
3. Limitações nativas na serialização HTTP dos provedores (como Gemini e Anthropic) que descartavam mídias e ferramentas de forma silenciosa.

---

## Problema

Precisávamos garantir que o histórico de mensagens enviado para inferência de LLM contivesse exatamente as informações necessárias para planejamento cognitivo, sem vazamento de dados operacionais e com mapeamentos de ferramentas preservados, respeitando as restrições e dialetos das APIs proprietárias de cada provedor.

---

## Alternativas Analisadas

### Alternativa A: Réplica Integral de Metadados no Contexto de Prompt
Enviar todos os dados de execução estruturados (`stdout`, `stderr`, `exitCode`, etc.) para o prompt do LLM.
*   *Prós*: O modelo tem acesso absoluto à telemetria de execução.
*   *Contras*: Alto custo de tokens, poluição do histórico, e indução ao erro (o LLM começa a tentar interpretar códigos de saída de SO e atuar como autoridade sobre a execução física, em vez de focar no planejamento lógico).

### Alternativa B: Sanitização Estrutural no AgentLoop + Serialização Adaptativa nos Providers (Adotada)
O `AgentLoop` atua como um filtro higienizador, retendo apenas o texto útil (`output`) e a amarração lógica (`tool_call_id`), enquanto as classes de Provedores traduzem a mensagem para o formato REST HTTP aceito pela API correspondente, tratando limitações de forma transparente.
*   *Prós*: Prompts limpos e concisos; clara separação de preocupações (a Tool Layer é autoridade de execução; o LLM é autoridade cognitiva); testes de regressão compatíveis com melhorias futuras dos provedores.
*   *Contras*: Exige que a infraestrutura de testes simule a serialização de múltiplos dialetos HTTP e filtre campos conhecidos para validar integridade estrutural.

---

## Decisão

Adotamos a **Alternativa B**. O fluxo de transporte de mensagens é normatizado sob as seguintes diretrizes:

1.  **Sanitização FSM**: O `AgentLoop` converte o resultado rico `ToolResult` em uma mensagem simples com `role: 'tool'` contendo apenas `content` (output textual) e `tool_call_id`, descartando chaves de telemetria operacional.
2.  **Providers como Tradutores**: Cada classe de provedor (Gemini, Anthropic, Ollama, OpenAI) é responsável por adaptar o histórico de mensagens padronizado para o esquema JSON de sua API, sem tentar alterar o histórico cognitivo original.
3.  **Contrato por Exclusão (Fidelidade do Hash)**: A suíte de regressão permanente [S114](file:///d:/IA/newclaw/src/__tests__/regression/S114_TransportIntegrity.test.ts) valida a integridade do transporte calculando hashes criptográficos (SHA-256) antes e depois da serialização com exclusão dos campos que o provedor *sabidamente* perde (`expectedLost`).
    - Se o hash limpo coincidir, a integridade do transporte contratado é garantida.
    - Se no futuro um provedor for aprimorado e passar a reter mais chaves, o teste notifica a melhoria sem quebrar a pipeline de CI.

---

## Consequências

### Impactos Positivos
*   **Contexto Focado**: Redução de tokens e eliminação de loops infinitos causados por poluição de logs no prompt.
*   **Sustentabilidade do Runner**: A suíte de regressão protege contra alterações acidentais de serialização que quebrem chamadas de ferramentas em provedores legados.
*   **Evolução Segura**: Facilidade para plugar novos provedores na `ProviderFactory` seguindo contratos descritivos estritos.

### Limitações Conhecidas
*   Provedores Gemini e Anthropic continuam descartando chaves de imagens brutas em mensagens do tipo `user` devido ao atual design de `convertMessages`.
*   O Ollama descarta `toolCalls` e `tool_call_id` em modo streaming devido a restrições estruturais de chunking de sua API.

### Trabalhos Futuros
*   Evoluir a serialização do `GeminiProvider` e `AnthropicProvider` para converter arrays de imagens de `LLMMessage` em blocos multimodais estruturados.
*   Implementar mapeamento nativo de `FunctionCall` para requisições Ollama em modo streaming.

---

## Referências

*   **Documento de Arquitetura (Especificação)**: O funcionamento detalhado do pipeline está especificado em [provider_pipeline_transport.md](../provider_pipeline_transport.md).
*   **Suíte de Validação (Testes S114)**: A verificação das regras estruturais e de integridade do transporte está implementada em [S114_TransportIntegrity.test.ts](../../../src/__tests__/regression/S114_TransportIntegrity.test.ts).
*   **Especificações de Provedores**: O dicionário de capacidades técnicas do runner está definido como `providerSpecifications` em [S114_TransportIntegrity.test.ts](../../../src/__tests__/regression/S114_TransportIntegrity.test.ts#L48).
*   **Golden Payloads (Fixtures)**: Os esquemas e payloads JSON canônicos esperados estão armazenados na pasta [fixtures/golden/](../../../src/__tests__/fixtures/golden/).
