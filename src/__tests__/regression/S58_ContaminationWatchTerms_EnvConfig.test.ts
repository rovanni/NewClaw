/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S58
 * Achado durante a sessão de [[project_session_bugs_jul2026_ah]] (mesmo dia, ao corrigir o
 * bug de cidade padrão não consultada): `ContextBuilder.ts` e `SessionContext.ts` tinham
 * listas `LEAK_TERMS`/`RISK_TERMS` HARDCODED com termos pessoais reais do usuário (cidade,
 * assuntos de interesse) — usadas só para os logs de diagnóstico `[USER-EXPANDED] leakTerms=`
 * e `[FINAL-CONTEXT] riskTerms=` (a decisão real de truncar contexto já é genérica, via
 * relevância léxica com a query — essas listas nunca gatilharam comportamento, só auditoria).
 *
 * Projeto é open source, publicado no GitHub para qualquer pessoa rodar sua própria instância
 * — os termos pessoais de UMA instalação não deveriam estar hardcoded no repositório público.
 *
 * Fix: as duas listas agora vêm de `process.env.CONTAMINATION_WATCH_TERMS` (comma-separated),
 * default vazio quando a env var não está definida. Cada instalação define os seus próprios
 * termos no `.env` local (nunca versionado) em vez de herdar os de outra pessoa. Documentado
 * em `.env.example`.
 *
 * Escopo tocado: loop/ContextBuilder.ts, session/SessionContext.ts, .env.example.
 *
 * Execução: npx ts-node src/__tests__/regression/S58_ContaminationWatchTerms_EnvConfig.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`); failed++; }
}

async function main(): Promise<void> {

console.log('\n=== S58-1 — nenhum termo pessoal hardcoded permanece no código-fonte tocado ===');
{
    const files = [
        path.join('src', 'loop', 'ContextBuilder.ts'),
        path.join('src', 'session', 'SessionContext.ts'),
        path.join('src', 'loop', 'GoalOrchestrator.ts'),
        path.join('src', 'loop', 'GoalExtractor.ts'),
        path.join('src', 'loop', 'GoalExecutionLoop.ts'),
        path.join('src', 'core', 'AgentController.ts'),
        path.join('src', 'services', 'SchedulerService.ts'),
        path.join('src', 'tools', 'weather.ts'),
    ];
    const personalTerms = /luciano|cornélio|cornelio/i;
    for (const rel of files) {
        const content = fs.readFileSync(path.join(process.cwd(), rel), 'utf-8');
        assert(!personalTerms.test(content), `${rel} não contém nome/cidade pessoal hardcoded`);
    }
}

console.log('\n=== S58-2 — ContextBuilder.ts e SessionContext.ts: termos vêm de env var, default vazio ===');
{
    const contextBuilderSource = fs.readFileSync(path.join(process.cwd(), 'src', 'loop', 'ContextBuilder.ts'), 'utf-8');
    const sessionContextSource = fs.readFileSync(path.join(process.cwd(), 'src', 'session', 'SessionContext.ts'), 'utf-8');
    assert(
        /const LEAK_TERMS = \(process\.env\.CONTAMINATION_WATCH_TERMS \|\| ''\)/.test(contextBuilderSource),
        'ContextBuilder.ts: LEAK_TERMS lido de process.env.CONTAMINATION_WATCH_TERMS, default string vazia',
    );
    assert(
        /const RISK_TERMS = \(process\.env\.CONTAMINATION_WATCH_TERMS \|\| ''\)/.test(sessionContextSource),
        'SessionContext.ts: RISK_TERMS lido da MESMA env var (fonte única, não duplicada)',
    );
}

console.log('\n=== S58-3 — reprodução isolada: parsing da env var (vazia, com termos, com espaços) ===');
{
    function parseWatchTerms(envValue: string | undefined): string[] {
        return (envValue || '').toLowerCase().split(',').map(t => t.trim()).filter(Boolean);
    }
    assert(parseWatchTerms(undefined).length === 0, 'env var ausente → lista vazia (comportamento seguro por padrão)');
    assert(parseWatchTerms('').length === 0, 'env var vazia → lista vazia');
    assert(
        JSON.stringify(parseWatchTerms('cidadeA, TimeB ,cidadeA')) === JSON.stringify(['cidadea', 'timeb', 'cidadea']),
        'termos são normalizados (trim + lowercase) igual ao comportamento original hardcoded',
    );
}

console.log('\n=== S58-4 — .env.example documenta a nova variável sem valores reais ===');
{
    const envExample = fs.readFileSync(path.join(process.cwd(), '.env.example'), 'utf-8');
    assert(/CONTAMINATION_WATCH_TERMS=$/m.test(envExample), '.env.example declara CONTAMINATION_WATCH_TERMS vazia (sem termos reais de ninguém)');
    assert(!/luciano|cornélio|cornelio/i.test(envExample), '.env.example não contém nenhum dado pessoal real');
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S58 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;

}

main().catch((err) => {
    console.error('S58 erro inesperado:', err);
    process.exitCode = 1;
});
