/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S190
 *
 * Dois defeitos reportados pelo operador em 04/08/2026, ambos com evidência no log de produção
 * (`logs/newclaw-audit.log` da instalação dele).
 *
 * ── 1. "Cliquei em Carregar agora e a mensagem não some" ────────────────────────────────────
 * Linha do tempo real: 13:11:27 `Subindo servidor local: ... (GLM-4.6V-Flash-Q3_K_M.gguf)` →
 * 503 "Loading model" → 13:14:14 `Servidor local pronto: ... em http://127.0.0.1:8080/v1`.
 * O modelo carregou. A tela é que não percebeu: a última descoberta de provedores foi às
 * 13:13:44 (ainda 503, offline) e NENHUMA rodou depois.
 *
 * Causa: `loadProviders(forceRefresh)` recebia o parâmetro, seis pontos de chamada passavam
 * `true` (um deles com o comentário "catálogo e saúde refletem o modelo recém-carregado") — e
 * ele nunca chegava a lugar nenhum: `getProviders()` era chamado sem argumento, a rota não lia
 * nada da query, e `getCatalog()` respondia do cache de 30s com `getLastHealth()` da descoberta
 * ANTERIOR. Um parâmetro morto no meio do caminho.
 *
 * ── 2. "Dois provedores no mesmo endereço" ──────────────────────────────────────────────────
 * `providers=[Modelo local,ollama,llamafile]` no log, com `Modelo local` e `llamafile` ambos em
 * 127.0.0.1:8080 — três nomes, dois endereços. A tela já avisava da colisão
 * (`checkDuplicateEndpoints`), mas o motor continuava tratando os dois como opções independentes
 * de fallback: com o servidor local fora do ar, duas das três tentativas eram a mesma tentativa,
 * cada uma gastando seu próprio timeout de conexão.
 *
 * Execução: npx ts-node src/__tests__/regression/S190_ProviderEndpointIdentity_AndFreshHealth.test.ts
 */

import { ProviderFactory } from '../../core/ProviderFactory';

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string, detail?: unknown): void {
    if (cond) { console.log(`  OK ${msg}`); passed++; }
    else { console.error(`  FALHOU: ${msg}`, detail ?? ''); failed++; }
}

function makeFactory(customProviders: Array<{ label: string; baseUrl: string; apiKey?: string; model?: string }>, defaultProvider: string) {
    return new ProviderFactory({
        defaultProvider,
        ollamaUrl: 'http://localhost:11434',
        ollamaModel: 'test',
        customProviders,
    } as any);
}

function fallbackOrder(f: ProviderFactory): string[] {
    return (f as any).getFallbackOrder();
}

async function main() {
    console.log('\n=== S190 — identidade de endpoint no fallback + saúde fresca após carregar modelo ===');

    console.log('\n--- S190.1 — o caso do operador: dois rótulos, um servidor ---');
    {
        const f = makeFactory([
            { label: 'Modelo local', baseUrl: 'http://127.0.0.1:8080/v1' },
            { label: 'llamafile',    baseUrl: 'http://127.0.0.1:8080/v1' },
        ], 'Modelo local');
        const order = fallbackOrder(f);

        assert(order.includes('Modelo local'), 'o provedor padrão declarado pelo usuário permanece', order);
        assert(!order.includes('llamafile'),
            'o segundo rótulo do MESMO endpoint sai da cadeia — não oferece resiliência nenhuma', order);
        assert(order.includes('ollama'),
            'provedor de endpoint diferente continua na cadeia (o fallback real não é afetado)', order);
    }

    console.log('\n--- S190.2 — equivalências garantidas (e só elas) ---');
    {
        const casos: Array<[string, string, boolean, string]> = [
            ['http://localhost:8080/v1', 'http://127.0.0.1:8080/v1', true,  'localhost e 127.0.0.1 são o mesmo host'],
            ['http://127.0.0.1:8080/v1/', 'http://127.0.0.1:8080/v1', true,  'barra final não muda o destino'],
            ['HTTP://127.0.0.1:8080/V1', 'http://127.0.0.1:8080/v1', true,  'caixa não muda o destino'],
            ['https://127.0.0.1:8080/v1', 'http://127.0.0.1:8080/v1', true,  'esquema não distingue o alvo aqui'],
            ['http://127.0.0.1:8080/v1', 'http://127.0.0.1:8081/v1', false, 'portas diferentes são servidores diferentes'],
            ['http://meu-servidor:8080/v1', 'http://127.0.0.1:8080/v1', false, 'nome de máquina não é assumido como equivalente sem DNS'],
        ];
        for (const [a, b, mesmo, porque] of casos) {
            const f = makeFactory([{ label: 'A', baseUrl: a }, { label: 'B', baseUrl: b }], 'A');
            const order = fallbackOrder(f);
            const colapsou = !order.includes('B');
            assert(colapsou === mesmo, `${porque} → ${mesmo ? 'colapsa' : 'mantém os dois'}`, order);
        }
    }

    console.log('\n--- S190.3 — credencial faz parte da identidade ---');
    {
        // Dois rótulos no mesmo gateway com chaves diferentes são CONTAS diferentes e podem se
        // cobrir mutuamente — colapsá-los removeria um fallback legítimo.
        const f = makeFactory([
            { label: 'conta-a', baseUrl: 'https://gateway.exemplo/v1', apiKey: 'chave-a' },
            { label: 'conta-b', baseUrl: 'https://gateway.exemplo/v1', apiKey: 'chave-b' },
        ], 'conta-a');
        const order = fallbackOrder(f);
        assert(order.includes('conta-a') && order.includes('conta-b'),
            'mesmo endpoint com credenciais diferentes mantém os dois na cadeia', order);

        const f2 = makeFactory([
            { label: 'igual-1', baseUrl: 'https://gateway.exemplo/v1', apiKey: 'mesma' },
            { label: 'igual-2', baseUrl: 'https://gateway.exemplo/v1', apiKey: 'mesma' },
        ], 'igual-1');
        assert(!fallbackOrder(f2).includes('igual-2'),
            'mesmo endpoint E mesma credencial colapsa — é comprovadamente o mesmo caminho', fallbackOrder(f2));
    }

    console.log('\n--- S190.4 — painel e motor enxergam a colisão pela MESMA regra ---');
    {
        // A tela avisa (checkDuplicateEndpoints) e o motor decide (dedupeByEndpoint). Se as duas
        // normalizações divergirem, um diz uma coisa e o outro faz outra — o pior dos dois mundos.
        const fs = require('fs');
        const path = require('path');
        const uiSrc: string = fs.readFileSync(path.join(__dirname, '../../dashboard/public/config/views/ModelosView.js'), 'utf-8');
        const m = uiSrc.match(/const chave = url =>([\s\S]*?);\n/);
        assert(!!m, 'a regra de normalização do painel foi localizada no fonte');
        if (m) {
            // eslint-disable-next-line no-new-func
            const chaveUI = new Function('url', `return (${m[1].trim()})`) as (u: string) => string;
            const coreKey = (u: string) => (ProviderFactory as any).endpointKey(u, '').replace(/\|$/, '');
            for (const u of [
                'http://localhost:8080/v1', 'http://127.0.0.1:8080/v1/', 'HTTPS://Localhost:8080/V1',
                'http://meu-servidor:8080/v1', 'http://127.0.0.1:8081',
            ]) {
                assert(chaveUI(u) === coreKey(u),
                    `painel e motor normalizam "${u}" para a mesma chave`, { ui: chaveUI(u), core: coreKey(u) });
            }
        }
    }

    console.log('\n--- S190.5 — a rota realmente força a redescoberta quando pedem ---');
    {
        // Exercita o handler de verdade com um ModelRegistryService falso que registra COMO foi
        // chamado — nada de inferir por tempo de resposta (endpoint local responde rápido demais
        // para distinguir cache de descoberta) nem por leitura de fonte.
        const { createProvidersRouter } = require('../../dashboard/routes/providers');
        const chamadas: boolean[] = [];
        const ctx = {
            config: {},
            modelRegistryService: {
                getCatalog: async (force?: boolean) => { chamadas.push(!!force); return []; },
                getLastHealth: () => [{ provider: 'x', online: true }],
            },
        };
        const router = createProvidersRouter(ctx as any);
        const layer = router.stack.find((l: any) => l.route?.path === '/providers');
        const handler = layer.route.stack[0].handle;

        const rodar = async (query: Record<string, string>) => {
            await handler({ query } as any, { json: () => {} } as any, () => {});
        };

        await rodar({});
        assert(chamadas[0] === false, 'sem parâmetro: pode responder do cache (comportamento de sempre)', chamadas);
        await rodar({ refresh: '1' });
        assert(chamadas[1] === true, '?refresh=1: força a redescoberta — a saúde reflete o mundo de AGORA', chamadas);
        await rodar({ refresh: 'true' });
        assert(chamadas[2] === true, '?refresh=true também é aceito (a UI pode evoluir sem quebrar a rota)', chamadas);
    }

    console.log('\n--- S190.6 — o pedido nasce no clique e chega até a rota ---');
    {
        const fs = require('fs');
        const path = require('path');
        const api: string = fs.readFileSync(path.join(__dirname, '../../dashboard/public/config/api.js'), 'utf-8');
        const app: string = fs.readFileSync(path.join(__dirname, '../../dashboard/public/config/app.js'), 'utf-8');

        assert(/getProviders\(forceRefresh = false\)[\s\S]*refresh=1/.test(api),
            'cliente: getProviders traduz o pedido para ?refresh=1');
        assert(/await getProviders\(forceRefresh\)/.test(app),
            'app.js: loadProviders repassa o parâmetro em vez de engoli-lo (era aqui que ele morria)');
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S190 RESULTADO: ${passed} passou | ${failed} falhou`);
    if (failed > 0) process.exit(1);
    process.exit(0);
}

main().catch(err => { console.error('Erro no teste S190:', err); process.exit(1); });
