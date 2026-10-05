/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S326 (issue 054, Sprint D1)
 *
 * Com um modelo local servido por `llama-server` (Bonsai 27B, família Qwen), todo turno do AgentLoop
 * com ferramenta falhava: HTTP 500 "Jinja Exception: System message must be at the beginning". O
 * AgentLoop insere avisos `system` no meio do turno (33 pontos) e o template estrito do modelo só
 * aceita UMA mensagem `system`, na primeira posição. Prova direta contra o servidor real (05/10/2026):
 * a mesma conversa deu 500 no formato original e 200 normalizada.
 *
 * REGRESSÃO SE: o OpenAIProvider voltar a enviar `system` fora da 1ª posição, ou mais de uma; ou a
 * normalização reordenar a conversa ou perder o texto de alguma mensagem.
 *
 * Execução: npx ts-node src/__tests__/regression/S326_OpenAIProvider_SystemMessagesOnlyAtStart.test.ts
 */
import { OpenAIProvider, normalizeSystemMessages } from '../../core/OpenAIProvider';
import type { LLMMessage } from '../../core/providerTypes';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

const turno: LLMMessage[] = [
    { role: 'system', content: 'Você é um assistente.' },
    { role: 'system', content: 'Contexto da sessão.' },
    { role: 'user', content: 'Analise as aulas.' },
    { role: 'assistant', content: 'Vou listar a pasta.' },
    { role: 'tool', content: 'aula_01.md aula_02.md' } as LLMMessage,
    { role: 'system', content: '[FALHA] A ferramenta read falhou: ENOENT.' },
    { role: 'user', content: 'Continue.' },
];

/** O template estrito: exatamente uma `system`, e só na posição 0. */
function templateAccepts(ms: Array<{ role: string }>): boolean {
    return ms.every((m, i) => m.role !== 'system' || i === 0);
}

async function main(): Promise<void> {

console.log('\n=== S326-1 — normalizeSystemMessages ===');
{
    const out = normalizeSystemMessages(turno);
    assert(!templateAccepts(turno), 'pré-condição: o turno original é rejeitado pelo template estrito');
    assert(templateAccepts(out), 'normalizado: uma única system, na 1ª posição');
    assert(out[0].role === 'system' && out[0].content === 'Você é um assistente.\n\nContexto da sessão.', 'as system iniciais viram uma só, na ordem', out[0]);
    assert(out.length === turno.length - 1, 'nenhuma mensagem perdida (só a fusão das iniciais)', out.length);
    assert(out.map(m => m.role).join(',') === 'system,user,assistant,tool,user,user', 'ordem preservada; a system do meio vira user na MESMA posição', out.map(m => m.role));
    assert(out[4].content === '[Instrução do sistema] [FALHA] A ferramenta read falhou: ENOENT.', 'texto da instrução preservado, marcado como do sistema', out[4].content);
    assert(normalizeSystemMessages([{ role: 'user', content: 'oi' }])[0].role === 'user', 'sem system: inalterado');
    assert(normalizeSystemMessages([]).length === 0, 'lista vazia');
    const semInicial = normalizeSystemMessages([{ role: 'user', content: 'a' }, { role: 'system', content: 'b' }]);
    assert(semInicial.map(m => m.role).join(',') === 'user,user', 'system sem nenhuma inicial também vira user');
}

console.log('\n=== S326-2 — o OpenAIProvider ENVIA o formato normalizado (corpo da requisição capturado) ===');
{
    const realFetch = globalThis.fetch;
    let body: { messages: Array<{ role: string; content: unknown }> } | null = null;
    (globalThis as any).fetch = async (_url: string, init: { body: string }) => {
        body = JSON.parse(init.body);
        return new Response(JSON.stringify({ choices: [{ message: { content: '5' } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    try {
        const p = new OpenAIProvider('', 'modelo-local', 'http://127.0.0.1:8080/v1', 'local');
        const r = await p.chat(turno);
        assert(r.content === '5', 'resposta lida normalmente', r);
        const sent = body as { messages: Array<{ role: string; content: unknown }> } | null;
        assert(!!sent && templateAccepts(sent.messages), 'o corpo enviado tem uma única system, na 1ª posição', sent?.messages.map(m => m.role));
        assert(!!sent && sent.messages.length === 6, 'todas as mensagens enviadas', sent?.messages.length);
    } finally {
        (globalThis as any).fetch = realFetch;
    }
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S326 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;
}

main().catch((err) => { console.error('S326 erro inesperado:', err); process.exitCode = 1; });
