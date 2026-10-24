/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S448 (ADR-028)
 * (1) Apagar e mesclar nós da memória (memory_write delete/merge, memory_admin cleanup) só com a confirmação da dona, em TODOS
 *     os modos — inclusive GOD, em que as duas produções rodam. O pedido diz o que sai por nome e conteúdo, não por id.
 * (2) O que as ferramentas mudaram no turno chega a ela SEMPRE — inclusive quando o juiz bloqueia a resposta e no pedido de
 *     confirmação; e a resposta da aprovação diz o que foi apagado.
 *
 * ORIGEM: produção Windows, 23/10/2026 20:32. "Consegue verificar sua memória?" — o agente, sem pedir, mesclou 2 pares,
 * atualizou 2 nós e apagou pref_workspace; o juiz bloqueou a resposta inteira e ela nunca soube de nenhuma mudança.
 *
 * REGRESSÃO SE: uma dessas ações executar sem perguntar em algum modo; uma leitura passar a perguntar; o pedido mostrar só
 * ids; a lista "o que foi alterado" sumir de uma resposta (bloqueada, de confirmação, de aprovação) ou aparecer num passo de
 * objetivo ou na recusa de turno concorrente.
 *
 * Execução: npx ts-node src/__tests__/regression/S448_MemoriaApagarSoComConfirmacao.test.ts
 */
import Database from 'better-sqlite3';
import { MemoryManager } from '../../memory/MemoryManager';
import { MemoryWriteTool } from '../../tools/memory_write';
import { MemoryAdminTool } from '../../tools/memory_admin';
import { EmbeddingService } from '../../memory/EmbeddingService';
import { ToolRegistry } from '../../core/ToolRegistry';
import { permissionRegistry } from '../../core/PermissionRegistry';
import { OperationalMode } from '../../core/CapabilityMode';
import { AuthorizationManager } from '../../loop/AuthorizationManager';
import { WorkflowEngine } from '../../loop/WorkflowEngine';
import { AgentLoop } from '../../loop/AgentLoop';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

// Sem servidor de embedding: as chamadas falham rápido e o teste não depende de rede.
(globalThis as any).fetch = async () => { throw new Error('sem rede no teste'); };
const proto = AgentLoop.prototype as any;

async function main(): Promise<void> {
    const db = new (Database as any)(':memory:');
    new EmbeddingService(db);
    const mm = new MemoryManager(db, 'http://mock-ollama:11434');
    const escrita = new MemoryWriteTool(mm);
    const admin = new MemoryAdminTool(mm);
    ToolRegistry.register(escrita);
    ToolRegistry.register(admin);

    await escrita.execute({ action: 'create', id: 'pref_workspace', type: 'context', name: 'Workspace', content: 'Workspace principal do NewClaw em /newclaw/workspace' });
    await escrita.execute({ action: 'create', id: 'slides_a', type: 'fact', name: 'Slides da aula', content: 'Slides da aula de redes ficam na pasta aulas/redes' });
    await escrita.execute({ action: 'create', id: 'slides_b', type: 'fact', name: 'Slides da aula', content: 'Slides da aula de redes: pasta aulas/redes, versão final' });
    db.prepare("INSERT INTO memory_nodes (id, type, name, content) VALUES ('fantasma_1', 'fact', 'Fantasma', '')").run();

    const apagar = { action: 'delete', id: 'pref_workspace' };
    const mesclar = { action: 'merge', id: 'slides_a', merge_ids: ['slides_b'] };
    const limpar = { action: 'cleanup' };

    console.log('\n=== S448-1 — apagar/mesclar/limpar pedem confirmação em TODOS os modos; leitura e escrita comum não ===');
    for (const modo of [OperationalMode.SAFE, OperationalMode.DEVELOPER, OperationalMode.GOD]) {
        permissionRegistry.setMode(modo, 'test-s448', true);
        assert(ToolRegistry.requiresAuthorization('memory_write', apagar), `${modo}: apagar pede confirmação`);
        assert(ToolRegistry.requiresAuthorization('memory_write', mesclar), `${modo}: mesclar pede confirmação`);
        assert(ToolRegistry.requiresAuthorization('memory_admin', limpar), `${modo}: limpeza pede confirmação`);
        assert(!ToolRegistry.requiresAuthorization('memory_write', { action: 'update', id: 'slides_a', content: 'x' })
            && !ToolRegistry.requiresAuthorization('memory_write', { action: 'create', content: 'algo novo' })
            && !ToolRegistry.requiresAuthorization('memory_admin', { action: 'duplicates' }), `${modo}: criar/atualizar/ler seguem sem perguntar`);
    }
    assert(!ToolRegistry.requiresAuthorization('memory_write', { action: 'delete', id: 'nao_existe' })
        && !ToolRegistry.requiresAuthorization('memory_write', { action: 'delete', id: 'core_user' }),
        'nada a apagar (nó inexistente ou protegido, que a execução recusa) → não pergunta à toa');

    console.log('\n=== S448-2 — o pedido de confirmação diz o que sai por nome e conteúdo ===');
    const auth = new AuthorizationManager();
    const pedido = auth.formatRequest('memory_write', apagar, 'txn-x').text;
    assert(pedido.includes('Apagar uma informação da memória') && pedido.includes('"Workspace" (context) — Workspace principal do NewClaw'),
        'apagar: nome, tipo e o começo do conteúdo', pedido);
    assert(/só volta restaurando um backup/.test(pedido), 'avisa que não se desfaz pelo chat', pedido);
    const pedidoMerge = auth.formatRequest('memory_write', mesclar).text;
    assert(/Fica: "Slides da aula"/.test(pedidoMerge) && /Sai \(o texto vai para a que fica\): "Slides da aula" \(fact\) — Slides da aula de redes: pasta aulas\/redes, versão final/.test(pedidoMerge),
        'mesclar: o que fica e o que sai', pedidoMerge);
    const pedidoLimpeza = auth.formatRequest('memory_admin', limpar).text;
    assert(/apagar 1 informação/.test(pedidoLimpeza) && /"Fantasma" \(fact\) — vazio/.test(pedidoLimpeza), 'limpeza: quantos e quais', pedidoLimpeza);

    console.log('\n=== S448-3 — aprovado: executa, e a resposta da aprovação diz o que foi apagado ===');
    const wf = new WorkflowEngine();
    const txn = wf.createTransaction('conv-a', 'memory_write', apagar, { workflow: 'memoria', step: 'memory_write', userGoal: 'verificar a memória' });
    const r = await wf.resume(txn.id, 'approved', (n) => ToolRegistry.get(n));
    assert(r?.success === true && !mm.getNode('pref_workspace'), 'o nó foi apagado só depois do "sim"', r);
    assert(r?.alteracao?.startsWith('Apagou: "Workspace" (context)') === true, 'a execução registra o que apagou, pelo nome', r?.alteracao);
    const fakeResume: any = { authManager: { removePending: () => {} }, profileRegistry: { getProfileByCategory: () => undefined } };
    const respostaAprovada: string = await proto.resumeFromWorkflow.call(fakeResume, 'conv-a', r);
    assert(/📝 O que foi alterado neste turno:\n• Apagou: "Workspace"/.test(respostaAprovada), 'a resposta da aprovação traz o recibo', respostaAprovada);
    const recusa = wf.createTransaction('conv-a', 'memory_write', mesclar, { workflow: 'memoria', step: 'memory_write', userGoal: 'x' });
    await wf.resume(recusa.id, 'rejected', (n) => ToolRegistry.get(n));
    assert(!!mm.getNode('slides_b'), 'recusado: nada sai');

    console.log('\n=== S448-4 — mesclar e limpar também contam o que mudou, pelo nome ===');
    const m = await escrita.execute(mesclar);
    assert(m.alteracao === 'Juntou em "Slides da aula" (as outras foram apagadas): "Slides da aula"', 'merge', m.alteracao);
    const l = await admin.execute(limpar);
    assert(/^Apagou 1 informação\(ões\) vazia\(s\) ou solta\(s\): "Fantasma"/.test(l.alteracao ?? ''), 'cleanup', l.alteracao);
    const leitura = await admin.execute({ action: 'stats' });
    assert(leitura.alteracao === undefined, 'leitura não declara alteração');

    console.log('\n=== S448-5 — run(): a lista vai junto de QUALQUER resposta do turno; passo de objetivo e recusa concorrente não ===');
    const estados = new Map<string, any>();
    const fakeRun = (resposta: unknown, alteracoes: string[]): any => ({
        activeTurns: new Map<string, AbortController>(),
        activeTurnStates: estados,
        validacoesPorConversa: new Map(),
        iniciarRelatoDoTurno: () => () => {},
        clearActiveTurn: () => {},
        runWithTools: async (id: string) => { estados.get(id).alteracoes = [...alteracoes]; return resposta; },
    });
    const bloqueada = (AgentLoop as any).groundingBlockedMessage('NOT_EVALUABLE', [{ claim: 'os dois nós foram criados 1 segundo apartados', verdict: 'NOT_EVALUABLE' }]);
    const r1 = await proto.run.call(fakeRun(bloqueada, ['Juntou em "Slides"', 'Apagou: "Workspace"']), 'conv-b', 'verifique a memória');
    assert(typeof r1 === 'string' && r1.startsWith('Não encontrei, nas fontes') && /📝 O que foi alterado neste turno:\n• Juntou em "Slides"\n• Apagou: "Workspace"$/.test(r1),
        'resposta BLOQUEADA pelo juiz: o aviso e, depois, o que mudou', r1);
    const r2 = await proto.run.call(fakeRun({ text: '🗑️ **Apagar uma informação da memória**', options: [{ label: 'Sim', value: 'auth:approve:t' }] }, ['Atualizou: "Cripto"']), 'conv-c', 'x');
    assert(/Apagar uma informação[\s\S]*• Atualizou: "Cripto"/.test(r2.text) && r2.options?.length === 1, 'pedido de confirmação: diz o que já mudou antes dele, botões intactos', r2);
    const r3 = await proto.run.call(fakeRun('Pronto, não mudei nada.', []), 'conv-d', 'x');
    assert(r3 === 'Pronto, não mudei nada.', 'turno sem mudanças: resposta intacta');
    const r4 = await proto.run.call(fakeRun('resultado do passo', ['Apagou: "X"']), 'conv-e', 'x', 'u', { channel: 'web', chatId: 'conv-e', goalTrace: { goalId: 'g', stepId: 's1' } });
    assert(r4 === 'resultado do passo', 'passo de objetivo: o texto é material do objetivo, sem a lista');
    const r5 = await proto.run.call(fakeRun({ text: 'Ainda estou trabalhando no pedido anterior.', concurrentTurnRejected: true }, ['Apagou: "X"']), 'conv-f', 'x');
    assert(!/O que foi alterado/.test(r5.text), 'recusa de turno concorrente: sem a lista (as mudanças são do outro turno)', r5);

    const estado: any = {};
    const fakeReg: any = { getTurnState: () => estado };
    proto.registrarAlteracao.call(fakeReg, 'c', { success: true, output: '', alteracao: 'Apagou: "A"' });
    proto.registrarAlteracao.call(fakeReg, 'c', { success: false, output: '', alteracao: 'Apagou: "B"' });
    proto.registrarAlteracao.call(fakeReg, 'c', { success: true, output: 'leitura' });
    assert(JSON.stringify(estado.alteracoes) === JSON.stringify(['Apagou: "A"']), 'só chamada bem-sucedida que mudou algo entra na lista', estado);
    const fs = await import('fs');
    const loopSrc = fs.readFileSync(require.resolve('../../loop/AgentLoop.ts'), 'utf-8');
    const pontos = loopSrc.split("traceManager.addStep(trace, 'tool_result'").length - 1;
    const registros = loopSrc.split('this.registrarAlteracao(conversationId,').length - 1;
    assert(registros >= 3 && registros === pontos - 2, `todo despacho com sucesso registra (${registros} registros; os outros ${pontos - registros} tool_result são falha do atalho e entrega de documento)`);

    console.log('\n=== S448-6 — painel web: o cartão de aprovação descreve a ação de memória ===');
    const rota = fs.readFileSync(require.resolve('../../dashboard/routes/chat.ts'), 'utf-8');
    assert(/ToolRegistry\.confirmacaoDoDono\(t\.tool/.test(rota), 'o detalhe do cartão vem da mesma descrição do pedido');

    permissionRegistry.setMode(OperationalMode.SAFE, 'test-s448-restore');
    db.close();
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S448 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('S448 erro inesperado:', e); process.exit(1); });
