/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S364 (issue 071 — Soberania da Configuração)
 *
 * Produção, 08/10/2026: com tudo configurado local (llamafile + Gemma 4 12B), o NewClaw chamou a nuvem 6 vezes —
 * roteador, domínio e agente pela reserva da cadeia de providers (o Ollama, com OLLAMA_MODEL=glm-5.2:cloud, gravado
 * pelo painel a cada Salvar), o classificador de domínio pelo modelo guardado no boot, e o juiz em sombra
 * (GROUNDING_SHADOW_MODEL=gemma4:cloud). Decisão do operador: quem escolheu offline continua offline; a escolha do
 * assistente vale para tudo.
 *
 * REGRESSÃO SE: uma chamada com o provedor padrão local sair da máquina sem PERMITIR_NUVEM_COMO_RESERVA; o Ollama
 * local com modelo `:cloud` voltar a contar como local; o juiz em sombra rodar na nuvem nessa situação; o classificador
 * de domínio voltar a guardar o modelo do boot; o assistente deixar de aplicar a escolha a todos os perfis; ou o painel
 * voltar a gravar um modelo embutido.
 *
 * Execução: npx ts-node src/__tests__/regression/S364_LocalChoiceNeverFallsToCloud.test.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { ProviderFactory } from '../../core/ProviderFactory';
import { ehModeloDaNuvemDoOllama } from '../../core/providerTypes';
import { ObserverValidator } from '../../loop/ObserverValidator';
import { createDomainClassifierLLM } from '../../memory/DomainRegistry';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}
const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
    const orig = process.stdout.write.bind(process.stdout);
    (process.stdout.write as unknown) = (): boolean => true;
    try { return await fn(); } finally { process.stdout.write = orig; }
};

/** O servidor local falha; o Ollama responderia. Registra para onde cada requisição foi. */
function fetchLocalFalha(urls: string[], modelosOllama: string[]): typeof fetch {
    return (async (url: string, init?: { body?: string }) => {
        urls.push(String(url));
        if (String(url).includes('127.0.0.1:8080')) return { ok: false, status: 500, text: async () => 'falha local', json: async () => ({ error: 'falha local' }) } as unknown as Response;
        modelosOllama.push(JSON.parse(String(init?.body ?? '{}')).model);
        const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode(JSON.stringify({ message: { content: 'resposta da nuvem' }, done: true, done_reason: 'stop' }) + '\n')); c.close(); } });
        return { ok: true, status: 200, body, json: async () => ({ message: { content: 'resposta da nuvem' }, done: true }) } as unknown as Response;
    }) as unknown as typeof fetch;
}
const fabrica = (ollamaModel: string) => new ProviderFactory({
    defaultProvider: 'Modelo local', ollamaUrl: 'http://localhost:11434', ollamaModel,
    customProviders: [{ label: 'Modelo local', baseUrl: 'http://127.0.0.1:8080/v1', model: 'gemma-4-12B-it-Q4_K_M.gguf' }],
} as any);

async function main(): Promise<void> {
    const original = global.fetch;
    const permitirOrig = process.env.PERMITIR_NUVEM_COMO_RESERVA;
    delete process.env.PERMITIR_NUVEM_COMO_RESERVA;

    console.log('\n=== S364-1 — modelo de nuvem do Ollama é reconhecido pelo nome ===');
    assert(ehModeloDaNuvemDoOllama('glm-5.2:cloud') && ehModeloDaNuvemDoOllama('gemma4:31b-cloud') && ehModeloDaNuvemDoOllama('gpt-oss:120b-cloud'), ':cloud e -cloud → nuvem');
    assert(!ehModeloDaNuvemDoOllama('gemma3:12b') && !ehModeloDaNuvemDoOllama('qwen2.5:3b') && !ehModeloDaNuvemDoOllama(undefined), 'modelos baixados → local');

    console.log('\n=== S364-2 — padrão local, chamada SEM provider: a reserva não vai para a nuvem ===');
    const urls: string[] = [], modelos: string[] = [];
    global.fetch = fetchLocalFalha(urls, modelos);
    let r: any;
    try { r = await quiet(() => fabrica('glm-5.2:cloud').chatWithFallback([{ role: 'user', content: 'classifique' }], undefined, undefined, 3000)); }
    finally { global.fetch = original; }
    assert(urls.length > 0 && urls.every(u => u.includes('127.0.0.1:8080')), `só o servidor local foi chamado (${[...new Set(urls.map(u => new URL(u).host))].join(', ')})`);
    assert(modelos.length === 0, `nenhuma requisição ao Ollama com modelo de nuvem (antes: glm-5.2:cloud) — obtido ${JSON.stringify(modelos)}`);
    assert(r?.status !== 'success', `a falha do local é devolvida como falha (${r?.status}), não mascarada pela nuvem`);

    console.log('\n=== S364-3 — com PERMITIR_NUVEM_COMO_RESERVA=true, a reserva na nuvem volta a valer ===');
    process.env.PERMITIR_NUVEM_COMO_RESERVA = 'true';
    const urls2: string[] = [], modelos2: string[] = [];
    global.fetch = fetchLocalFalha(urls2, modelos2);
    let r2: any;
    try { r2 = await quiet(() => fabrica('glm-5.2:cloud').chatWithFallback([{ role: 'user', content: 'classifique' }], undefined, undefined, 3000)); }
    finally { global.fetch = original; delete process.env.PERMITIR_NUVEM_COMO_RESERVA; }
    assert(modelos2.includes('glm-5.2:cloud') && r2?.status === 'success', 'autorizado no painel → usa a nuvem como reserva');

    console.log('\n=== S364-4 — Ollama local com modelo BAIXADO continua sendo reserva válida (fica na máquina) ===');
    const urls3: string[] = [], modelos3: string[] = [];
    global.fetch = fetchLocalFalha(urls3, modelos3);
    let r3: any;
    try { r3 = await quiet(() => fabrica('gemma3:12b').chatWithFallback([{ role: 'user', content: 'x' }], undefined, undefined, 3000)); }
    finally { global.fetch = original; }
    assert(modelos3.includes('gemma3:12b') && r3?.status === 'success', 'reserva local → local é permitida sem opção nenhuma');

    console.log('\n=== S364-5 — a pergunta única de soberania, e o juiz em sombra obedece a ela ===');
    const pf = fabrica('glm-5.2:cloud');
    assert(pf.modeloPermitidoPelaSoberania('gemma4:cloud') === false && pf.modeloPermitidoPelaSoberania('gemma3:12b') === true, 'padrão local: modelo de nuvem não é permitido; modelo baixado é');
    const shadowOrig = process.env.GROUNDING_SHADOW_MODEL;
    process.env.GROUNDING_SHADOW_MODEL = 'gemma4:cloud';
    const modelosJuiz: Array<string | undefined> = [];
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getBudgetAuxiliar } = require('../../shared/auxTimeout');
    const fJuiz = {
        chatWithFallback: async (_m: unknown, _t: unknown, _p: unknown, _ms: unknown, _s: unknown, modelo?: string) => { modelosJuiz.push(modelo); return { status: 'success', content: '{"claims":[]}', attempts: [] }; },
        getBudgetAuxiliar: (p: 'classificacao' | 'validacao') => getBudgetAuxiliar(p, null, null),
        modeloPermitidoPelaSoberania: (m: string) => pf.modeloPermitidoPelaSoberania(m),
    } as any;
    await quiet(async () => { await new ObserverValidator(fJuiz, 'gemma-4-12B-it-Q4_K_M.gguf').validateGrounding('Faz 18 °C.', [{ id: 'E1', tool: 'weather', output: '18 °C' }], undefined, { phase: 'initial' }); await new Promise(r => setTimeout(r, 50)); });
    if (shadowOrig === undefined) delete process.env.GROUNDING_SHADOW_MODEL; else process.env.GROUNDING_SHADOW_MODEL = shadowOrig;
    assert(modelosJuiz.length === 1 && !modelosJuiz.includes('gemma4:cloud'), `só o juiz real rodou; a sombra na nuvem não (${JSON.stringify(modelosJuiz)})`);

    console.log('\n=== S364-6 — o classificador de domínio lê o modelo a cada chamada ===');
    let modeloAtual = 'glm-5.3:cloud';
    const usados: Array<string | undefined> = [];
    const fDom = { chatWithFallback: async (_m: unknown, _t: unknown, _p: unknown, _ms: unknown, _s: unknown, modelo?: string) => { usados.push(modelo); return { status: 'success', content: '{"domainId":null,"confidence":0.1}', attempts: [] }; }, getBudgetAuxiliar: () => ({ timeoutMs: 1000, origem: 'padrao' }) } as any;
    const classificar = createDomainClassifierLLM(fDom, () => modeloAtual);
    await quiet(() => classificar('qual o tempo amanhã?'));
    modeloAtual = 'gemma-4-12B-it-Q4_K_M.gguf';   // o operador troca no painel
    await quiet(() => classificar('qual o tempo amanhã?'));
    assert(usados[0] === 'glm-5.3:cloud' && usados[1] === 'gemma-4-12B-it-Q4_K_M.gguf', `a troca no painel vale na hora (${JSON.stringify(usados)})`);
    const ac = fs.readFileSync(path.join(process.cwd(), 'src', 'core', 'AgentController.ts'), 'utf-8');
    assert((ac.match(/createDomainClassifierLLM\(this\.providerFactory, \(\) => this\.agentLoop\.getClassifierModel\(\)\)/g) || []).length === 2, 'AgentController passa uma função, não o valor do boot');

    console.log('\n=== S364-7 — o assistente aplica a escolha a tudo; o painel não grava modelo embutido ===');
    const pub = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), 'src', 'dashboard', 'public', ...p), 'utf-8');
    const cw = pub('config', 'components', 'ConfigWizard.js');
    assert((cw.match(/aplicarModeloATudo\(/g) || []).length >= 3, 'Ollama, OpenAI-compatível e provedor nativo chamam aplicarModeloATudo');
    assert(/aplicarModeloATudo\(file, \{ visao: 'mesmo_modelo' \}\)/.test(pub('config', 'views', 'ModelosView.js')), 'o caminho do modelo local usa a mesma função');
    const mv = pub('config', 'views', 'ModelosView.js');
    const fn = mv.slice(mv.indexOf('export function aplicarModeloATudo'), mv.indexOf('export async function ensureLocalProvider'));
    assert(/\['classifierModel', 'plannerModel', 'riskModel', 'observerModel'\]/.test(fn) && /provider_\$\{cat\}`\] = ''/.test(fn), 'aplicarModeloATudo cobre os 4 componentes internos e limpa os provedores por perfil');
    assert(!/\|\|\s*'[^']*(:|-)cloud'/.test(pub('config', 'app.js')), 'app.js não usa mais um modelo de nuvem como valor padrão (gravava glm-5.2:cloud quando vazio)');
    const cfg = fs.readFileSync(path.join(process.cwd(), 'src', 'dashboard', 'routes', 'config.ts'), 'utf-8');
    assert(/'PERMITIR_NUVEM_COMO_RESERVA': ctx\.config\.allowCloudFallback/.test(cfg) && /process\.env\.PERMITIR_NUVEM_COMO_RESERVA = allowCloudFallback/.test(cfg), 'a opção do painel é gravada e vale na hora');

    if (permitirOrig === undefined) delete process.env.PERMITIR_NUVEM_COMO_RESERVA; else process.env.PERMITIR_NUVEM_COMO_RESERVA = permitirOrig;
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S364 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    if (failed > 0) process.exitCode = 1;
}
main().catch((err) => { console.error('S364 erro inesperado:', err); process.exitCode = 1; });
