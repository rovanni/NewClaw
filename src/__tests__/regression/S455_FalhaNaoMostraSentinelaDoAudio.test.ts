/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S455 (28/10/2026)
 *
 * `__send_audio_delivered__` é a chave de dedup do áudio (S44): entra em `goal.sentArtifacts` quando o send_audio entrega,
 * mas não é arquivo. A mensagem de falha listava `sentArtifacts` cru — "Consegui gerar e enviar: __send_audio_delivered__".
 *
 * ORIGEM: VPS, 22–23/10/2026 (Telegram): o marcador interno apareceu na mensagem de falha de um objetivo que já tinha
 * respondido em áudio (registrado na medição dos juízes intermediários, issue 068).
 *
 * REGRESSÃO SE: a sentinela voltar a aparecer no texto de `buildFailureMessage`, ou o áudio entregue deixar de ser dito.
 *
 * Execução: npx ts-node src/__tests__/regression/S455_FalhaNaoMostraSentinelaDoAudio.test.ts
 */
import { GracefulDeliveryOrchestrator } from '../../loop/GracefulDeliveryOrchestrator';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

function goal(sentArtifacts: string[]): any {
    return {
        id: 'g1', userIntent: 'qual a cotação do dólar? responda em áudio', toolsTried: ['web_search', 'send_audio'],
        attempts: [], blockers: [], sentArtifacts,
    };
}

function main(): void {
    console.log('\n=== S455 — a mensagem de falha não mostra a sentinela do áudio ===\n');
    const gd = new GracefulDeliveryOrchestrator();

    const so = gd.buildFailureMessage(goal(['__send_audio_delivered__']));
    assert(!so.includes('__send_audio_delivered__'), 'a sentinela não aparece', so);
    assert(so.startsWith('Consegui gerar e enviar: a resposta em áudio.'), 'o áudio entregue é dito ao usuário', so);

    const misto = gd.buildFailureMessage(goal(['tmp/cotacao.pdf', '__send_audio_delivered__']));
    assert(misto.startsWith('Consegui gerar e enviar: tmp/cotacao.pdf, a resposta em áudio.'), 'arquivo real e áudio, na ordem da entrega', misto);

    const nada = gd.buildFailureMessage(goal([]));
    assert(nada.startsWith('Não consegui completar:'), 'sem entrega, a abertura não muda', nada);

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S455 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    process.exit(failed > 0 ? 1 : 0);
}
main();
