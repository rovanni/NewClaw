/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S105
 * 
 * Verifica que EventBusClass.onAny() retorna uma função de unsubscribe (teardown)
 * e que ao executá-la, os listeners genéricos são completamente removidos do emitter,
 * prevenindo vazamentos de memória e manipulação dupla de eventos.
 */

import { eventBus, EventTypes, AppEvent } from '../../core/EventBus';

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string, detail?: unknown): void {
    if (cond) { console.log(`  ✅ ${msg}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${msg}`, detail ?? ''); failed++; }
}

async function main() {
    console.log('\n=== S105 — Teardown de Assinaturas (onAny) no EventBus ===');

    let triggerCount = 0;
    const handler = (_event: AppEvent) => {
        triggerCount++;
    };

    // Assina os eventos genéricos
    const unsubscribe = eventBus.onAny(handler);
    assert(typeof unsubscribe === 'function', 'onAny retornou uma função de unsubscribe');

    // Emite o evento pela primeira vez
    await eventBus.emitAppEvent({
        type: EventTypes.SCHEDULER_TRIGGER,
        payload: { taskId: 42 },
        source: 'test-s105'
    });

    assert(triggerCount === 1, 'O handler de onAny foi acionado uma vez ao emitir o evento');

    // Executa a desinscrição (teardown)
    unsubscribe();

    // Emite o evento pela segunda vez
    await eventBus.emitAppEvent({
        type: EventTypes.SCHEDULER_TRIGGER,
        payload: { taskId: 42 },
        source: 'test-s105'
    });

    assert(triggerCount === 1, 'O handler NÃO foi acionado na segunda emissão (unsubscribe funcionou)');

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S105 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    if (failed > 0) process.exit(1);
    process.exit(0);
}

main().catch(err => {
    console.error('Erro no teste S105:', err);
    process.exit(1);
});
