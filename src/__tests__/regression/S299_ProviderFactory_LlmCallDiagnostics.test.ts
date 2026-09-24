/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S299 (Campanha B2: instrumentação de chamadas ao LLM)
 *
 * CONTEXTO (auditoria de 24/09/2026): 17 abortos por orçamento de raciocínio num goal, e o log não
 * dizia QUEM chamava — modelo e papel estavam misturados. B1 mostrou que trocar o modelo não
 * resolvia. A instrumentação registra uma linha `[LLM-CALL]` por chamada, sem alterar
 * comportamento: o contrato de `chatWithFallback` é o mesmo e o resultado devolvido é o mesmo objeto.
 *
 * REGRESSÃO SE: o wrapper alterar/copiar o resultado; um erro de diagnóstico derrubar a chamada;
 * um novo chamador de `chatWithFallback` aparecer sem `diag`; ou a linha perder os campos.
 *
 * Execução: npx ts-node src/__tests__/regression/S299_ProviderFactory_LlmCallDiagnostics.test.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { ProviderFactory, buildLlmCallSummary } from '../../core/ProviderFactory';
import type { LLMResult } from '../../core/providerTypes';

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string, detail?: unknown): void {
    if (cond) { console.log(`  OK ${msg}`); passed++; }
    else { console.error(`  FALHOU: ${msg}`, detail ?? ''); failed++; }
}

const msgs = [{ role: 'user', content: 'x'.repeat(400) }] as any[];

async function main(): Promise<void> {
    console.log('\n=== S299.1 — linha de uma chamada ABORTADA por orçamento de raciocínio ===');
    {
        const r: LLMResult = {
            status: 'error', content: '', fallbackReason: 'error',
            attempts: [
                { provider: 'ollama', model: 'glm-5.3-flash:cloud', duration: 16626, status: 'error', errorMessage: 'Reasoning budget exceeded after 7983 chars' },
                { provider: 'ollama', model: 'glm-5.3-flash:cloud', duration: 12000, status: 'error', errorMessage: 'Reasoning budget exceeded after 8014 chars' },
            ],
        };
        const line = buildLlmCallSummary({ component: 'GoalPlanner', role: 'planner', phase: 'replan', goalId: 'goal_1', cycle: 3, step: 'step_2' }, msgs, r, 28700);
        assert(/component=GoalPlanner/.test(line) && /role=planner/.test(line) && /phase=replan/.test(line), 'traz componente, papel e fase', line);
        assert(/goal=goal_1 cycle=3 step=step_2/.test(line), 'traz goal/cycle/step', line);
        assert(/model=glm-5\.3-flash:cloud/.test(line) && /attempts=2/.test(line), 'traz modelo e nº de tentativas', line);
        assert(/aborted=true/.test(line) && /reasoning_chars=8014/.test(line), 'aborted=true e maior raciocínio descartado', line);
        assert(/in_est=100/.test(line) && !/ in=/.test(line) && !/ out=/.test(line), 'in_est (400 chars/4) sem in/out quando não houve uso reportado', line);
        assert(/ms=28700/.test(line), 'traz a duração total', line);
    }

    console.log('\n=== S299.2 — chamada concluída e chamada sem rótulo ===');
    {
        const ok: LLMResult = { status: 'success', content: 'ok', attempts: [{ provider: 'ollama', model: 'glm-5.2:cloud', duration: 900, status: 'success' }], usage: { prompt_tokens: 597, completion_tokens: 166 } };
        const line = buildLlmCallSummary({ component: 'GoalExtractor', role: 'classifier' }, msgs, ok, 950);
        assert(/aborted=false/.test(line) && / in=597 out=166/.test(line) && !/reasoning_chars/.test(line), 'concluída: in/out reais, sem reasoning_chars', line);
        const semRotulo = buildLlmCallSummary(undefined, msgs, ok, 10);
        assert(/component=unlabeled/.test(semRotulo), 'chamador sem diag aparece como "unlabeled", não some do log', semRotulo);
        const vazio = buildLlmCallSummary(undefined, msgs, { status: 'cancelled', content: '', attempts: [] } as LLMResult, 1);
        assert(/status=cancelled/.test(vazio) && /attempts=0/.test(vazio), 'sem tentativas não quebra', vazio);
    }

    console.log('\n=== S299.2b — o pseudo-modelo do fallback não esconde o modelo real ===');
    {
        const r: LLMResult = { status: 'success', content: 'ok', attempts: [
            { provider: 'ollama', model: 'glm-5.3:cloud', duration: 20000, status: 'error', errorMessage: 'Reasoning budget exceeded after 8005 chars' },
            { provider: 'ollama', model: 'non-streaming-fallback', duration: 30000, status: 'success' },
        ] };
        const line = buildLlmCallSummary({ component: 'GoalPlanner', phase: 'plan' }, msgs, r, 51000);
        assert(/model=glm-5\.3:cloud/.test(line) && !/model=non-streaming-fallback/.test(line), 'model é o real (primeira tentativa)', line);
        assert(/via=non-streaming/.test(line) && /aborted=true/.test(line), 'via=non-streaming e aborted=true (o streaming abortou; o fallback respondeu)', line);
    }

    console.log('\n=== S299.3 — CONTRATO: o wrapper devolve exatamente o objeto do corpo e loga ===');
    {
        const pf: any = new ProviderFactory({ defaultProvider: 'ollama', ollamaUrl: 'http://127.0.0.1:1', ollamaModel: 'x' } as any);
        const sentinela: LLMResult = { status: 'success', content: 'resultado-intacto', attempts: [{ provider: 'ollama', model: 'm', duration: 1, status: 'success' }] };
        pf.chatWithFallbackImpl = async () => sentinela;
        let saida = '';
        const w1 = process.stdout.write.bind(process.stdout); const w2 = process.stderr.write.bind(process.stderr);
        (process.stdout as any).write = (c: any) => { saida += String(c); return true; };
        (process.stderr as any).write = (c: any) => { saida += String(c); return true; };
        let r: LLMResult;
        try { r = await pf.chatWithFallback(msgs, undefined, undefined, 1000, undefined, undefined, { diag: { component: 'TesteS299' } }); }
        finally { (process.stdout as any).write = w1; (process.stderr as any).write = w2; }
        assert(r === sentinela, 'o objeto devolvido é o MESMO (identidade), sem cópia nem alteração');
        assert(/\[LLM-CALL\] component=TesteS299/.test(saida), 'emitiu a linha [LLM-CALL]', saida.slice(0, 200));
    }

    console.log('\n=== S299.4 — diag não muda o comportamento (provider inalcançável, com e sem rótulo) ===');
    {
        const pf = new ProviderFactory({ defaultProvider: 'ollama', ollamaUrl: 'http://127.0.0.1:1', ollamaModel: 'x' } as any);
        const a = await pf.chatWithFallback(msgs, undefined, undefined, 3000, undefined, undefined, { diag: { component: 'S299' } });
        assert(a.status === 'error' || a.status === 'timeout', `falha normalmente com rótulo (status=${a.status})`);
        assert(typeof a.fallbackMessage === 'string' && a.fallbackMessage.length > 10, 'mantém o fallbackMessage informativo (S294)', a.fallbackMessage);
    }

    console.log('\n=== S299.5 — COMPLETUDE: todo chamador de chatWithFallback informa diag ===');
    {
        const root = path.join(process.cwd(), 'src');
        const files: string[] = [];
        const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            if (e.name === '__tests__' || e.name === 'node_modules') continue;
            const f = path.join(d, e.name);
            if (e.isDirectory()) walk(f); else if (f.endsWith('.ts')) files.push(f);
        } };
        walk(root);
        const semDiag: string[] = [];
        let total = 0;
        for (const f of files) {
            if (f.endsWith(path.join('core', 'ProviderFactory.ts'))) continue;
            const src = fs.readFileSync(f, 'utf-8');
            const re = /\.chatWithFallback\(/g;
            let m: RegExpExecArray | null;
            while ((m = re.exec(src))) {
                let depth = 1; let i = m.index + m[0].length;
                while (i < src.length && depth > 0) { const c = src[i++]; if (c === '(') depth++; else if (c === ')') depth--; }
                total++;
                if (!/diag\s*:/.test(src.slice(m.index, i))) semDiag.push(`${path.relative(root, f)}:${src.slice(0, m.index).split('\n').length}`);
            }
        }
        assert(total >= 13, `encontrou os chamadores (${total})`);
        assert(semDiag.length === 0, 'nenhum chamador sem diag', semDiag);
    }

    console.log(`\nS299 RESULTADO: ${passed} passou | ${failed} falhou`);
    process.exit(failed > 0 ? 1 : 0);
}
main().catch(e => { console.error('ERRO NÃO TRATADO:', e); process.exit(1); });
