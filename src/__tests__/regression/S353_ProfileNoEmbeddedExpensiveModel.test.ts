/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S353 (issue 068)
 *
 * 04–06/10/2026: uma instância de teste rodou com um .env sem MODEL_ANALYSIS/MODEL_EXECUTION e os perfis
 * `analysis` e `execution` caíram no padrão embutido `kimi-k2.6:cloud` — um dos modelos mais caros da nuvem do Ollama.
 * 209 chamadas em silêncio (116 delas com resposta de 1 caractere), consumindo a cota semanal do usuário, que só
 * descobriu pela tela de cobrança. Valia para toda instalação que não configurasse esses dois perfis.
 *
 * Contrato (decisão do operador: "a escolha dos modelos tem que vir do painel, não embutida no código"): nenhum
 * perfil tem modelo embutido. Sem configuração, `chat` usa o modelo padrão do provedor (o do painel), os demais perfis
 * de texto herdam o do `chat`, e `vision` fica não configurada. Configurado, o modelo do perfil é preservado.
 *
 * REGRESSÃO SE: algum perfil voltar a ter um modelo embutido próprio que o operador não escolheu.
 *
 * Execução: npx ts-node src/__tests__/regression/S353_ProfileNoEmbeddedExpensiveModel.test.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { ModelProfileRegistry } from '../../loop/ModelProfileRegistry';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}
const quiet = <T>(fn: () => T): T => {
    const orig = process.stdout.write.bind(process.stdout);
    (process.stdout.write as unknown) = (): boolean => true;
    try { return fn(); } finally { process.stdout.write = orig; }
};
const factory = (provider: string) => ({ getDefaultProvider: () => provider }) as any;

console.log('\n=== S353-1 — o caso real: só MODEL_CHAT configurado, provedor Ollama ===');
{
    const r = quiet(() => new ModelProfileRegistry({ chat: 'glm-5.3:cloud' } as any, factory('ollama')));
    assert(r.getProfileByCategory('analysis')?.model === 'glm-5.3:cloud', `analysis herda o MODEL_CHAT (obtido ${r.getProfileByCategory('analysis')?.model}; antes: kimi-k2.6:cloud)`);
    assert(r.getProfileByCategory('execution')?.model === 'glm-5.3:cloud', `execution herda o MODEL_CHAT (obtido ${r.getProfileByCategory('execution')?.model}; antes: kimi-k2.6:cloud)`);
    assert(r.resolveProfileSync('qual o preço do bitcoin?').model === 'glm-5.3:cloud', 'pedido classificado como "análise" (preço/cripto) usa o modelo do operador');
}

console.log('\n=== S353-2 — modelo configurado no perfil é preservado ===');
{
    const r = quiet(() => new ModelProfileRegistry({ chat: 'glm-5.3:cloud', analysis: 'gemma4:31b-cloud', execution: 'meu-modelo' } as any, factory('ollama')));
    assert(r.getProfileByCategory('analysis')?.model === 'gemma4:31b-cloud', 'MODEL_ANALYSIS configurado vence');
    assert(r.getProfileByCategory('execution')?.model === 'meu-modelo', 'MODEL_EXECUTION configurado vence');
}

console.log('\n=== S353-3 — provedor local (não-Ollama) com MODEL_CHAT: herda o modelo do operador, não é apagado ===');
{
    const r = quiet(() => new ModelProfileRegistry({ chat: 'qwen-local' } as any, factory('bonsai')));
    assert(r.getProfileByCategory('execution')?.model === 'qwen-local', `execution herda o modelo configurado do chat (obtido ${r.getProfileByCategory('execution')?.model})`);
}

console.log('\n=== S353-4 — provider explícito do perfil vence o herdado do chat ===');
{
    const r = quiet(() => new ModelProfileRegistry({ chat: 'glm-5.3:cloud', provider_chat: 'ollama', provider_execution: 'openrouter' } as any, factory('ollama')));
    const ex = r.getProfileByCategory('execution');
    assert(ex?.model === 'glm-5.3:cloud' && ex?.provider === 'openrouter', `execution: modelo do chat, provider próprio (${ex?.model} / ${ex?.provider})`);
    const an = r.getProfileByCategory('analysis');
    assert(an?.provider === 'ollama', `analysis sem provider próprio herda o do chat (${an?.provider})`);
}

console.log('\n=== S353-5 — nada configurado: nenhum perfil escolhe modelo por conta própria ===');
{
    const r = quiet(() => new ModelProfileRegistry(undefined, factory('ollama')));
    for (const cat of ['chat', 'code', 'light', 'analysis', 'execution'] as const) {
        assert(r.getProfileByCategory(cat)?.model === '', `${cat} → '' (modelo padrão do provedor, o do painel)`, r.getProfileByCategory(cat));
    }
    assert(r.getProfileByCategory('vision') === undefined, 'vision sem modelo escolhido → não configurada (nunca herda um modelo que talvez não leia imagem)');
    assert(r.getProfiles().every(p => p.model === ''), 'getProfiles (painel): nenhum modelo embutido aparece como se fosse escolha');
}

console.log('\n=== S353-6 — visão escolhida no painel é usada ===');
{
    const r = quiet(() => new ModelProfileRegistry({ chat: 'glm-5.3:cloud', vision: 'gemma4:31b-cloud' } as any, factory('ollama')));
    assert(r.getProfileByCategory('vision')?.model === 'gemma4:31b-cloud', 'MODEL_VISION configurado → perfil de visão disponível');
    const r2 = quiet(() => new ModelProfileRegistry({ chat: 'glm-5.3:cloud' } as any, factory('ollama')));
    assert(r2.getProfileByCategory('vision') === undefined, 'MODEL_CHAT sozinho não vira modelo de visão');
}

console.log('\n=== S353-7 — nenhum nome de modelo nos padrões do código ===');
{
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'loop', 'ModelProfileRegistry.ts'), 'utf-8');
    const def = src.indexOf('const DEFAULT_CONFIG');
    const bloco = src.slice(src.indexOf('    profiles: [', def), src.indexOf('fallbackRules:', def));
    const modelos = [...bloco.matchAll(/\bmodel:\s*'([^']*)'/g)].map(m => m[1]);
    assert(modelos.length === 6 && modelos.every(m => m === ''), `DEFAULT_CONFIG.profiles: os 6 perfis sem modelo (${JSON.stringify(modelos)})`);
}

async function modeloPadrao(): Promise<void> {
    console.log('\n=== S353-8 — sem "Modelo padrão" escolhido: a chamada não sai, e a mensagem diz o que fazer ===');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { ProviderFactory } = require('../../core/ProviderFactory');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { NO_MODEL_CONFIGURED_MESSAGE } = require('../../core/OllamaProvider');
    const original = global.fetch;
    const modelosPedidos: string[] = [];
    global.fetch = (async (_u: string, init?: { body?: string }) => {
        modelosPedidos.push(JSON.parse(String(init?.body ?? '{}')).model);
        const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode(JSON.stringify({ message: { content: 'ok' }, done: true, done_reason: 'stop' }) + '\n')); c.close(); } });
        return { ok: true, status: 200, body } as unknown as Response;
    }) as unknown as typeof fetch;
    try {
        const pf = new ProviderFactory({ defaultProvider: 'ollama', ollamaUrl: 'http://fake-ollama.invalid', ollamaModel: '' } as any);
        const r: any = await quietAsync(() => pf.chatWithFallback([{ role: 'user', content: 'oi' }], undefined, 'ollama', 2000));
        assert(r.status === 'error' && r.fallbackMessage === NO_MODEL_CONFIGURED_MESSAGE, `mensagem ao usuário: "${r.fallbackMessage}"`);
        assert(modelosPedidos.length === 0, `nenhum pedido sem modelo saiu para o Ollama (saíram ${modelosPedidos.length})`);
        assert(!(r.attempts || []).some((a: { errorMessage?: string }) => /abort|Timeout/.test(a.errorMessage ?? '')), 'não tratado como falha transitória');

        console.log('\n=== S353-9 — modelo do perfil escolhido no painel funciona mesmo sem "Modelo padrão" ===');
        const r2: any = await quietAsync(() => pf.chatWithFallback([{ role: 'user', content: 'oi' }], undefined, 'ollama', 2000, undefined, 'glm-5.3:cloud'));
        assert(r2.status === 'success' && modelosPedidos[0] === 'glm-5.3:cloud', `pedido saiu com o modelo do perfil (${modelosPedidos[0]})`);
    } finally { global.fetch = original; }

    console.log('\n=== S353-10 — nenhum "Modelo padrão" embutido no código ===');
    const ler = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), 'src', ...p), 'utf-8');
    const fontes: Array<[string, string]> = [
        ['index.ts', ler('index.ts')], ['ProviderFactory.ts', ler('core', 'ProviderFactory.ts')], ['AgentController.ts', ler('core', 'AgentController.ts')],
        ['routes/config.ts', ler('dashboard', 'routes', 'config.ts')], ['OllamaProvider.ts', ler('core', 'OllamaProvider.ts')],
    ];
    for (const [nome, src] of fontes) {
        const achados = src.match(/(ollamaModel|OLLAMA_MODEL|model: string =)[^\n]*['"][\w.\-]+:cloud['"]/g) ?? [];
        assert(achados.length === 0, `${nome}: sem nome de modelo como padrão`, achados);
    }
}
const quietAsync = async <T>(fn: () => Promise<T>): Promise<T> => {
    const orig = process.stdout.write.bind(process.stdout);
    (process.stdout.write as unknown) = (): boolean => true;
    try { return await fn(); } finally { process.stdout.write = orig; }
};

modeloPadrao().then(() => {
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S353 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    if (failed > 0) process.exitCode = 1;
}).catch((err) => { console.error('S353 erro inesperado:', err); process.exitCode = 1; });
