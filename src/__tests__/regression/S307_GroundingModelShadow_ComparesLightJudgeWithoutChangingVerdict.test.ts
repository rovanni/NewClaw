/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S307 (Sprint 5, issue 048)
 * Modo sombra de MODELO do juiz de grounding (`GROUNDING_SHADOW_MODEL=<modelo>`): o mesmo julgamento —
 * mesma resposta, mesma evidência, mesmo prompt — roda de novo em segundo plano com OUTRO modelo, e o
 * resultado vira uma linha `[GROUNDING-SHADOW-MODEL]`. O veredito real nunca muda.
 *
 *   1 → variável vazia (padrão): uma única chamada, nenhuma linha.
 *   2 → ligada: 2 chamadas; a sombra usa o modelo configurado e o REAL continua no modelo do juiz;
 *       o prompt é IDÊNTICO nas duas (a única variável é o modelo).
 *   3 → o registro compara estado, contagens, modelos e tempos, e diz se os estados concordam.
 *   4 → o veredito real é idêntico com e sem a sombra e é devolvido ANTES dela terminar.
 *   5 → com as DUAS sombras ligadas (evidência ampliada + modelo): exatamente 3 chamadas (sem recursão).
 *   6 → falha da sombra não afeta o real nem lança.
 *   7 → a revalidação parcial (`partial-revalidation`) também é observada; sem contexto, nada é observado.
 *
 * Execução: npx ts-node src/__tests__/regression/S307_GroundingModelShadow_ComparesLightJudgeWithoutChangingVerdict.test.ts
 */
process.env.WORKSPACE_DIR = process.env.WORKSPACE_DIR || 'D:/IA/newclaw/workspace';

import { ObserverValidator, EvidenceItem } from '../../loop/ObserverValidator';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

const heavyJson = JSON.stringify({ claims: [
    { claim: 'afirmação A', evidence: ['E1'], verdict: 'SUPPORTED' },
    { claim: 'afirmação B', evidence: ['E1'], verdict: 'NOT_EVALUABLE' },
] });
const lightJson = JSON.stringify({ claims: [
    { claim: 'afirmação A', evidence: ['E1'], verdict: 'SUPPORTED' },
    { claim: 'afirmação B', evidence: ['E1'], verdict: 'NOT_EVALUABLE' },
    { claim: 'afirmação C', evidence: [], verdict: 'NOT_EVALUABLE' },
] });

interface Call { prompt: string; model: string | undefined }
function harness() {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getBudgetAuxiliar } = require('../../shared/auxTimeout');
    const calls: Call[] = [];
    let delay = 0;
    let fail = false;
    const factory = {
        chatWithFallback: async (messages: Array<{ content: string }>, _t: unknown, _p: unknown, _to: unknown, _s: unknown, model?: string) => {
            calls.push({ prompt: messages[0].content, model });
            const isReal = calls.length === 1;
            if (!isReal) {
                if (delay) await new Promise(r => setTimeout(r, delay));
                if (fail) throw new Error('modelo leve indisponível');
            }
            return { status: 'success', content: model === 'modelo-leve' ? lightJson : heavyJson, attempts: [] };
        },
        getBudgetAuxiliar: (p: 'classificacao' | 'validacao') => getBudgetAuxiliar(p, null, null),
    } as unknown as import('../../core/ProviderFactory').ProviderFactory;
    return { v: new ObserverValidator(factory, 'modelo-pesado'), calls, setDelay: (ms: number) => { delay = ms; }, failShadow: () => { fail = true; } };
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
const records = (lines: string[], tag: string) => lines.map(strip).filter(l => l.includes(`${tag} {`))
    .map(l => JSON.parse(l.slice(l.indexOf(`${tag} `) + tag.length + 1)));

const evidences: EvidenceItem[] = [{ id: 'E1', tool: 'read', input: '{"path":"a.py"}', output: 'conteúdo lido' }];
const response = 'A e B.';
const ctx = { traceId: 't1', conversationId: 'c1', goalId: 'goal_x', stepId: 'step_2', phase: 'initial' as const, userRequest: 'pedido do usuário' };

async function main(): Promise<void> {
    delete process.env.GROUNDING_SHADOW_MODEL;
    delete process.env.GROUNDING_EVIDENCE_SHADOW;

    console.log('\n=== S307-1 — variável vazia: uma chamada, nenhuma linha ===');
    {
        const h = harness();
        const { lines } = await captureLogs(() => h.v.validateGrounding(response, evidences, undefined, ctx), 150);
        assert(h.calls.length === 1, 'exatamente uma chamada ao juiz', h.calls.length);
        assert(records(lines, '[GROUNDING-SHADOW-MODEL]').length === 0, 'nenhuma linha [GROUNDING-SHADOW-MODEL]');
    }

    console.log('\n=== S307-2/3 — ligada: mesmo prompt, outro modelo, registro comparativo ===');
    process.env.GROUNDING_SHADOW_MODEL = 'modelo-leve';
    {
        const h = harness();
        const { value: real, lines } = await captureLogs(() => h.v.validateGrounding(response, evidences, undefined, ctx), 250);
        assert(h.calls.length === 2, 'exatamente 2 chamadas (real + sombra)', h.calls.length);
        assert(h.calls[0].model === 'modelo-pesado', 'o REAL continua no modelo do juiz', h.calls[0].model);
        assert(h.calls[1].model === 'modelo-leve', 'a SOMBRA usa o modelo configurado', h.calls[1].model);
        assert(h.calls[0].prompt === h.calls[1].prompt, 'o prompt é IDÊNTICO — a única variável é o modelo');
        const rec = records(lines, '[GROUNDING-SHADOW-MODEL]')[0];
        assert(!!rec && rec.goalId === 'goal_x' && rec.stepId === 'step_2', 'registro com goalId/stepId', rec);
        assert(rec.realModel === 'modelo-pesado' && rec.shadowModel === 'modelo-leve', 'os dois modelos registrados', rec);
        assert(rec.realState === 'NOT_EVALUABLE' && rec.shadowState === 'NOT_EVALUABLE' && rec.stateAgrees === true, 'estados comparados (concordam)', rec);
        assert(rec.realCounts.NOT_EVALUABLE === 1 && rec.shadowCounts.NOT_EVALUABLE === 2 && rec.shadowCounts.SUPPORTED === 1, 'contagens por veredito dos dois', { r: rec.realCounts, s: rec.shadowCounts });
        assert(typeof rec.realElapsedMs === 'number' && typeof rec.shadowElapsedMs === 'number', 'tempo dos dois registrado');
        assert(rec.shadowNotSupported.length === 2 && rec.realNotSupported.length === 1, 'o que cada juiz não sustentou');
        assert(real.state === 'NOT_EVALUABLE' && real.claims.length === 2, 'o veredito devolvido é o REAL (2 afirmações)', real.claims.length);
    }

    console.log('\n=== S307-4 — real idêntico e devolvido antes da sombra ===');
    {
        delete process.env.GROUNDING_SHADOW_MODEL;
        const off = await captureLogs(() => harness().v.validateGrounding(response, evidences, undefined, ctx), 0);
        process.env.GROUNDING_SHADOW_MODEL = 'modelo-leve';
        const h = harness(); h.setDelay(400);
        const t0 = Date.now();
        const on = await captureLogs(() => h.v.validateGrounding(response, evidences, undefined, ctx), 0);
        const elapsed = Date.now() - t0;
        const norm = (x: { state: string; claims: unknown; reason: string }) => JSON.stringify({ s: x.state, c: x.claims, r: x.reason });
        assert(norm(off.value) === norm(on.value), 'mesmo estado, afirmações e motivo com e sem a sombra');
        assert(elapsed < 300, `voltou sem esperar a sombra de 400 ms (${elapsed} ms)`, elapsed);
        await new Promise(r => setTimeout(r, 600));
    }

    console.log('\n=== S307-5 — as duas sombras ligadas: 3 chamadas, sem recursão ===');
    process.env.GROUNDING_EVIDENCE_SHADOW = 'true';
    {
        const h = harness();
        await captureLogs(() => h.v.validateGrounding(response, evidences, undefined, ctx), 400);
        assert(h.calls.length === 3, 'real + evidência ampliada + modelo = exatamente 3 chamadas', h.calls.length);
    }
    delete process.env.GROUNDING_EVIDENCE_SHADOW;

    console.log('\n=== S307-6 — falha da sombra não afeta o real nem lança ===');
    {
        const h = harness(); h.failShadow();
        let threw = false; let state = '';
        try { const { value } = await captureLogs(() => h.v.validateGrounding(response, evidences, undefined, ctx), 200); state = value.state; } catch { threw = true; }
        assert(!threw && state === 'NOT_EVALUABLE', 'o veredito real sai normalmente', { threw, state });
    }

    console.log('\n=== S307-7 — revalidação parcial observada; sem contexto, nada ===');
    {
        const h = harness();
        const { lines } = await captureLogs(() => h.v.validateGrounding(response, evidences, undefined, { phase: 'partial-revalidation' }), 250);
        const rec = records(lines, '[GROUNDING-SHADOW-MODEL]')[0];
        assert(h.calls.length === 2 && rec?.phase === 'partial-revalidation', 'a revalidação parcial também gera a comparação', rec);
        const h2 = harness();
        const { lines: l2 } = await captureLogs(() => h2.v.validateGrounding(response, evidences), 150);
        assert(h2.calls.length === 1 && records(l2, '[GROUNDING-SHADOW-MODEL]').length === 0, 'sem contexto de trace: nenhuma sombra');
    }

    delete process.env.GROUNDING_SHADOW_MODEL;
    console.log(`\nS307 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    if (failed > 0) process.exitCode = 1;
}
main().catch(e => { console.error(e); process.exitCode = 1; });
