/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S462 (29/10/2026, issue 066 D-a; classe de S175)
 *
 * Quando o objetivo responde em áudio, `send_audio` grava a sentinela `__send_audio_delivered__` em `sentArtifacts`.
 * `buildResult` contava isso como ENTREGA SEPARADA e usava o parecer do avaliador como "nota que acompanha" — e o usuário
 * recebia, junto do áudio, "Objetivo concluído: obtida a cotação… A resposta final foi entregue ao usuário em texto claro".
 * O texto falado É a resposta, e quem não pode ouvir precisa dela escrita (FERRAMENTAS_DE_ENTREGA).
 *
 * ORIGEM: VPS (Linux), 17–19/10/2026, pergunta da cotação da River respondida em áudio.
 *
 * REGRESSÃO SE: com só o áudio entregue, a mensagem voltar a ser o parecer do avaliador; o texto falado (output do send_audio)
 * deixar de ser candidato à resposta; ou um ARQUIVO entregue deixar de transformar o parecer em nota (comportamento de S175).
 *
 * Execução: npx ts-node src/__tests__/regression/S462_AudioEntregueNaoViraParecer.test.ts
 */
import { GoalExecutionLoop } from '../../loop/GoalExecutionLoop';
import { GracefulDeliveryOrchestrator } from '../../loop/GracefulDeliveryOrchestrator';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

const PARECER = 'Objetivo concluído: obtida a cotação da River. A resposta final foi entregue ao usuário em texto claro.';
const FALADO = 'A River está cotada a 2,69 dólares agora, alta de 3% nas últimas 24 horas.';

const proto = GoalExecutionLoop.prototype as any;
const fakeThis = { pickBestAvailableContent: proto.pickBestAvailableContent, gracefulDelivery: new GracefulDeliveryOrchestrator(), goalStore: undefined };
const build = (goal: any) => proto.buildResult.call(fakeThis, goal, true, 3, 0, PARECER).finalOutput as string;

function goal(attempts: any[], sentArtifacts: string[]): any {
    return {
        id: 'g', userIntent: 'qual o valor da River agora? responde em áudio', objective: 'cotação da River em áudio',
        planGeneration: 0, attempts, blockers: [], strategiesTried: [], currentPlan: [], sentArtifacts, createdAt: Date.now(),
    };
}

console.log('\n=== S462 — o áudio entregue não vira o parecer do avaliador ===\n');

{
    const out = build(goal([{ toolName: 'send_audio', result: 'success', output: FALADO, planGeneration: 0 }], ['__send_audio_delivered__']));
    assert(out.startsWith(FALADO), 'passo send_audio: a mensagem é o texto falado', out);
    assert(!out.includes('Objetivo concluído'), 'o parecer não aparece', out);
}
{
    const out = build(goal([
        { toolName: 'web_search', result: 'success', output: 'resultados…', planGeneration: 0 },
        { toolName: 'agentloop', result: 'success', output: FALADO, planGeneration: 0 },
    ], ['__send_audio_delivered__']));
    assert(out.startsWith(FALADO), 'áudio enviado de dentro de uma etapa do agente: a mensagem é o texto da etapa', out);
}
{
    const out = build(goal([{ toolName: 'send_document', result: 'success', output: 'Documento anexado', planGeneration: 0 }], ['tmp/relatorio.pdf']));
    assert(out.startsWith(PARECER), 'arquivo entregue: o parecer continua sendo a nota que acompanha (S175)', out);
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S462 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
process.exit(failed > 0 ? 1 : 0);
