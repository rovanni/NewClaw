/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S447 (ADR-027, achados do code-review de 23/10/2026)
 * (1) A validação que roda em SEGUNDO PLANO num turno (tryValidateTool) é interrompida quando o PRÓXIMO pedido da mesma
 *     conversa começa: sem o abort de 60 s, ela podia disputar a GPU/fila com ele. Não no fim do turno — ela começa no meio
 *     dele e quase sempre termina depois da resposta; abortá-la ali apagaria o que ela grava na ReflectionMemory.
 * (2) O turno de CONVERSA longo (fora de objetivo) também relata o progresso — sem teto, um comando que trabalha sem parar
 *     deixava o usuário só com "Pensando...". Turno que é passo de objetivo (goalTrace) não relata: o objetivo já relata.
 *
 * REGRESSÃO SE: a validação em segundo plano continuar depois do turno ou gravar resultado de um turno encerrado; o turno de
 * conversa não relatar; o passo de objetivo relatar em dobro; o relato continuar depois do turno.
 *
 * Execução: npx ts-node src/__tests__/regression/S447_TurnoDeConversaRelatoEValidacaoDoTurno.test.ts
 */
import { AgentLoop } from '../../loop/AgentLoop';
import { montarRelatoDoTurno } from '../../loop/relatoDeProgresso';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}
const esperar = (ms: number) => new Promise(r => setTimeout(r, ms));
const proto = AgentLoop.prototype as any;

async function main(): Promise<void> {
    console.log('\n=== S447-1 — o texto do relato do turno: o fato disponível é o status ===');
    const t0 = Date.now() - 7 * 60_000;
    const comFerramenta = montarRelatoDoTurno(t0, Date.now(), { status: 'executing_tool', tool: 'exec_command' } as any);
    assert(/^⏳ Ainda estou trabalhando no seu pedido \(há 7 min\)\./.test(comFerramenta) && /▶ Agora: usando a ferramenta exec_command\./.test(comFerramenta) && /\/cancelar/.test(comFerramenta), 'tempo, ferramenta em uso e como parar', comFerramenta);
    assert(/montando a resposta/.test(montarRelatoDoTurno(t0, Date.now(), { status: 'synthesizing' } as any)), 'sintetizando → "montando a resposta"');
    assert(/pensando no próximo passo/.test(montarRelatoDoTurno(t0, Date.now())), 'sem status → "pensando no próximo passo"');

    console.log('\n=== S447-2 — turno de conversa longo relata; passo de objetivo não; o relato para com o turno ===');
    process.env.RELATO_DE_PROGRESSO_MIN = '0.02';   // 1,2 s
    const avisos: Array<{ canal: string; chatId: string; texto: string }> = [];
    const fake: any = {
        activeTurns: new Map([['conv-1', new AbortController()], ['conv-goal', new AbortController()]]),
        activeTurnStates: new Map([['conv-1', { semanticStatus: { status: 'executing_tool', tool: 'exec_command' } }]]),
        avisarUsuario: async (canal: string, chatId: string, texto: string) => { avisos.push({ canal, chatId, texto }); },
    };
    const parar = proto.iniciarRelatoDoTurno.call(fake, 'conv-1', { channel: 'telegram', chatId: '123' });
    const pararGoal = proto.iniciarRelatoDoTurno.call(fake, 'conv-goal', { channel: 'telegram', chatId: '456', goalTrace: { goalId: 'g1', stepId: 's1' } });
    await esperar(1500);
    parar(); pararGoal();
    const n = avisos.length;
    await esperar(1500);
    assert(n >= 1 && avisos.every(a => a.canal === 'telegram' && a.chatId === '123'), `o turno de conversa relatou no canal/conversa dele (${n})`, avisos);
    assert(/usando a ferramenta exec_command/.test(avisos[0]?.texto ?? ''), 'com o status atual do turno', avisos[0]?.texto);
    assert(!avisos.some(a => a.chatId === '456'), 'o passo de objetivo (goalTrace) não relata — o objetivo já relata o dele');
    assert(avisos.length === n, 'nenhum relato depois que o turno terminou');
    delete process.env.RELATO_DE_PROGRESSO_MIN;

    console.log('\n=== S447-3 — o próximo pedido da conversa interrompe a validação em segundo plano do anterior ===');
    const estados = new Map<string, any>();
    const sinais: AbortSignal[] = [];
    const fakeRun: any = {
        activeTurns: new Map<string, AbortController>(),
        activeTurnStates: estados,
        validacoesPorConversa: new Map<string, AbortController[]>(),
        iniciarRelatoDoTurno: () => () => {},
        clearActiveTurn: (id: string) => estados.delete(id),
        runWithTools: async (id: string) => { sinais.push(estados.get(id)?.validacoesEmSegundoPlano?.signal); return 'ok'; },
    };
    const r = await proto.run.call(fakeRun, 'conv-r', 'oi');
    assert(r === 'ok' && !!sinais[0], 'durante o turno, as validações recebem um sinal próprio');
    assert(sinais[0]?.aborted === false, 'o fim do turno NÃO interrompe (a validação termina depois da resposta e grava o aprendizado)');
    await proto.run.call(fakeRun, 'conv-outra', 'oi');
    assert(sinais[0]?.aborted === false, 'pedido de OUTRA conversa não interrompe');
    await proto.run.call(fakeRun, 'conv-r', 'passo 1 do objetivo', 'u', { channel: 'web', chatId: 'conv-r', goalTrace: { goalId: 'g', stepId: 's1' } });
    await proto.run.call(fakeRun, 'conv-r', 'passo 2 do objetivo', 'u', { channel: 'web', chatId: 'conv-r', goalTrace: { goalId: 'g', stepId: 's2' } });
    assert(sinais[0]?.aborted === false && sinais[2]?.aborted === false, 'passo de objetivo NÃO interrompe a validação do passo/turno anterior (senão quase nenhuma terminaria)');
    fakeRun.activeTurns.set('conv-r', new AbortController());   // um turno legítimo rodando nesta conversa
    await proto.run.call(fakeRun, 'conv-r', 'chamada concorrente');
    assert(sinais[0]?.aborted === false, 'chamada concorrente (será rejeitada) não interrompe as validações do turno ativo');
    fakeRun.activeTurns.delete('conv-r');
    await proto.run.call(fakeRun, 'conv-r', 'próximo pedido do usuário');
    assert([0, 2, 3, 4].every(i => sinais[i]?.aborted === true) && sinais[5]?.aborted === false,
        'o próximo pedido do USUÁRIO interrompe todas as validações pendentes da conversa e ganha a sua', sinais.map(s => s?.aborted));

    console.log('\n=== S447-4 — validação interrompida por um pedido novo não grava resultado ===');
    const ctrl = new AbortController();
    let gravou = false;
    let sinalRecebido: AbortSignal | undefined;
    const fakeVal: any = {
        getTurnState: () => ({ validacoesEmSegundoPlano: ctrl, pendingObserverFeedback: [] }),
        observer: { validate: async (...args: unknown[]) => { sinalRecebido = args[5] as AbortSignal; await esperar(100); return { approved: false, confidence: 0.9, reason: 'x' }; } },
        reflectionMemory: { record: () => { gravou = true; } },
        ts: () => '',
    };
    const p = proto.tryValidateTool.call(fakeVal, 'pedido', 'intent', 'conversation', 'exec_command', 'saída', [], 'trace-1', 'conv-v', 'resposta', {});
    ctrl.abort();   // um pedido novo chegou enquanto o juiz trabalhava
    await p;
    assert(sinalRecebido === ctrl.signal, 'o juiz em segundo plano recebe o sinal do turno');
    assert(!gravou, 'o resultado interrompido é descartado (não vai à ReflectionMemory)');

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S447 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    process.exit(failed > 0 ? 1 : 0);
}
main().catch((err) => { console.error('S447 erro inesperado:', err); process.exit(1); });
