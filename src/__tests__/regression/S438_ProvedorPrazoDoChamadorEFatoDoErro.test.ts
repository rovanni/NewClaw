/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S438
 * (1) A chamada sem streaming ao provedor compatível com OpenAI (modelo local) não fica sujeita ao limite de 300 s do
 *     `fetch` do Node para os cabeçalhos: quando o chamador tem prazo, o transporte não tem prazo próprio.
 * (2) Quando o provedor responde com erro, a mensagem diz O QUE ele respondeu — não "verifique se o serviço está em execução".
 * (3) Objetivo que vence o prazo PARADO à espera é relatado assim, não como "nova mensagem do usuário" (ADR-027: um goal em
 *     execução nunca vence — ver S426).
 *
 * INCIDENTES REAIS (Windows, 18/10/2026):
 *  - modelo local: 9 chamadas longas falharam entre 302,8 e 304,6 s com `fetch failed` com prazo do chamador maior.
 *    Medido (Node 24.20 e 22.23): servidor que responde aos 310 s → UND_ERR_HEADERS_TIMEOUT aos 303,9 s.
 *    O teste não espera 5 minutos: confere que o Agent passado ao fetch tem headersTimeout 0 e que a chamada real
 *    completa por ele; a medição longa está registrada na issue 066.
 *  - o Ollama respondeu HTTP 429 (limite de uso) e a usuária leu "Verifique se o serviço está em execução e acessível".
 *  - um objetivo do Telegram expirou aos 31 min e a usuária leu "nova mensagem do usuário recebida durante execução".
 *
 * Execução: npx ts-node src/__tests__/regression/S438_ProvedorPrazoDoChamadorEFatoDoErro.test.ts
 */
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import Database from 'better-sqlite3';
import { OpenAIProvider } from '../../core/OpenAIProvider';
import { GoalStore } from '../../loop/GoalStore';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

async function main(): Promise<void> {
    console.log('\n=== S438-1 — o transporte do modelo local segue o prazo do chamador ===');
    {
        const srv = http.createServer((req, res) => {
            if (req.url?.endsWith('/models')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[]}'); return; }
            setTimeout(() => {
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ choices: [{ message: { content: 'resposta do modelo local' } }] }));
            }, 1500);
        });
        await new Promise<void>(r => srv.listen(0, '127.0.0.1', () => r()));
        const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}/v1`;

        const fetchOriginal = globalThis.fetch;
        const vistos: Array<{ url: string; dispatcher?: unknown }> = [];
        globalThis.fetch = (async (url: any, init?: any) => { vistos.push({ url: String(url), dispatcher: init?.dispatcher }); return fetchOriginal(url, init); }) as typeof fetch;
        try {
            const p = new OpenAIProvider('', 'modelo.gguf', base, 'Modelo local');
            const comPrazo = await p.chat([{ role: 'user', content: 'oi' }], undefined, { signal: AbortSignal.timeout(20_000), timeoutMs: 20_000 });
            assert(comPrazo.content === 'resposta do modelo local', 'a chamada completa pelo transporte novo (fetch global + Agent do undici)', comPrazo);
            const chamada = vistos.find(v => v.url.endsWith('/chat/completions'));
            const agente = chamada?.dispatcher as object | undefined;
            const opcoes = agente ? (agente as any)[Object.getOwnPropertySymbols(agente).find(s => s.description === 'options') as symbol] : undefined;
            assert(!!agente && opcoes?.headersTimeout === 0, 'com prazo do chamador: Agent sem prazo de cabeçalho (headersTimeout 0)', opcoes);

            vistos.length = 0;
            await p.chat([{ role: 'user', content: 'oi' }]);
            assert(vistos.find(v => v.url.endsWith('/chat/completions'))?.dispatcher === undefined, 'sem prazo do chamador: vale o padrão do Node');
        } finally {
            globalThis.fetch = fetchOriginal;
            srv.close();
        }
    }

    console.log('\n=== S438-2 — a mensagem de falha diz o que o provedor respondeu ===');
    {
        const pf = fs.readFileSync(path.join(process.cwd(), 'src', 'core', 'ProviderFactory.ts'), 'utf-8');
        assert(!/Verifique se o serviço está em execução e acessível/.test(pf), 'sem a orientação fixa "verifique se o serviço está em execução"');
        assert(/Resposta da última tentativa: \$\{mascararSegredos\(/.test(pf), 'a última resposta do provedor entra na mensagem, com segredos mascarados');
        const op = fs.readFileSync(path.join(process.cwd(), 'src', 'core', 'OllamaProvider.ts'), 'utf-8');
        assert(/throw new Error\(`Ollama API error: \$\{response\.status\}\$\{explicacao \? ` — \$\{explicacao\}` : ''\}`\)/.test(op),
            'o erro do Ollama mantém o prefixo "Ollama API error: <status>" e acrescenta a explicação do servidor');
    }

    console.log('\n=== S438-3 — goal vencido parado à espera é relatado como tal ===');
    {
        const db = new (Database as any)(':memory:');
        const store = new GoalStore(db);
        const g = store.create({
            sessionKey: 'telegram:1', conversationId: 'c1', userIntent: 'Deu certo?', objective: 'Deu certo?', status: 'executing',
            currentPlan: [], attempts: [], blockers: [], toolsTried: [], strategiesTried: [], nextAction: null, cycleFocus: null,
            retryBudget: 5, replanBudget: 3, confidence: 0.85, requiresAuth: false, authorizationScope: [], pendingTxnId: null,
            expiresAt: Date.now() - 1000, completedAt: null, isConstruction: false, roadmap: [], currentMilestoneIndex: 0,
            allowRoadmapAdjustment: true, successCriteria: [], sentArtifacts: [],
        } as any);
        assert(store.expireStale() === 1, 'a varredura expira o goal vencido');
        assert(/parado à espera/.test(store.consumeAbandonReason(g.id) ?? ''), 'o motivo registrado é a espera vencida (não "nova mensagem")');
        assert(store.consumeAbandonReason(g.id) === undefined, 'o motivo é consumido uma vez só');
        db.close();
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S438 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
