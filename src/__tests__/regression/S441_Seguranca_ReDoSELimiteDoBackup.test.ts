/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S441
 * (1) A detecção de senha que roda em TODA mensagem recebida não pode ter custo quadrático (CodeQL js/polynomial-redos #112).
 * (2) As rotas de backup — que leem e gravam arquivos grandes — têm o limite de requisições próprio (CodeQL
 *     js/missing-rate-limiting #114–#118), no mesmo padrão das rotas de modelo local (S233).
 *
 * MEDIDO (21/10/2026, antes da correção): "senha: " + 40 mil "!" + "x" levava 1,6 s em `detectarSegredos` (20 mil: 0,43 s —
 * crescimento quadrático), travando o processo. Causa: `replace(/[.,;:!?)\]]+$/, '')` tenta cada posição da sequência e falha
 * no `$`. Depois: 1 ms em todos os tamanhos.
 *
 * Execução: npx ts-node src/__tests__/regression/S441_Seguranca_ReDoSELimiteDoBackup.test.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { detectarSegredos } from '../../shared/segredos';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

console.log('\n=== S441-1 — detecção de senha linear na entrada adversária ===');
{
    const t0 = Date.now();
    detectarSegredos('senha: ' + '!'.repeat(200_000) + 'x');
    const ms = Date.now() - t0;
    assert(ms < 500, `200 mil "!" seguidos de letra: ${ms} ms (antes: dezenas de segundos)`, ms);
}

console.log('\n=== S441-2 — o resultado continua o mesmo ===');
{
    assert(detectarSegredos('a senha é Abc12345!.').includes('Abc12345'), 'pontuação do fim da frase sai do valor');
    assert(detectarSegredos('senha: Xy9!q2w3e').includes('Xy9!q2w3e'), 'pontuação no MEIO do valor fica');
    assert(detectarSegredos('my password is Secr3t-Value)]').includes('Secr3t-Value'), 'parênteses e colchetes do fim saem');
    assert(detectarSegredos('a senha é complicada').length === 0, 'palavra comum depois de "senha" continua não sendo senha');
}

console.log('\n=== S441-3 — toda rota de backup que toca arquivo tem o limite ===');
{
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'dashboard', 'routes', 'maintenance.ts'), 'utf-8');
    // express-rate-limit, e não o createRateLimiter próprio: o CodeQL só reconhece limitadores de bibliotecas conhecidas
    // (com o próprio, os alertas js/missing-rate-limiting reapareceram e reprovaram o PR #15).
    assert(/const backupFsRateLimit = rateLimit\(\{/.test(src) && /from 'express-rate-limit'/.test(src), 'limitador do express-rate-limit (o que o CodeQL reconhece)');
    const rotas = ['/backup/list', '/backup/system', '/backup/database', '/backup/restore', '/backup/conhecimento',
        '/backup/conhecimento/inspecionar', '/backup/conhecimento/restaurar', '/backup/conhecimento/importar', '/backup/:filename'];
    for (const r of rotas) {
        const re = new RegExp(`router\\.(get|post)\\('${r.replace(/[/:]/g, m => '\\' + m)}', backupFsRateLimit,`);
        assert(re.test(src), `${r} passa pelo limite`);
    }
    assert(/router\.post\('\/backup\/upload',\s*backupFsRateLimit,/.test(src), '/backup/upload passa pelo limite antes do corpo de 100 MB');
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S441 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;
