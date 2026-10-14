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

    // 14/10/2026 (ADR-018, diretiva da mantenedora: nenhum fallback): a cadeia passou a ter só o provedor declarado, e o
    // problema do item 2 (dois rótulos no mesmo servidor gastando duas tentativas) deixou de existir pela raiz — não há
    // segunda tentativa. Saíram `dedupeByEndpoint`/`endpointKey`; S190.1–.4 provam agora a cadeia única, e o painel
    // continua avisando da colisão (checkDuplicateEndpoints), que ainda confunde quem configura.
    console.log('\n--- S190.1 — o caso do operador: dois rótulos, um servidor — só o declarado é chamado ---');
    {
        const f = makeFactory([
            { label: 'Modelo local', baseUrl: 'http://127.0.0.1:8080/v1' },
            { label: 'llamafile',    baseUrl: 'http://127.0.0.1:8080/v1' },
        ], 'Modelo local');
        const order = fallbackOrder(f);
        assert(order.length === 1 && order[0] === 'Modelo local', 'a cadeia é só o provedor declarado — nem o rótulo duplicado nem o Ollama', order);
    }

    console.log('\n--- S190.2 — vale para qualquer combinação de endereços e credenciais ---');
    {
        const casos: Array<[string, string, string | undefined, string | undefined]> = [
            ['http://localhost:8080/v1', 'http://127.0.0.1:8080/v1', undefined, undefined],
            ['http://127.0.0.1:8080/v1', 'http://127.0.0.1:8081/v1', undefined, undefined],
            ['https://gateway.exemplo/v1', 'https://gateway.exemplo/v1', 'chave-a', 'chave-b'],
        ];
        for (const [a, b, ka, kb] of casos) {
            const order = fallbackOrder(makeFactory([{ label: 'A', baseUrl: a, apiKey: ka }, { label: 'B', baseUrl: b, apiKey: kb }], 'A'));
            assert(order.length === 1 && order[0] === 'A', `${a} × ${b}: só o declarado`, order);
        }
    }

    console.log('\n--- S190.3 — provedor declarado sem configuração: lista vazia, nenhum outro no lugar ---');
    {
        const order = (makeFactory([{ label: 'A', baseUrl: 'http://127.0.0.1:8080/v1' }], 'A') as any).getFallbackOrder('nao-configurado');
        assert(Array.isArray(order) && order.length === 0, 'pedir um provedor que não existe não cai no padrão nem no primeiro disponível', order);
    }

    console.log('\n--- S190.4 — a deduplicação saiu do motor; o aviso de endereço duplicado continua no painel ---');
    {
        const fs = require('fs');
        const path = require('path');
        const pfSrc: string = fs.readFileSync(path.join(__dirname, '../../core/ProviderFactory.ts'), 'utf-8');
        const uiSrc: string = fs.readFileSync(path.join(__dirname, '../../dashboard/public/config/views/ModelosView.js'), 'utf-8');
        const semComentarios = pfSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
        assert(!/dedupeByEndpoint|endpointKey/.test(semComentarios), 'sem cadeia de reserva, não há o que deduplicar no motor');
        assert(/checkDuplicateEndpoints/.test(uiSrc), 'o painel ainda avisa de dois rótulos no mesmo endereço');
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
