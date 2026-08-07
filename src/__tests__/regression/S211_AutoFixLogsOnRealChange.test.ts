/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S211
 * Toda reescrita de comando deixa rastro (Sprint 029).
 *
 * CONTEXTO: `remap_foreign_workspace_paths` era a única substituição do sistema que não deixava
 * rastro nenhum. Ela reescreve o comando que o MODELO pediu, e nada no log dizia que houve troca —
 * registrado como débito 10 da Fase 0
 * (`docs/analises-arquiteturais/FASE0_POLITICAS_IMPLICITAS_DE_INDISPONIBILIDADE_2026-08-06.md`).
 *
 * A causa não era o fixup, era o critério de log: `applyFixup()` registrava quando a `condition`
 * passava, não quando o comando mudava. Para os demais fixups dava no mesmo — condição satisfeita
 * já implicava reescrita. Para este, cuja condição é `() => true`, significava escolher entre não
 * logar nunca (o que se fez, via `logOnChange: false`) ou logar em TODO `exec_command`.
 *
 * Passar a logar por mudança real resolve os dois lados: o remap deixa rastro quando reescreve, e
 * nenhum fixup polui o log quando não faz nada.
 *
 * REGRESSÃO SE: o log voltar a depender da `condition` em vez da mudança; ou algum fixup ganhar
 * isenção de rastro.
 *
 * Execução: npx ts-node src/__tests__/regression/S211_AutoFixLogsOnRealChange.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

const SRC = fs.readFileSync(path.join(process.cwd(), 'src', 'tools', 'exec_command.ts'), 'utf-8');
const APPLY_INI = SRC.indexOf('function applyFixup');
const APPLY = SRC.slice(APPLY_INI, SRC.indexOf('\n}', APPLY_INI));

console.log('\n=== S211-1 — o log sai por mudança real, não por condição satisfeita ===');
{
    assert(/if\s*\(next\s*!==\s*command\)/.test(APPLY),
        'applyFixup registra quando o comando mudou', APPLY.slice(0, 400));
    assert(!/if\s*\(step\.logOnChange/.test(APPLY),
        'o critério não é mais o flag por passo — nenhum fixup tem isenção de rastro');
    assert(/\[AUTO-FIX\] fix=\$\{step\.name\}/.test(APPLY),
        'o rastro continua nomeando qual fixup reescreveu');
}

console.log('\n=== S211-2 — o caso que originou o débito continua sendo o caso ===');
{
    const bloco = SRC.slice(
        SRC.indexOf("name: 'remap_foreign_workspace_paths'"),
        SRC.indexOf("name: 'add_marp_no_stdin'"),
    );
    assert(bloco.length > 0, 'entrada do remap localizada no pipeline');
    assert(/condition:\s*\(\)\s*=>\s*true/.test(bloco),
        'a condição dele continua sempre verdadeira — é por isso que "condição" não servia como critério de log',
        bloco);
    assert(!/logOnChange:\s*false/.test(bloco),
        'e ele não tem mais isenção declarada', bloco);
}

console.log('\n=== S211-3 — nenhum outro fixup ficou com isenção ===');
{
    const pipeline = SRC.slice(
        SRC.indexOf('const COMMAND_FIXUP_PIPELINE'),
        SRC.indexOf('function applyFixup'),
    );
    assert(!/logOnChange:\s*false/.test(pipeline),
        'nenhuma entrada do pipeline declara isenção de log', pipeline.match(/logOnChange:[^,\n]*/g));
}

console.log(`\nS211 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
console.log(`\nCOBERTURA:`);
console.log(`  Critério de log é mudança real, não condição: testado`);
console.log(`  remap_foreign_workspace_paths sem isenção: testado`);
console.log(`  Nenhum fixup com isenção de rastro: testado`);
if (failed > 0) process.exit(1);
