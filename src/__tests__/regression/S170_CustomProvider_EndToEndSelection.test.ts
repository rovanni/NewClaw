/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S170
 * Provider OpenAI-Compatible (LM Studio / vLLM / llamafile / OpenAI / servidor próprio) é
 * alcançável de ponta a ponta: escolhê-lo realmente manda a requisição para o endereço dele.
 *
 * CONTEXTO (relato real do usuário, 2026-08-01): "não consegui o sistema para funcionar com o
 * llamafile, o sistema não tem como selecionar os modelos". A investigação encontrou TRÊS
 * defeitos encadeados, todos anteriores à seleção de modelo em si — nenhuma combinação de
 * configuração na UI conseguia fazer uma requisição chegar num endpoint custom:
 *
 *   1. ProviderFactory.getProviderWithModel() tinha `case` só para os 6 providers nativos.
 *      Qualquer label custom caía no fall-through `return new OllamaProvider(...)`. Como todo
 *      perfil do ModelProfileRegistry já nasce com um modelo preenchido, `modelOverride` é
 *      sempre truthy e chatWithFallback() SEMPRE passa por esse caminho para o provider
 *      primário — ou seja, o provider custom era inalcançável na prática, mesmo registrado
 *      corretamente no Map (que foi o que a S164 garantiu).
 *
 *   2. getFallbackOrder() ignorava this.defaultProvider: a ordem começava sempre em 'ollama'.
 *      O <select> "Provider padrão" do dashboard gravava no config e não tinha efeito nenhum.
 *
 *   3. Os 6 perfis do DEFAULT_CONFIG do ModelProfileRegistry vinham com provider:'ollama'
 *      hardcoded, contradizendo o contrato declarado na própria interface ModelProfile
 *      ("provider?: string; // undefined = defaultProvider"). Como o AgentLoop passa
 *      chatProfile.provider como `preferred`, esse valor fixo sobrescrevia o defaultProvider
 *      em toda requisição — anulando também a correção do defeito 2 sozinha.
 *
 * REGRESSÃO SE: um provider custom voltar a ser resolvido como OllamaProvider; defaultProvider
 * voltar a ser ignorado na ordem de fallback; ou os perfis default voltarem a fixar um provider.
 *
 * Execução: npx ts-node src/__tests__/regression/S170_CustomProvider_EndToEndSelection.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { ProviderFactory, OpenAIProvider, OllamaProvider } from '../../core/ProviderFactory';
import { ModelProfileRegistry } from '../../loop/ModelProfileRegistry';
import { guessCapabilities } from '../../core/modelCapabilityHeuristics';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

const CUSTOM_URL = 'http://localhost:8080/v1';

console.log('\n=== S170 — defeito 1: provider custom não é mais resolvido como Ollama ===');
{
    const pf = new ProviderFactory({
        defaultProvider: 'meu-endpoint',
        ollamaUrl: 'http://localhost:11434',
        customProviders: [{ label: 'meu-endpoint', baseUrl: CUSTOM_URL }],
    });

    const p = pf.getProviderWithModel('qualquer-modelo', 'meu-endpoint');
    assert(!(p instanceof OllamaProvider), 'NÃO retorna um OllamaProvider (era o bug: caía no fall-through)');
    assert(p instanceof OpenAIProvider, `retorna um OpenAIProvider (obtido: ${p.constructor.name})`);
    assert(
        (p as OpenAIProvider).getBaseUrl() === CUSTOM_URL,
        `aponta para o endereço do usuário (obtido: ${(p as OpenAIProvider).getBaseUrl()})`
    );
    assert((p as OpenAIProvider).getLabel() === 'meu-endpoint', 'preserva a label do provider custom');
}

console.log('\n=== S170 — defeito 1: precedência de modelo (override > config fixa > placeholder) ===');
{
    const pf = new ProviderFactory({
        defaultProvider: 'ollama',
        customProviders: [{ label: 'com-modelo', baseUrl: CUSTOM_URL, model: 'modelo-da-config' }],
    });

    // A escolha por categoria do Model Router vence a config fixa — mesma precedência dos nativos.
    const comOverride = pf.getProviderWithModel('modelo-escolhido', 'com-modelo') as unknown as { model: string };
    assert(comOverride.model === 'modelo-escolhido', `override do Model Router vence (obtido: ${comOverride.model})`);

    // Sem override, cai na config do provider (quem hospeda um modelo só e nunca escolheu nada).
    const semOverride = pf.getProviderWithModel('', 'com-modelo') as unknown as { model: string };
    assert(semOverride.model === 'modelo-da-config', `sem override usa o model da config (obtido: ${semOverride.model})`);

    // Nem override nem config: placeholder aceito por servidores de modelo único (llamafile).
    pf.addCustomProvider({ label: 'sem-modelo', baseUrl: CUSTOM_URL });
    const semNada = pf.getProviderWithModel('', 'sem-modelo') as unknown as { model: string };
    assert(semNada.model === 'default', `sem nada usa o placeholder 'default' (obtido: ${semNada.model})`);
}

console.log('\n=== S170 — defeito 1: apiKey opcional (servidor local sem autenticação) ===');
{
    const pf = new ProviderFactory({ defaultProvider: 'ollama' });
    pf.addCustomProvider({ label: 'local-sem-key', baseUrl: CUSTOM_URL });
    const p = pf.getProviderWithModel('m', 'local-sem-key');
    assert(p instanceof OpenAIProvider, 'provider sem apiKey continua sendo resolvido (não lança nem cai no Ollama)');
}

console.log('\n=== S170 — defeito 1: remover o provider limpa também a config guardada ===');
{
    const pf = new ProviderFactory({
        defaultProvider: 'ollama',
        ollamaUrl: 'http://localhost:11434',
        customProviders: [{ label: 'temporario', baseUrl: CUSTOM_URL }],
    });
    pf.removeCustomProvider('temporario');
    const p = pf.getProviderWithModel('m', 'temporario');
    assert(
        p instanceof OllamaProvider,
        'depois de removido volta ao fallback padrão (customConfigs não guarda provider morto)'
    );
}

console.log('\n=== S170 — defeito 2: defaultProvider define quem é tentado primeiro ===');
{
    const pf = new ProviderFactory({
        defaultProvider: 'meu-endpoint',
        ollamaUrl: 'http://localhost:11434',
        customProviders: [{ label: 'meu-endpoint', baseUrl: CUSTOM_URL }],
    });
    // getFallbackOrder é privado — exercitado pelo comportamento observável equivalente.
    const order = (pf as unknown as { getFallbackOrder(p?: string): string[] }).getFallbackOrder();
    assert(order[0] === 'meu-endpoint', `provider padrão vem primeiro (obtido: [${order.join(',')}])`);
    assert(order.includes('ollama'), 'os demais continuam na ordem, como fallback — nada é descartado');
    assert(new Set(order).size === order.length, 'nenhum provider duplicado na ordem');
}

console.log('\n=== S170 — defeito 2: preferred explícito ainda vence o defaultProvider ===');
{
    const pf = new ProviderFactory({
        defaultProvider: 'meu-endpoint',
        ollamaUrl: 'http://localhost:11434',
        customProviders: [{ label: 'meu-endpoint', baseUrl: CUSTOM_URL }],
    });
    const order = (pf as unknown as { getFallbackOrder(p?: string): string[] }).getFallbackOrder('ollama');
    assert(order[0] === 'ollama', `Provider por perfil (preferred) tem prioridade sobre o padrão (obtido: [${order.join(',')}])`);
}

console.log('\n=== S170 — defeito 2: retrocompatibilidade com DEFAULT_PROVIDER=ollama ===');
{
    const pf = new ProviderFactory({ defaultProvider: 'ollama', ollamaUrl: 'http://localhost:11434' });
    const order = (pf as unknown as { getFallbackOrder(p?: string): string[] }).getFallbackOrder();
    assert(order[0] === 'ollama', `ordem idêntica à anterior para quem usa Ollama (obtido: [${order.join(',')}])`);
}

console.log('\n=== S170 — defeito 3: perfis default não fixam provider (herdam o padrão) ===');
{
    const registry = new ModelProfileRegistry();
    const categorias = ['chat', 'code', 'vision', 'light', 'analysis', 'execution'] as const;
    for (const cat of categorias) {
        const profile = registry.getProfileByCategory(cat);
        assert(
            profile !== undefined && profile.provider === undefined,
            `perfil '${cat}' não fixa provider — herda o padrão (obtido: ${profile?.provider ?? 'undefined'})`
        );
    }
}

console.log('\n=== S170 — defeito 3: PROVIDER_<CATEGORIA> explícito continua sobrescrevendo ===');
{
    const registry = new ModelProfileRegistry({ provider_chat: 'meu-endpoint' } as never);
    const chat = registry.getProfileByCategory('chat');
    assert(chat?.provider === 'meu-endpoint', `Provider por perfil ainda vale (obtido: ${chat?.provider})`);
    const code = registry.getProfileByCategory('code');
    assert(code?.provider === undefined, 'categorias não configuradas seguem herdando o padrão');
}

console.log('\n=== S170 — source: teste de conexão reusa o discovery existente, sem rede nova ===');
{
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'dashboard', 'routes', 'providers.ts'), 'utf-8');
    const rota = src.slice(src.indexOf("router.post('/providers/test'"), src.indexOf("router.post('/providers/custom'"));
    assert(rota.length > 0, "rota POST /providers/test existe");
    assert(
        rota.includes('discoverModels()'),
        'reusa OpenAIProvider.discoverModels() — mesmo GET /models do catálogo, nenhuma lógica de rede duplicada'
    );
    assert(!/fetch\s*\(/.test(rota), 'não faz fetch próprio (senão seriam dois caminhos para o mesmo endpoint)');
    assert(
        !rota.includes('ctx.config.customProviders') && !rota.includes('persistConfigToEnv'),
        'testar não persiste nada — nem config, nem provider vivo'
    );
    assert(
        rota.includes('PROVIDER_TEST_TIMEOUT_MS'),
        'tem teto de tempo (host que aceita conexão e nunca responde não pendura o dashboard)'
    );
    assert(
        rota.includes('online: false'),
        'endpoint fora do ar devolve resultado de teste (online:false), não erro de rota'
    );
}

console.log('\n=== S170 — source: escolher um modelo grava o PAR (modelo, provider) ===');
{
    const view = fs.readFileSync(
        path.join(process.cwd(), 'src', 'dashboard', 'public', 'config', 'views', 'ModelosView.js'), 'utf-8'
    );
    assert(
        view.includes('data-model-provider='),
        'cada linha do catálogo carrega o provider de origem do modelo (ModelInfo.provider)'
    );
    assert(
        /mr\[`provider_\$\{routingSelectedCategory\}`\]\s*=/.test(view),
        'o Aplicar grava o provider da categoria junto com o modelo — não descarta mais essa informação'
    );
    assert(
        view.includes('routingPendingProvider'),
        'a seleção pendente carrega o provider junto com o modelo (o mesmo nome pode existir em endpoints diferentes)'
    );

    // Achado na execução real (etapa 4 da Validação Progressiva, 2026-08-01): limpar o override
    // gravando `undefined` NÃO limpava nada. POST /api/config funde com {...antigo, ...novo} e
    // JSON.stringify descarta chaves undefined — a chave nem chegava ao servidor, o PROVIDER_<CAT>
    // antigo sobrevivia no .env, e a tela ainda por cima mostrava "Herdando" (mentira visível).
    // Nenhum teste com mock pegaria isto: o mock não passa por JSON.stringify nem pelo merge.
    assert(
        !/mr\[`provider_\$\{[^}]+\}`\]\s*=[^;]*undefined/.test(view),
        'nunca grava `undefined` num provider_<categoria> — some no JSON.stringify e o override antigo sobrevive'
    );
    assert(
        /routingPendingProvider === def \? '' :/.test(view),
        "limpar o override usa string vazia (falsy em persistConfigToEnv e no ModelProfileRegistry = 'sem override')"
    );
}

console.log('\n=== S170 — source: a UI não perde o health que o servidor já manda ===');
{
    // Achados na execução real (2026-08-01): GET /api/providers devolve `health` de todo provider
    // descoberto, mas api.js retornava só `d.providers` — o campo era descartado antes de chegar
    // ao store. Consequências visíveis: card de provider custom preso em "—" para sempre, e a
    // Visão Geral sem como reportar nada que não fosse o Ollama.
    const api = fs.readFileSync(
        path.join(process.cwd(), 'src', 'dashboard', 'public', 'config', 'api.js'), 'utf-8'
    );
    const fn = api.slice(api.indexOf('export async function getProviders'), api.indexOf('export async function pullModel'));
    assert(!/return d\.providers/.test(fn), 'getProviders() não descarta mais health/currentModel devolvendo só d.providers');

    const app = fs.readFileSync(
        path.join(process.cwd(), 'src', 'dashboard', 'public', 'config', 'app.js'), 'utf-8'
    );
    const loader = app.slice(app.indexOf('export async function loadProviders'), app.indexOf('async function loadTools'));
    assert(/health\s*=\s*resp\.health/.test(loader), 'loadProviders() publica o health real no providersStore');
    assert(
        !/ollamaModelCount:\s*models\.length\s*,/.test(loader),
        'contagem do Ollama vem do discovery (health.modelCount), não do tamanho da lista de nomes do autocomplete'
    );

    const view = fs.readFileSync(
        path.join(process.cwd(), 'src', 'dashboard', 'public', 'config', 'views', 'ModelosView.js'), 'utf-8'
    );
    assert(
        view.includes('function activeProviderHealth'),
        'Visão Geral consulta a saúde do provider ATIVO — não assume Ollama quando o padrão é outro'
    );
}

console.log('\n=== S170 — modelos locais: nenhum caminho embutido no código (projeto OSS multiplataforma) ===');
{
    // O usuário informa a pasta; o projeto roda em Windows, Linux e macOS e é público no GitHub.
    // Um caminho de exemplo real embutido vazaria o ambiente de quem escreveu e não funcionaria
    // para mais ninguém. REGRESSÃO SE: alguém "ajudar" pondo um default plausível.
    const files = [
        path.join('src', 'dashboard', 'routes', 'models.ts'),
        path.join('src', 'dashboard', 'public', 'config', 'views', 'ModelosView.js'),
        path.join('src', 'dashboard', 'public', 'config', 'state.js'),
        path.join('src', 'index.ts'),
    ];
    for (const f of files) {
        const src = fs.readFileSync(path.join(process.cwd(), f), 'utf-8');
        // Caminho absoluto de Windows (C:\algo, D:/algo) ou home de Unix (/home/<user>, /Users/<user>)
        const hardcoded = src.match(/["'`][A-Za-z]:[\\/][^"'`\n]+["'`]|["'`]\/(?:home|Users)\/[^"'`\n]+["'`]/g) || [];
        // Placeholders de i18n mostram um exemplo de FORMATO ao usuário e vivem em shared.js —
        // nenhum arquivo desta lista deveria conter um caminho absoluto.
        assert(hardcoded.length === 0, `${f}: nenhum caminho absoluto embutido (achado: ${hardcoded.join(', ') || 'nenhum'})`);
    }

    const models = fs.readFileSync(path.join(process.cwd(), 'src', 'dashboard', 'routes', 'models.ts'), 'utf-8');
    const rota = models.slice(models.indexOf("router.get('/local'"));
    assert(rota.length > 0, 'rota GET /models/local existe');
    assert(
        rota.includes('configured: false'),
        'sem pasta configurada devolve "não configurado" — não tenta adivinhar um local plausível'
    );
    assert(
        rota.includes('guessCapabilities'),
        'capacidades vêm da mesma heurística já usada pelos endpoints OpenAI-Compatible, sem regra nova'
    );
    assert(
        rota.includes('COMPANION_FILE_PREFIXES'),
        'projetores multimodais (mmproj-*) ficam fora da lista — não são modelos servíveis sozinhos'
    );
    assert(
        rota.includes('servedIds') && rota.includes('getCatalog'),
        '"em uso agora" é cruzado com o discovery real dos providers, não inferido'
    );
}

console.log('\n=== S170 — heurística de visão cobre a família GLM multimodal ===');
{
    const caps = guessCapabilities('GLM-4.6V-Flash-Q3_K_M.gguf');
    assert(caps.includes('vision'), `GLM-4.6V reconhecido como visão (obtido: ${caps.join(',')})`);
    const vl = guessCapabilities('Qwen3VL-8B-Instruct-Q4_K_M.gguf');
    assert(vl.includes('vision'), `Qwen3VL continua reconhecido (obtido: ${vl.join(',')})`);
    const semVisao = guessCapabilities('gemma-4-26B-A4B-it-Q4_K_M.gguf');
    assert(!semVisao.includes('vision'), `modelo de texto não ganha visão por engano (obtido: ${semVisao.join(',')})`);
    const glmTexto = guessCapabilities('glm-5.2:cloud');
    assert(!glmTexto.includes('vision'), `GLM sem sufixo V não vira modelo de visão (obtido: ${glmTexto.join(',')})`);
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S170 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
console.log(`\nCOBERTURA:`);
console.log(`  Resolução de provider custom com modelo (defeito 1): testado`);
console.log(`  Precedência de modelo e limpeza ao remover: testado`);
console.log(`  defaultProvider na ordem de fallback + retrocompat (defeito 2): testado`);
console.log(`  Perfis herdando provider + override explícito (defeito 3): testado`);
console.log(`  Rota de teste de conexão reusando o discovery: testado`);
console.log(`  Seleção gravando o par (modelo, provider): testado`);
if (failed > 0) process.exit(1);
