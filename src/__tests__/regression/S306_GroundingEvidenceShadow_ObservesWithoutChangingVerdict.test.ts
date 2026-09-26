/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S306 (Sprint 3, issue 048)
 * Modo sombra do juiz de grounding com evidência ampliada (`GROUNDING_EVIDENCE_SHADOW=true`).
 * O julgamento real nunca muda; a sombra roda de novo em segundo plano com argumentos/evidência
 * maiores e o pedido do usuário como evidência `U1`, e vira UMA linha `[GROUNDING-SHADOW]`.
 *
 *   1 → flag desligada (padrão): uma única chamada ao juiz, nenhuma linha [GROUNDING-SHADOW].
 *   2 → flag ligada: segunda chamada com U1 (pedido do usuário) e argumentos maiores; a PRIMEIRA
 *       (a real) continua sem U1 e com os argumentos cortados em 200 chars.
 *   3 → o veredito real é idêntico com e sem a sombra e é devolvido ANTES de a sombra terminar.
 *   4 → o registro compara real × sombra (estado, contagens, o que continua não sustentado).
 *   5 → sem recursão: exatamente 2 chamadas ao juiz.
 *   6 → falha da sombra não afeta o veredito real nem lança.
 *   7 → sem pedido do usuário no contexto: não há sombra.
 *
 * Execução: npx ts-node src/__tests__/regression/S306_GroundingEvidenceShadow_ObservesWithoutChangingVerdict.test.ts
 */
process.env.WORKSPACE_DIR = process.env.WORKSPACE_DIR || 'D:/IA/newclaw/workspace';

import { ObserverValidator, EvidenceItem } from '../../loop/ObserverValidator';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

const realJson = JSON.stringify({ claims: [
    { claim: 'O teste usou a entrada abc', evidence: ['E1'], verdict: 'NOT_EVALUABLE' },
    { claim: 'O arquivo tem 204 linhas', evidence: ['E1'], verdict: 'SUPPORTED' },
] });
const shadowJson = JSON.stringify({ claims: [
    { claim: 'O teste usou a entrada abc', evidence: ['E1'], verdict: 'SUPPORTED' },
    { claim: 'O arquivo tem 204 linhas', evidence: ['E1'], verdict: 'SUPPORTED' },
] });

interface Harness { v: ObserverValidator; prompts: string[]; setShadowDelay(ms: number): void; failShadow(): void }
function harness(): Harness {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getBudgetAuxiliar } = require('../../shared/auxTimeout');
    const prompts: string[] = [];
    let shadowDelay = 0;
    let shadowFails = false;
    const factory = {
        chatWithFallback: async (messages: Array<{ content: string }>) => {
            prompts.push(messages[0].content);
            const isShadowCall = prompts.length > 1;
            if (isShadowCall) {
                if (shadowDelay) await new Promise(r => setTimeout(r, shadowDelay));
                if (shadowFails) throw new Error('provedor caiu na sombra');
            }
            return { status: 'success', content: isShadowCall ? shadowJson : realJson, attempts: [] };
        },
        getBudgetAuxiliar: (p: 'classificacao' | 'validacao') => getBudgetAuxiliar(p, null, null),
    } as unknown as import('../../core/ProviderFactory').ProviderFactory;
    return { v: new ObserverValidator(factory, 'm'), prompts, setShadowDelay: (ms) => { shadowDelay = ms; }, failShadow: () => { shadowFails = true; } };
}

async function captureLogs<T>(fn: () => Promise<T>, settleMs = 0): Promise<{ value: T; lines: string[] }> {
    const lines: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    (process.stdout.write as unknown) = (chunk: string | Uint8Array): boolean => { lines.push(String(chunk)); return true; };
    try {
        const value = await fn();
        if (settleMs) await new Promise(r => setTimeout(r, settleMs));
        return { value, lines };
    } finally { process.stdout.write = orig; }
}
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
const shadowRecords = (lines: string[]) => lines.map(strip).filter(l => l.includes('[GROUNDING-SHADOW] {'))
    .map(l => JSON.parse(l.slice(l.indexOf('[GROUNDING-SHADOW] ') + '[GROUNDING-SHADOW] '.length)));

const writeContent = 'linha de código\n'.repeat(200) + 'entrada_nao_numerica = "abc"\n';
const evidences: EvidenceItem[] = [
    { id: 'E1', tool: 'write', input: JSON.stringify({ path: 'teste.py', content: writeContent }), output: 'Criado: teste.py\nTamanho: 7392 chars | 204 linhas' },
];
const response = 'O teste usou a entrada abc e o arquivo tem 204 linhas.';
const ctx = { traceId: 't1', conversationId: 'c1', goalId: 'goal_x', stepId: 'step_2', phase: 'initial' as const, userRequest: 'Crie o programa e me envie o .py — PEDIDO-ORIGINAL' };

async function main(): Promise<void> {
    delete process.env.GROUNDING_EVIDENCE_SHADOW;

    console.log('\n=== S306-1 — flag desligada: uma chamada, nenhuma sombra ===');
    {
        const h = harness();
        const { lines } = await captureLogs(() => h.v.validateGrounding(response, evidences, undefined, ctx), 150);
        assert(h.prompts.length === 1, 'exatamente uma chamada ao juiz', h.prompts.length);
        assert(shadowRecords(lines).length === 0, 'nenhuma linha [GROUNDING-SHADOW]');
    }

    console.log('\n=== S306-2/4/5 — flag ligada: sombra com U1 e argumentos ampliados ===');
    process.env.GROUNDING_EVIDENCE_SHADOW = 'true';
    {
        const h = harness();
        const { value: real, lines } = await captureLogs(() => h.v.validateGrounding(response, evidences, undefined, ctx), 250);
        assert(h.prompts.length === 2, 'exatamente 2 chamadas ao juiz (real + sombra, sem recursão)', h.prompts.length);
        const [realPrompt, shadowPrompt] = h.prompts;
        assert(!realPrompt.includes('PEDIDO-ORIGINAL') && !realPrompt.includes('pedido_do_usuario'), 'o prompt REAL não recebe o pedido do usuário');
        assert(!realPrompt.includes('entrada_nao_numerica'), 'o prompt REAL continua com os argumentos cortados em 200 chars');
        assert(shadowPrompt.includes('PEDIDO-ORIGINAL') && shadowPrompt.includes('pedido_do_usuario'), 'o prompt da SOMBRA traz o pedido do usuário como evidência');
        assert(shadowPrompt.includes('entrada_nao_numerica'), 'o prompt da SOMBRA traz o conteúdo escrito (argumentos ampliados)');
        const rec = shadowRecords(lines)[0];
        assert(!!rec && rec.goalId === 'goal_x' && rec.stepId === 'step_2', 'registro com goalId/stepId', rec);
        assert(rec.realState === 'NOT_EVALUABLE' && rec.shadowState === 'VALIDATED' && rec.stateChanged === true, 'compara real × sombra: NOT_EVALUABLE → VALIDATED', rec);
        assert(rec.realCounts.NOT_EVALUABLE === 1 && rec.shadowCounts.NOT_EVALUABLE === 0, 'contagens por veredito', { r: rec.realCounts, s: rec.shadowCounts });
        assert(Array.isArray(rec.shadowNotSupported) && rec.shadowNotSupported.length === 0, 'nada resta não sustentado na sombra');
        assert(rec.addedEvidence.userRequestChars === ctx.userRequest.length, 'registra só o TAMANHO do pedido');
        assert(!JSON.stringify(rec).includes('PEDIDO-ORIGINAL'), 'o texto do pedido não vai para o log');
        assert(real.state === 'NOT_EVALUABLE', 'o veredito devolvido é o REAL (NOT_EVALUABLE)', real.state);
    }

    console.log('\n=== S306-3 — o real é idêntico e devolvido antes da sombra ===');
    {
        delete process.env.GROUNDING_EVIDENCE_SHADOW;
        const off = await captureLogs(() => harness().v.validateGrounding(response, evidences, undefined, ctx), 0);
        process.env.GROUNDING_EVIDENCE_SHADOW = 'true';
        const h = harness();
        h.setShadowDelay(400);
        const t0 = Date.now();
        const on = await captureLogs(() => h.v.validateGrounding(response, evidences, undefined, ctx), 0);
        const elapsed = Date.now() - t0;
        const norm = (x: { state: string; claims: unknown; reason: string }) => JSON.stringify({ s: x.state, c: x.claims, r: x.reason });
        assert(norm(off.value) === norm(on.value), 'mesmo estado, afirmações e motivo com e sem a sombra');
        assert(elapsed < 300, `validateGrounding voltou sem esperar a sombra de 400 ms (${elapsed} ms)`, elapsed);
        await new Promise(r => setTimeout(r, 600)); // não deixar a sombra pendurada
    }

    console.log('\n=== S306-6 — falha da sombra não afeta o real nem lança ===');
    {
        const h = harness();
        h.failShadow();
        let threw = false; let state = '';
        try { const { value } = await captureLogs(() => h.v.validateGrounding(response, evidences, undefined, ctx), 200); state = value.state; } catch { threw = true; }
        assert(!threw && state === 'NOT_EVALUABLE', 'o veredito real sai normalmente', { threw, state });
    }

    console.log('\n=== S306-7 — sem pedido do usuário no contexto: sem sombra ===');
    {
        const h = harness();
        const { userRequest: _omit, ...ctxSemPedido } = ctx;
        const { lines } = await captureLogs(() => h.v.validateGrounding(response, evidences, undefined, ctxSemPedido), 150);
        assert(h.prompts.length === 1 && shadowRecords(lines).length === 0, 'uma chamada e nenhum registro de sombra', h.prompts.length);
    }

    delete process.env.GROUNDING_EVIDENCE_SHADOW;
    console.log(`\nS306 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    if (failed > 0) process.exitCode = 1;
}
main().catch(e => { console.error(e); process.exitCode = 1; });
