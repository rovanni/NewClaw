/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S406
 * Envio adiado (send_document dentro de um goal, entregue só depois da validação) é um FATO da execução: chega ao juiz de
 * grounding como evidência, e o agente é orientado a dizer "será enviado", não "enviei".
 *
 * ORIGEM (Telegram, 15/10/2026, campo "faltou"/"dificuldade" dos juízes): em 2 goals da mesma aula, 5 comentários do juiz
 * de grounding apontaram a mesma lacuna — a resposta dizia "slides criados e enviados!", mas não havia envio nenhum nas
 * evidências ("faltou a saída do mecanismo de anexo/envio para confirmar a entrega"). O registro do envio adiado só ia
 * para o agente; o rastro (de onde saem as evidências) não o tinha. Resultado: não avaliável/reprovado e o passo refeito.
 *
 * REGRESSÃO SE: o envio adiado deixar de aparecer nas evidências do juiz; o registro passar por envio feito; ou a
 * mensagem ao agente deixar de dizer que o arquivo ainda não foi enviado.
 *
 * Execução: npx ts-node src/__tests__/regression/S406_EnvioAdiado_EvidenciaParaOJuiz.test.ts
 */
import { AgentLoop } from '../../loop/AgentLoop';
import { AgentFSM } from '../../loop/AgentFSM';
import { traceManager } from '../../core/ExecutionTrace';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

async function despachar(loop: any, trace: unknown, adiados: Set<string>, mensagens: Array<{ content: string }>) {
    const fsm = new AgentFSM();
    fsm.transition('START_TURN');
    const move = (ev: string, meta?: Record<string, unknown>) => fsm.transition(ev as any, meta);
    const channelContext = {
        channel: 'telegram', chatId: 'u1',
        deliveryTracking: {
            deferSendDocument: (args: Record<string, unknown>) => { adiados.add(String(args.file_path)); },
            isDeferredArtifact: (p: string) => adiados.has(p),
        },
    };
    await loop.dispatchSingleNativeToolCall(
        { id: `c${adiados.size}`, name: 'send_document', arguments: { file_path: 'tmp/aula_armazenamento_secundario.pptx' } },
        3, channelContext, 'conv', 'crie os slides da aula', {} as any, trace, new AbortController().signal,
        new Set(), new Map(), new Map(), new Set(), new Set(), new Map(), new Map(), new Map(), new Map(), [],
        mensagens, {} as any, false, undefined, 20, 4, 0, [], 0, 10, 10, 5, move,
    );
}

async function main(): Promise<void> {
    const loop = Object.create(AgentLoop.prototype) as any;
    loop.tools = { get: () => ({ name: 'send_document', execute: async () => { throw new Error('não deveria enviar de verdade dentro do goal'); } }) };

    console.log('\n=== S406-1 — o registro do envio adiado vira evidência do juiz ===');
    const trace = traceManager.startTrace('s406', 'crie os slides da aula');
    const adiados = new Set<string>();
    const mensagens: Array<{ content: string }> = [];
    await despachar(loop, trace, adiados, mensagens);
    assert(adiados.has('tmp/aula_armazenamento_secundario.pptx'), 'o envio foi registrado para depois da validação (não enviado agora)');
    const evidencias = (AgentLoop as any).evidencesFromTrace(trace) as Array<{ tool: string; input?: string; output: string }>;
    const ev = evidencias.find(e => e.tool === 'send_document');
    assert(!!ev && /registrado/.test(ev.output) && /ainda não enviado/.test(ev.output) && /aula_armazenamento_secundario\.pptx/.test(ev.input ?? ''),
        'evidência send_document: arquivo, "registrado" e "ainda não enviado" — o juiz vê o fato', evidencias);

    console.log('\n=== S406-2 — a mensagem ao agente diz como falar do envio ===');
    const msg = mensagens[mensagens.length - 1]?.content ?? '';
    assert(/^\[DIFERIDO\]/.test(msg) && /será enviado em seguida/.test(msg) && /NÃO foi enviado/.test(msg), 'primeiro registro: "será enviado em seguida — ainda NÃO foi enviado"', msg);

    console.log('\n=== S406-3 — repetir o envio do mesmo arquivo: mesma orientação, e o fato também no rastro deste sub-turno ===');
    const trace2 = traceManager.startTrace('s406b', 'crie os slides da aula');
    await despachar(loop, trace2, adiados, mensagens);
    const msg2 = mensagens[mensagens.length - 1]?.content ?? '';
    assert(/^\[DIFERIDO-DEDUP\]/.test(msg2) && /será enviado em seguida/.test(msg2), 'repetição: DEDUP com a mesma orientação', msg2);
    assert(((AgentLoop as any).evidencesFromTrace(trace2) as Array<{ tool: string }>).some(e => e.tool === 'send_document'), 'o sub-turno que repetiu também tem o fato como evidência');

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S406 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    process.exit(failed > 0 ? 1 : 0);
}
main().catch((err) => { console.error('S406 erro inesperado:', err); process.exit(1); });
