/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S214
 * A auditoria diz "não consegui verificar" em vez de afirmar ausência (`ADR-008` §4.2, Sprint 036).
 *
 * CONTEXTO: `integrationChecker` decidia a presença do `signal-cli` com `which(path) ? path :
 * 'not_found'`. Qualquer falha da sondagem — timeout, PATH, permissão — virava "não instalado", e o
 * relatório emitia um `finding` de severidade `warning` sugerindo instalar um binário que podia
 * estar perfeitamente instalado. Um relatório de auditoria que afirma o que não verificou gera
 * trabalho inútil para quem o lê.
 *
 * É o consumidor de menor risco dos quatro da `ADR-008` — nenhuma decisão automática depende deste
 * valor — e por isso o mais direto: basta o relatório passar a distinguir o que sabe do que não
 * conseguiu apurar.
 *
 * REGRESSÃO SE: uma sondagem indeterminada voltar a ser reportada como ausência; ou a sugestão de
 * instalar voltar a aparecer num caso que não foi verificado.
 *
 * Execução: npx ts-node src/__tests__/regression/S214_AuditReportsIndeterminate.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

const SRC = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'auditor', 'integrationChecker.ts'), 'utf-8');
const BLOCO = SRC.slice(SRC.indexOf('// 5. Signal'), SRC.indexOf('// 5. Signal') + 3000);

console.log('\n=== S214-1 — a sondagem de dois estados saiu ===');
{
    assert(!/which\(signalCliPath\)/.test(SRC),
        'o ternário sobre which() não existe mais — ele é que colapsava falha em ausência',
        SRC.match(/which\([^)]*\)[^;]*/g));
    assert(/probeCommand\(signalCliPath\)/.test(BLOCO),
        'a sondagem passou a ser a de três estados', BLOCO.slice(0, 300));
}

console.log('\n=== S214-2 — indeterminação é reportada como tal ===');
{
    assert(/kind === 'indeterminate'/.test(BLOCO), 'existe ramo próprio para "não consegui verificar"');
    assert(/não foi possível verificar/.test(BLOCO),
        'e o detalhe do canal diz isso, em vez de "não instalado"', BLOCO);
    assert(/NÃO significa que ele esteja ausente/.test(BLOCO),
        'a descrição do finding é explícita sobre o que o dado NÃO prova');
}

console.log('\n=== S214-3 — a sugestão de instalar não aparece no caso não verificado ===');
{
    const indeterminado = BLOCO.slice(BLOCO.indexOf("kind === 'indeterminate'"), BLOCO.indexOf("kind === 'absent'"));
    assert(indeterminado.length > 0, 'ramo de indeterminação localizado');
    assert(!/Instalar signal-cli/.test(indeterminado),
        'não sugere instalar o que talvez já esteja instalado — era o trabalho inútil que o relatório gerava',
        indeterminado);
    assert(/severity: 'info'/.test(indeterminado),
        'e a severidade reflete que é uma limitação da apuração, não um problema encontrado');
}

console.log('\n=== S214-4 — a ausência VERIFICADA continua reportada como antes ===');
{
    const ausente = BLOCO.slice(BLOCO.indexOf("kind === 'absent'"));
    assert(/signal-cli não instalado/.test(ausente), 'ausência verificada segue dizendo "não instalado"');
    assert(/Instalar signal-cli/.test(ausente), 'e segue sugerindo instalar — aí a sugestão é válida');
    assert(/severity: 'warning'/.test(ausente), 'com a severidade original preservada');
}

console.log('\n=== S214-5 — GoalExecutionLoop mantém o colapso, agora com o motivo escrito ===');
{
    const GEL = fs.readFileSync(path.join(process.cwd(), 'src', 'loop', 'GoalExecutionLoop.ts'), 'utf-8');
    assert(/captureFromGoal\([\s\S]{0,80}commandExists\)/.test(GEL),
        'continua usando commandExists — o colapso aqui é o lado seguro (ADR-003)');
    assert(/ADR-008[\s\S]{0,400}lado SEGURO/.test(GEL),
        'e o motivo está escrito no ponto de consumo, não implícito na primitiva');
}

console.log(`\nS214 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
console.log(`\nCOBERTURA:`);
console.log(`  Sondagem de dois estados removida da auditoria: testado`);
console.log(`  Indeterminação reportada como tal, sem sugerir instalação: testado`);
console.log(`  Ausência verificada preservada: testado`);
console.log(`  Colapso deliberado do GoalExecutionLoop documentado: testado`);
if (failed > 0) process.exit(1);
