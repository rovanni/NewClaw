/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S381 (auditoria da suíte, 10/10/2026): o verde só vale se os testes CONSEGUEM falhar.
 *
 * A auditoria achou dois arquivos (P1_1 e P1_2) cujo resultado era só texto: contavam `failed` e terminavam com exit 0 — uma
 * violação nunca viraria vermelho. Este teste trava a classe inteira do problema:
 *
 * S381-1 — NEGATIVO CONTROLADO: uma cópia mutada de P1_1 e de P1_2 (o helper de asserção forçado a falhar) tem de terminar com
 *          exit 1; as originais, sem mutação, terminam com exit 0. A mutação vive num arquivo temporário (`*.negative.ts`, que o
 *          runner não descobre) apagado ao final — nunca fica uma falha deliberada na suíte normal.
 * S381-2 — GUARDA ESTÁTICO: todo arquivo da suíte tem um mecanismo de saída que depende do resultado (nenhum teste novo pode
 *          nascer incapaz de falhar).
 * S381-3 — O RUNNER: o autoteste (pasta ausente, zero testes, timeout, exceção, exit != 0, "FALHOU:" com exit 0) passa.
 *
 * Execução: npx ts-node src/__tests__/regression/S381_RegressionHarness_TestsCanFail.test.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { runOne } = require(path.join(process.cwd(), 'scripts', 'run-regression-tests.cjs')) as {
    runOne: (arquivo: string, timeoutMs?: number) => { status: string; exitCode: number | null; failMarkers: number };
};

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

const DIR = path.join(process.cwd(), 'src', '__tests__', 'regression');

// O operador de mutação é UM só (scripts/mutacao-de-asserts.cjs), compartilhado com a auditoria dinâmica de todos os arquivos.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { mutarHelper } = require(path.join(process.cwd(), 'scripts', 'mutacao-de-asserts.cjs')) as { mutarHelper: (origem: string) => string | null };

async function main(): Promise<void> {

console.log('\n=== S381-1 — negativo controlado: P1_1 e P1_2 realmente falham quando uma asserção é violada ===');
for (const nome of ['P1_1_ArtifactPersistence_CrossGoal', 'P1_2_ContextContamination_RankingInversion']) {
    const original = path.join(DIR, `${nome}.test.ts`);
    const mutado = path.join(DIR, `__negativo__${nome}.negative.ts`);
    try {
        const normal = runOne(original, 120_000);
        assert(normal.status === 'passed' && normal.exitCode === 0, `${nome}: cenário normal passa (exit 0)`, normal);
        const fonteMutada = mutarHelper(fs.readFileSync(original, 'utf-8'));
        assert(fonteMutada !== null && fonteMutada !== fs.readFileSync(original, 'utf-8'), `${nome}: a mutação do helper de asserção foi aplicada`);
        if (fonteMutada) {
            fs.writeFileSync(mutado, fonteMutada);
            const negativo = runOne(mutado, 120_000);
            assert(negativo.status === 'failed' && negativo.exitCode === 1, `${nome}: com a asserção violada o processo termina com exit 1 (a falha é PROPAGADA)`, negativo);
        }
    } finally {
        try { fs.rmSync(mutado, { force: true }); } catch { /* arquivo temporário */ }
    }
}

console.log('\n=== S381-2 — guarda estático: todo teste da suíte tem saída que depende do resultado ===');
{
    const arquivos = fs.readdirSync(DIR).filter(f => f.endsWith('.test.ts')).sort();
    const sinaliza = /process\.exit\(\s*(?:1|[^)]*(?:failed|failures|falhas|fail|ok|erros|errors|exitCode)[^)]*)\)|process\.exitCode\s*=|throw new Error|\.exit\(1\)/;
    const semSaida = arquivos.filter(f => !sinaliza.test(fs.readFileSync(path.join(DIR, f), 'utf-8')));
    assert(semSaida.length === 0, `nenhum dos ${arquivos.length} arquivos nasce incapaz de falhar`, semSaida);
    const soContaFalhas = arquivos.filter(f => {
        const s = fs.readFileSync(path.join(DIR, f), 'utf-8');
        return /\bfailed\+\+/.test(s) && !/process\.exitCode\s*=|process\.exit\(\s*(?:1|[^)]*failed)/.test(s) && !/throw new Error/.test(s);
    });
    assert(soContaFalhas.length === 0, 'nenhum arquivo conta falhas (failed++) sem que a saída dependa do contador', soContaFalhas);
}

console.log('\n=== S381-3 — o runner: o autoteste dos cenários controlados passa ===');
{
    const r = spawnSync(process.execPath, [path.join(process.cwd(), 'scripts', 'run-regression-tests.cjs'), '--selftest'], { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
    assert(r.status === 0 && /SELFTEST OK/.test(r.stdout || ''), 'runner --selftest sai com 0 e diz SELFTEST OK', (r.stdout || '').slice(-400) + (r.stderr || '').slice(-400));
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S381 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;
}

main().catch(e => { console.error(e); process.exit(1); });
