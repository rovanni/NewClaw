/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S370 (campanha 09/10/2026, "salve essas informações na memória")
 *
 * O pedido "salve essas informações na memória sobre o river" terminou com a resposta literal
 * "[Tool call: memory_admin]" e nada salvo. No passo 2 o modelo devolveu a chamada de `memory_admin` MAIS
 * o texto "[Tool call: memory_admin]" (25 caracteres); o OpenAIProvider reenviou o histórico com o campo
 * interno `toolCalls` (a API OpenAI só entende `tool_calls`), então o servidor via uma volta do assistente
 * SÓ com esse texto e uma mensagem `tool` órfã. No passo 3 o modelo repetiu o texto (25 caracteres, sem
 * chamada) e o loop o entregou como resposta final.
 *
 * REGRESSÃO SE: o corpo enviado a um servidor OpenAI-compatível voltar a (a) carregar o campo `toolCalls`,
 * (b) perder `tool_calls` numa volta do assistente que chamou ferramentas, (c) deixar a mensagem `tool`
 * sem a chamada de mesmo id na volta anterior, ou (d) mudar o texto/ordem das demais mensagens.
 *
 * Execução: npx ts-node src/__tests__/regression/S370_OpenAIProvider_ToolCallsInHistory.test.ts
 */
import { OpenAIProvider, toOpenAIMessage } from '../../core/OpenAIProvider';
import type { LLMMessage } from '../../core/providerTypes';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

type Corpo = { messages: Array<Record<string, any>> };

const historico: LLMMessage[] = [
    { role: 'system', content: 'Você é um assistente.' },
    { role: 'user', content: 'Salve essas informações na memória.' },
    {
        role: 'assistant',
        content: '[Tool call: memory_admin]',
        toolCalls: [{ id: 'call_1', name: 'memory_admin', arguments: { action: 'inspect', node: 'proj_river' } }],
    },
    { role: 'tool', content: 'Nó: proj_river', tool_call_id: 'call_1' },
    { role: 'assistant', content: 'Pronto.', toolCalls: [] },
    { role: 'user', content: 'Obrigado.' },
];

async function main(): Promise<void> {

console.log('\n=== S370-1 — toOpenAIMessage ===');
{
    const volta = toOpenAIMessage(historico[2]);
    assert(!('toolCalls' in volta), 'o campo interno toolCalls não segue adiante', Object.keys(volta));
    const chamadas = volta.tool_calls as Array<Record<string, any>>;
    assert(Array.isArray(chamadas) && chamadas.length === 1, 'a volta do assistente carrega tool_calls', volta);
    assert(chamadas[0].id === 'call_1' && chamadas[0].type === 'function', 'id e tipo da chamada', chamadas[0]);
    assert(chamadas[0].function.name === 'memory_admin', 'nome da ferramenta', chamadas[0]);
    assert(typeof chamadas[0].function.arguments === 'string'
        && JSON.parse(chamadas[0].function.arguments).node === 'proj_river', 'argumentos em texto JSON, como a API exige', chamadas[0]);
    assert(volta.content === '[Tool call: memory_admin]', 'o texto que o modelo escreveu junto não é alterado', volta.content);

    assert(!('tool_calls' in toOpenAIMessage(historico[4])), 'toolCalls vazio não gera tool_calls', toOpenAIMessage(historico[4]));
    assert(!('tool_calls' in toOpenAIMessage(historico[1])), 'mensagem de usuário inalterada', toOpenAIMessage(historico[1]));
    const tool = toOpenAIMessage(historico[3]);
    assert(tool.role === 'tool' && tool.tool_call_id === 'call_1' && tool.content === 'Nó: proj_river', 'mensagem tool mantém tool_call_id e conteúdo', tool);
    const comImagem = toOpenAIMessage({ role: 'user', content: 'veja', images: ['iVBORw0KGgoAAAA'] });
    assert(Array.isArray(comImagem.content) && !('images' in comImagem), 'imagem continua dentro de content (S192)', comImagem);
}

console.log('\n=== S370-2 — o corpo enviado ao servidor (requisição capturada) ===');
{
    const realFetch = globalThis.fetch;
    let body: Corpo | null = null;
    (globalThis as any).fetch = async (_url: string, init: { body: string }) => {
        body = JSON.parse(init.body);
        return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    try {
        const p = new OpenAIProvider('', 'modelo-local', 'http://127.0.0.1:8080/v1', 'local');
        await p.chat(historico);
        const sent = (body as Corpo | null)?.messages ?? [];
        assert(sent.length === historico.length, 'nenhuma mensagem perdida', sent.length);
        assert(sent.every(m => !('toolCalls' in m)), 'nenhuma mensagem leva o campo interno toolCalls');
        const idxVolta = sent.findIndex(m => m.role === 'assistant' && Array.isArray(m.tool_calls));
        const idxTool = sent.findIndex(m => m.role === 'tool');
        assert(idxVolta >= 0 && idxTool === idxVolta + 1, 'a mensagem tool vem logo depois da volta que fez a chamada', sent.map(m => m.role));
        assert(sent[idxVolta].tool_calls[0].id === sent[idxTool].tool_call_id, 'a resposta da ferramenta aponta para a chamada feita', sent[idxTool]);
        assert(sent.map(m => m.role).join(',') === 'system,user,assistant,tool,assistant,user', 'ordem preservada', sent.map(m => m.role));
    } finally {
        (globalThis as any).fetch = realFetch;
    }
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S370 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;
}

main().catch((err) => { console.error('S370 erro inesperado:', err); process.exitCode = 1; });
