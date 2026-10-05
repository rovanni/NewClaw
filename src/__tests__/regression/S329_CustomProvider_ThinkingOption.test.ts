/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S329 (issue 054, Sprint D3)
 *
 * Num modelo local de 27B (Bonsai, llama-server, família Qwen), o raciocínio ("thinking") domina o tempo:
 * com um prompt do tamanho do planejador (15,9 mil chars), 218 s e 8.000 tokens só de raciocínio, sem
 * resposta nem JSON; sem raciocínio, plano em JSON válido em 23 s. Medido contra o servidor real em
 * 05/10/2026. O operador passa a poder declarar `thinking: 'off'` no provedor customizado, e o
 * OpenAIProvider envia `chat_template_kwargs.enable_thinking=false`.
 *
 * REGRESSÃO SE: o parâmetro for enviado sem o operador declarar (a API oficial pode recusar parâmetro
 * desconhecido); a opção se perder entre o cadastro (CUSTOM_PROVIDERS) e a requisição; ou o caminho
 * por modelo (getProviderWithModel, usado pelo roteador de perfis) ignorá-la.
 *
 * Execução: npx ts-node src/__tests__/regression/S329_CustomProvider_ThinkingOption.test.ts
 */
import { OpenAIProvider } from '../../core/OpenAIProvider';
import { ProviderFactory } from '../../core/ProviderFactory';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

/** Captura o corpo JSON da próxima requisição feita por `fn`. */
async function captureBody(fn: () => Promise<unknown>): Promise<Record<string, unknown>> {
    const realFetch = globalThis.fetch;
    let body: Record<string, unknown> = {};
    (globalThis as any).fetch = async (_url: string, init: { body: string }) => {
        body = JSON.parse(init.body);
        return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    try { await fn(); } finally { (globalThis as any).fetch = realFetch; }
    return body;
}
const msgs = [{ role: 'user' as const, content: 'oi' }];
const quiet = <T>(fn: () => T): T => {
    const orig = process.stdout.write.bind(process.stdout);
    (process.stdout.write as unknown) = (): boolean => true;
    try { return fn(); } finally { process.stdout.write = orig; }
};

async function main(): Promise<void> {

console.log('\n=== S329-1 — OpenAIProvider: o parâmetro só vai quando declarado ===');
{
    const off = await captureBody(() => new OpenAIProvider('', 'm', 'http://127.0.0.1:8080/v1', 'local', { thinking: 'off' }).chat(msgs));
    assert(JSON.stringify(off.chat_template_kwargs) === '{"enable_thinking":false}', "thinking 'off' → enable_thinking=false", off.chat_template_kwargs);
    const on = await captureBody(() => new OpenAIProvider('', 'm', 'http://127.0.0.1:8080/v1', 'local', { thinking: 'on' }).chat(msgs));
    assert(JSON.stringify(on.chat_template_kwargs) === '{"enable_thinking":true}', "thinking 'on' → enable_thinking=true", on.chat_template_kwargs);
    const none = await captureBody(() => new OpenAIProvider('', 'gpt-4o').chat(msgs));
    assert(!('chat_template_kwargs' in none), 'sem declaração (ex.: OpenAI oficial) → parâmetro ausente', none);
}

console.log('\n=== S329-2 — ProviderFactory: do cadastro (CUSTOM_PROVIDERS) até a requisição ===');
{
    const pf = quiet(() => new ProviderFactory({
        defaultProvider: 'bonsai',
        ollamaUrl: 'http://127.0.0.1:1',
        customProviders: [{ label: 'bonsai', baseUrl: 'http://127.0.0.1:8080/v1', model: 'Bonsai-27B', thinking: 'off' }],
    } as any));
    const viaModelo = await captureBody(() => (pf.getProviderWithModel('', 'bonsai') as OpenAIProvider).chat(msgs));
    assert((viaModelo.chat_template_kwargs as { enable_thinking?: boolean })?.enable_thinking === false, 'getProviderWithModel (roteador de perfis) leva a opção', viaModelo);
    assert(viaModelo.model === 'Bonsai-27B', 'modelo vazio → o do provedor (issue 054 D2)', viaModelo.model);
    const registrado = await captureBody(() => (pf.getProvider('bonsai') as OpenAIProvider).chat(msgs));
    assert((registrado.chat_template_kwargs as { enable_thinking?: boolean })?.enable_thinking === false, 'a instância registrada leva a opção', registrado);

    const pf2 = quiet(() => new ProviderFactory({
        defaultProvider: 'outro', ollamaUrl: 'http://127.0.0.1:1',
        customProviders: [{ label: 'outro', baseUrl: 'http://127.0.0.1:8081/v1' }],
    } as any));
    const semOpcao = await captureBody(() => (pf2.getProvider('outro') as OpenAIProvider).chat(msgs));
    assert(!('chat_template_kwargs' in semOpcao), 'provedor customizado sem a opção → parâmetro ausente', semOpcao);
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S329 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;
}

main().catch((err) => { console.error('S329 erro inesperado:', err); process.exitCode = 1; });
