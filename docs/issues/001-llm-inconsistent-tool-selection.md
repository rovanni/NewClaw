# 🐛 Decisão inconsistente do LLM na escolha e execução de tools

## Descrição

O NewClaw apresenta comportamentos inconsistentes na camada de decisão do LLM, mesmo quando as ferramentas estão funcionando corretamente. O modelo:

1. **Seleciona tool inadequada** — ex: `memory_search` em vez de `web_search` para cotações de cripto
2. **Interrompe fluxo prematuramente** — quando uma tool falha, não tenta alternativas
3. **Vaza tool calls como texto** — inclui `web_search {"query":"..."}` na resposta final
4. **Repete system prompt** — inclui "Você é o NewClaw... Ferramentas disponíveis..." na resposta

## Comportamento Esperado

- LLM seleciona a tool mais adequada com base na intenção
- Em caso de falha, tenta ferramentas alternativas automaticamente
- Resposta final é texto natural limpo, sem JSON, tags XML ou prompt interno

## Comportamento Observado

| Problema | Frequência | Exemplo |
|----------|-----------|---------|
| Tool errada | ~20% | `memory_search` para "preço do BTC" |
| Vazamento de tool calls | ~30% | `crypto_analysis {"type":"gainers"}` |
| System prompt vazado | ~10% | "Ferramentas disponíveis..." |
| Sem fallback | ~15% | Tool falha → "Nenhum resultado" |

## Causa Raiz

O problema está na camada de raciocínio do GLM-5.1:cloud. LLMs são inerentemente não determinísticos. O sanitize atual mitiga mas não elimina o problema.

## Melhorias Sugeridas

### 1. Validação Pós-Execução (Post-Execution Checker)
Verificar se a ação foi executada antes de responder.

### 2. Retry com Fallback Automático
Se `web_search` falha, tentar `memory_search`. Se `memory_write` falha, sugerir alternativa.

### 3. Prompt com Exemplos de Fallback
Few-shot examples no system prompt demonstrando fluxo correto.

### 4. Observabilidade e Métricas
Logs de: tool escolhida, resultado, retries, taxa de sucesso.

### 5. Camada de Governança
```
Usuário → LLM → Validador → Execução → Retry (se necessário) → Resposta
```

## Severidade
- **Severidade:** Média
- **Frequência:** Ocasional (~2 em 10 interações)
- **Impacto:** Respostas incompletas ou vazamento de dados internos

## Contexto
- Arquitetura: 5 tools genéricas (como OpenClaw)
- Modelo: GLM-5.1:cloud via Ollama
- Sanitize implementado mas não 100% eficaz
- Commit base: `1dadd4e`