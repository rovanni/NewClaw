/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S485: o 2º julgamento (revalidação da resposta parcial) leva o traceId, a conversa e o goal do 1º.
 *
 * Origem: medição de 17/11/2026 no Windows (03–16/11): 43 revalidações parciais no gravador de voo, TODAS sem conversationId e sem
 * traceId — `trySynthesizePartialResponse` chamava o juiz só com a fase, o pedido e as mensagens. Não dava para ligar cada reescrita
 * ao julgamento que a causou, nem saber quantas vieram de "não avaliável sem contradição".
 *
 * REGRESSÃO SE: a revalidação parcial voltar a chamar o juiz sem o traceId/conversationId/goal do julgamento que a pediu.
 *
 * Execução: npx ts-node src/__tests__/regression/S485_RevalidacaoParcialLigadaAoJulgamento.test.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { AgentLoop } from '../../loop/AgentLoop';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

type Sintese = (...a: unknown[]) => Promise<string | null>;
const sintese = (AgentLoop.prototype as unknown as { trySynthesizePartialResponse: Sintese }).trySynthesizePartialResponse;

function falso(capturado: { ctx?: Record<string, unknown> }) {
    return {
        profileRegistry: { getProfileByCategory: () => ({ id: 'execution' }) },
        callLLMWithFallback: async () => ({ status: 'success', content: 'O preço confirmado é 1,17.' }),
        observer: { validateGrounding: async (_t: string, _e: unknown, _s: unknown, ctx: Record<string, unknown>) => { capturado.ctx = ctx; return { state: 'VALIDATED' }; } },
        ts: () => '00:00:00',
    };
}

async function main(): Promise<void> {
    console.log('\n=== S485-1 — a revalidação recebe o contexto do julgamento que a pediu ===');
    {
        const cap: { ctx?: Record<string, unknown> } = {};
        const contexto = { traceId: 'tr-485', conversationId: 'telegram:1', goalId: 'g485', stepId: 's1', stepDescription: 'Cotar', planGeneration: 2 };
        const r = await sintese.call(falso(cap), 'Qual o preço?', [{ claim: 'preço é 1,17', verdict: 'SUPPORTED', evidence: ['E1'] }], [], undefined, undefined, [], contexto);
        assert(r === 'O preço confirmado é 1,17.', 'a síntese segue entregue como antes', r);
        const c = cap.ctx ?? {};
        assert(c.phase === 'partial-revalidation' && c.userRequest === 'Qual o preço?', 'fase e pedido continuam indo', c);
        assert(c.traceId === 'tr-485' && c.conversationId === 'telegram:1', 'traceId e conversa do 1º julgamento chegam ao 2º', c);
        assert(c.goalId === 'g485' && c.stepId === 's1' && c.planGeneration === 2, 'goal, passo e geração do plano também', c);
    }
    {
        const cap: { ctx?: Record<string, unknown> } = {};
        await sintese.call(falso(cap), 'Qual o preço?', [{ claim: 'preço é 1,17', verdict: 'SUPPORTED', evidence: ['E1'] }], [], undefined, undefined, []);
        assert(cap.ctx?.phase === 'partial-revalidation' && cap.ctx?.traceId === undefined, 'controle: sem o contexto, a revalidação sai sem traceId (o defeito medido)', cap.ctx);
    }

    console.log('\n=== S485-2 — o commitResponse passa o contexto do julgamento ===');
    {
        const fonte = fs.readFileSync(path.join(__dirname, '../../loop/AgentLoop.ts'), 'utf-8');
        const i = fonte.indexOf('const partial = await this.trySynthesizePartialResponse(');
        const chamada = fonte.slice(i, fonte.indexOf(');', i));
        assert(i > 0 && /traceId: trace\.id/.test(chamada) && /conversationId/.test(chamada) && /channelContext\?\.goalTrace/.test(chamada),
            'a chamada da síntese leva traceId do turno, conversa e goalTrace', chamada);
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S485 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
    console.error('S485 erro inesperado:', err);
    process.exitCode = 1;
});
