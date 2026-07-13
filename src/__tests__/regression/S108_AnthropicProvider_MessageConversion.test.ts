/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S108
 *
 * Provider nativo Anthropic (api.anthropic.com), adicionado a pedido do usuário — o Claude já
 * era acessível via OpenRouter (anthropic/claude-3.5-sonnet como default), mas sem API direta
 * nem card dedicado no dashboard.
 *
 * A Messages API da Anthropic usa um formato de blocos bem diferente do estilo OpenAI que os
 * demais providers (Gemini/DeepSeek/Groq/OpenRouter) recebem quase sem conversão: `system` fica
 * fora do array de mensagens, tool calls viram blocos `tool_use` no turno do assistant, e
 * resultados de tool viram blocos `tool_result` dentro de uma mensagem `user`. Este teste cobre
 * a função pura de conversão (`_convertMessagesForTest`) e a fiação básica no ProviderFactory.
 *
 * Verifica:
 * 1. Mensagens 'system' são extraídas para o campo `system`, fora do array de mensagens.
 * 2. Uma mensagem assistant com toolCalls vira um bloco `tool_use` (+ bloco `text` se houver
 *    conteúdo).
 * 3. Mensagens 'tool' consecutivas são agrupadas em UMA mensagem 'user' com múltiplos blocos
 *    `tool_result`, cada um referenciando o `tool_use_id` correto.
 * 4. ProviderFactory registra 'anthropic' quando a key está presente e o omite quando ausente.
 * 5. updateCredential/removeCredential adicionam e removem o provider dinamicamente.
 */

import { _convertMessagesForTest as convertMessages } from '../../core/AnthropicProvider';
import { ProviderFactory } from '../../core/ProviderFactory';
import type { LLMMessage } from '../../core/providerTypes';

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string, detail?: unknown): void {
    if (cond) { console.log(`  ✅ ${msg}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${msg}`, detail ?? ''); failed++; }
}

async function main() {
    console.log('\n=== S108 — AnthropicProvider: conversão de mensagens + wiring no ProviderFactory ===');

    // 1. system extraído para fora do array de mensagens
    {
        const messages: LLMMessage[] = [
            { role: 'system', content: 'Você é um assistente útil.' },
            { role: 'user', content: 'Oi' },
        ];
        const { system, anthropicMessages } = convertMessages(messages);
        assert(system === 'Você é um assistente útil.', 'system extraído corretamente', system);
        assert(anthropicMessages.length === 1 && anthropicMessages[0].role === 'user', 'array de mensagens não contém role system', anthropicMessages);
    }

    // 2. assistant com toolCalls vira bloco tool_use
    {
        const messages: LLMMessage[] = [
            { role: 'user', content: 'Que horas são?' },
            { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'get_time', arguments: {} }] },
        ];
        const { anthropicMessages } = convertMessages(messages);
        const assistantMsg = anthropicMessages[1];
        assert(assistantMsg.role === 'assistant', 'segunda mensagem é do assistant', assistantMsg);
        const blocks = assistantMsg.content as any[];
        assert(Array.isArray(blocks) && blocks.some(b => b.type === 'tool_use' && b.name === 'get_time' && b.id === 'call_1'),
            'bloco tool_use gerado com id/name corretos', blocks);
    }

    // 3. mensagens 'tool' consecutivas agrupadas em UMA mensagem user com múltiplos tool_result
    {
        const messages: LLMMessage[] = [
            { role: 'user', content: 'Faça duas coisas' },
            {
                role: 'assistant', content: '', toolCalls: [
                    { id: 'call_a', name: 'tool_a', arguments: {} },
                    { id: 'call_b', name: 'tool_b', arguments: {} },
                ]
            },
            { role: 'tool', content: 'resultado A', tool_call_id: 'call_a' },
            { role: 'tool', content: 'resultado B', tool_call_id: 'call_b' },
            { role: 'assistant', content: 'Pronto!' },
        ];
        const { anthropicMessages } = convertMessages(messages);
        // user, assistant(tool_use x2), user(tool_result x2), assistant(text) = 4 mensagens
        assert(anthropicMessages.length === 4, `4 mensagens Anthropic geradas (obtido ${anthropicMessages.length})`, anthropicMessages);
        const toolResultMsg = anthropicMessages[2];
        assert(toolResultMsg.role === 'user', 'mensagem de tool_result tem role user', toolResultMsg);
        const blocks = toolResultMsg.content as any[];
        assert(Array.isArray(blocks) && blocks.length === 2, 'as duas mensagens tool viraram blocos na MESMA mensagem user', blocks);
        assert(blocks[0].tool_use_id === 'call_a' && blocks[0].content === 'resultado A', 'primeiro tool_result referencia call_a corretamente', blocks[0]);
        assert(blocks[1].tool_use_id === 'call_b' && blocks[1].content === 'resultado B', 'segundo tool_result referencia call_b corretamente', blocks[1]);
    }

    // 4. ProviderFactory: registra 'anthropic' só quando a key está presente
    {
        const withKey = new ProviderFactory({ anthropicKey: 'sk-ant-test', defaultProvider: 'anthropic' });
        assert(withKey.getAvailableProviders().includes('anthropic'), 'provider "anthropic" registrado quando anthropicKey presente', withKey.getAvailableProviders());

        const withoutKey = new ProviderFactory({ defaultProvider: 'ollama' });
        assert(!withoutKey.getAvailableProviders().includes('anthropic'), 'provider "anthropic" AUSENTE quando anthropicKey não configurada', withoutKey.getAvailableProviders());
    }

    // 5. updateCredential/removeCredential funcionam em runtime
    {
        const factory = new ProviderFactory({ defaultProvider: 'ollama' });
        assert(!factory.getAvailableProviders().includes('anthropic'), 'inicialmente sem anthropic', factory.getAvailableProviders());

        factory.updateCredential('anthropicKey', 'sk-ant-runtime');
        assert(factory.getAvailableProviders().includes('anthropic'), 'updateCredential adiciona "anthropic" em runtime', factory.getAvailableProviders());

        const provider = factory.getProviderWithModel('claude-sonnet-5', 'anthropic');
        assert(provider.name === 'anthropic', 'getProviderWithModel retorna instância AnthropicProvider', provider.name);

        factory.removeCredential('anthropicKey');
        assert(!factory.getAvailableProviders().includes('anthropic'), 'removeCredential remove "anthropic"', factory.getAvailableProviders());
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S108 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    if (failed > 0) process.exit(1);
    process.exit(0);
}

main().catch(err => {
    console.error('Erro no teste S108:', err);
    process.exit(1);
});
