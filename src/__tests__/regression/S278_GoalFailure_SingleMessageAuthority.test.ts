/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S278 (issue 020, Incremento 1)
 *
 * A mensagem que o usuário lê quando um goal falha tinha DUAS formas divergentes: 5 saídas do
 * `GoalExecutionLoop` usavam `GoalEvaluator.buildFailureExplanation()` (resumo seco, sem nada do que
 * o goal obteve) e apenas 1 passava por `GracefulDeliveryOrchestrator` — cuja mensagem substituía a
 * outra e perdia o fato "já enviei X". Política que vale num caminho e não nos outros (ADR-005 §5.1).
 *
 * Agora `GracefulDeliveryOrchestrator.buildFailureMessage()` é a autoridade ÚNICA. Este teste prova
 * isso em três frentes, porque "o texto parece igual" não prova que não sobrou um atalho:
 *
 *   1. ESTRUTURAL — o método antigo deixou de existir e nenhum ponto de `GoalExecutionLoop` o chama;
 *      todo ponto que produzia texto de falha genérica chama a autoridade.
 *   2. COMPORTAMENTAL — goals reais dirigidos por `runLoopInternal` até saídas de falha distintas
 *      terminam com a MESMA assinatura de mensagem.
 *   3. REGRAS — o que a mensagem pode e NÃO pode dizer. Principalmente: "existe um arquivo no
 *      disco" NÃO significa "existe um arquivo pronto para o usuário" — a autoridade nunca entrega,
 *      nunca oferece envio e nunca trata caminho/extensão como prova de entregabilidade.
 *
 * Fora do escopo de propósito (mensagem = razão própria e deliberada): expirou, abandonado por nova
 * mensagem, plano bloqueado antes de executar, aguardando autorização, falha de envio pós-validação.
 *
 * ATUALIZAÇÃO (22/09/2026, issue 029): a saída "progresso regredindo" (`evaluateProgress()` →
 * `'regressing'`) foi REMOVIDA — o S279 (issue 020) já tinha provado por enumeração exaustiva que
 * ela era código morto (a função nunca devolvia `'regressing'` de verdade; o gatilho só era
 * exercitado ali substituindo a implementação). Eram 6 saídas genéricas, agora são 5.
 *

 * Execução: npx ts-node src/__tests__/regression/S278_GoalFailure_SingleMessageAuthority.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { GoalEvaluator } from '../../loop/GoalEvaluator';
import { GracefulDeliveryOrchestrator } from '../../loop/GracefulDeliveryOrchestrator';
import { ToolRegistry } from '../../core/ToolRegistry';
import { permissionRegistry } from '../../core/PermissionRegistry';
import { OperationalMode } from '../../core/CapabilityMode';
import { Goal } from '../../loop/GoalTypes';
import { makeLoop, makeGoal, emptyState, channelContext } from './_fixtures/goalLoopHarness';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  OK ${message}`); passed++; }
    else { console.error(`  FALHOU: ${message}`, detail ?? ''); failed++; }
}

const SIGNATURE_HEAD = 'Não consegui completar';
const SIGNATURE_TAIL = 'Você pode reformular o pedido';

// ── scaffolding: loop REAL com LLM/planner/memória fakes (compartilhado com o S279) ─────────────

async function runFailingGoal(
    validationJson: object,
    toolName: string,
    execute: () => Promise<{ success: boolean; output: string; error?: string }>,
    over: Partial<Goal> = {},
) {
    ToolRegistry.register({ name: toolName, description: 'test', parameters: {}, execute });
    const { loop, goalStore } = makeLoop(validationJson);
    const goal = makeGoal(goalStore, [
        { id: 's1', description: 'passo', toolName, toolArgs: {}, status: 'pending', fallbackSteps: [] },
    ], over);
    const result: any = await (loop as any).runLoopInternal(goal, channelContext, undefined, 0, 0, undefined, emptyState(goal.id));
    return { result, stored: goalStore.getById(goal.id)!, loop };
}

async function main(): Promise<void> {
    const loopSrc = fs.readFileSync(path.resolve(__dirname, '../../loop/GoalExecutionLoop.ts'), 'utf8');
    const authoritySrc = fs.readFileSync(path.resolve(__dirname, '../../loop/GracefulDeliveryOrchestrator.ts'), 'utf8');

    // ── 1. ESTRUTURAL ────────────────────────────────────────────────────────────────────────
    console.log('\n=== S278.1 [estrutural] — não existe mais um caminho paralelo para o texto de falha ===');
    {
        assert(typeof (new GoalEvaluator() as any).buildFailureExplanation === 'undefined',
            'GoalEvaluator.buildFailureExplanation deixou de existir — o compilador impede qualquer chamada direta');
        assert(!/\.buildFailureExplanation\s*\(/.test(loopSrc),
            'nenhum ponto de GoalExecutionLoop chama buildFailureExplanation');

        // Contagem MÍNIMA, não exata: a partir da issue 028 (expiração/abandono, categoria
        // distinta) o arquivo ganhou MAIS chamadas legítimas à mesma autoridade — um número fixo
        // aqui quebraria a cada categoria nova que reusar a autoridade, o que é o comportamento
        // desejado, não uma regressão. As 5 saídas de FALHA GENÉRICA desta issue são verificadas
        // individualmente abaixo, por conteúdo, não por contagem total.
        const calls = loopSrc.match(/this\.gracefulDelivery\.buildFailureMessage\(/g) ?? [];
        assert(calls.length >= 5,
            'pelo menos os 5 pontos que produzem o texto genérico de falha (4 saídas + fallback de buildResult) chamam a autoridade única — ' +
            'a saída "progresso regredindo" foi REMOVIDA (issue 029: evaluateProgress() nunca era alcançada, dead code)', calls.length);

        // Cada saída de falha genérica, pelo trecho que a antecede — não basta contar chamadas.
        const exits: Array<[string, RegExp]> = [
            ['replan budget zerado (blocked)', /goalStore\.setStatus\(goal\.id, 'failed'\);\s*const explanation = this\.gracefulDelivery\.buildFailureMessage\(goal, state\.cognitiveContext\);\s*await onProgress/],
            ['outcome failed (motivo do chamador)', /buildFailureMessage\(goal, state\.cognitiveContext, cycleResult\.output\)/],
            ['validação final com replan budget esgotado', /buildFailureMessage\(goal, state\.cognitiveContext, validation\.reason\)/],
            ['MAX_CYCLES', /setStatus\(currentGoal\.id, 'failed'\);\s*const explanation = this\.gracefulDelivery\.buildFailureMessage\(currentGoal, state\.cognitiveContext\)/],
            ['fallback de última instância de buildResult', /: this\.gracefulDelivery\.buildFailureMessage\(goal\)\);/],
        ];
        for (const [name, re] of exits) {
            assert(re.test(loopSrc), `saída "${name}" passa pela autoridade única`);
        }

        const evaluatorSrc = fs.readFileSync(path.resolve(__dirname, '../../loop/GoalEvaluator.ts'), 'utf8');
        assert(!/evaluateProgress/.test(loopSrc), 'GoalExecutionLoop não chama mais evaluateProgress() (issue 029)', loopSrc.includes('evaluateProgress'));
        assert(!/evaluateProgress/.test(evaluatorSrc), 'GoalEvaluator.evaluateProgress() foi removido, não só deixou de ser chamado', evaluatorSrc.includes('evaluateProgress'));
        assert(!/'regressing'|'stalled'/.test(evaluatorSrc), 'os estados mortos "regressing"/"stalled" não sobrevivem em nenhuma assinatura', evaluatorSrc);
    }

    // ── 2. COMPORTAMENTAL ─────────────────────────────────────────────────────────────────────
    console.log('\n=== S278.2 [comportamental] — goals reais em saídas de falha DISTINTAS terminam com a mesma assinatura ===');
    permissionRegistry.setMode(OperationalMode.DEVELOPER, 'test-s278', true);
    try {
        // A — erro genérico com replan budget zerado (saída "blocked").
        const a = await runFailingGoal({ achieved: true }, '__s278_a__',
            async () => ({ success: false, output: '', error: 'falha genérica xyz' }), { replanBudget: 0 });
        assert(a.stored.status === 'failed' && a.result.success === false, 'A: o goal termina failed', a.stored.status);
        assert(a.result.finalOutput.includes(SIGNATURE_HEAD) && a.result.finalOutput.includes(SIGNATURE_TAIL),
            'A: mensagem com a assinatura da autoridade única (cabeça + próximo passo)', a.result.finalOutput);
        assert(a.result.finalOutput.includes('Tentei: __s278_a__.'), 'A: informa a ferramenta realmente tentada', a.result.finalOutput);

        // B — dependência já tentada: outcome 'failed' com motivo específico do chamador.
        const b = await runFailingGoal({ achieved: true }, '__s278_b__',
            async () => ({ success: false, output: '', error: 'spawn pandoc ENOENT' }), { strategiesTried: ['install_dep_pandoc'] });
        assert(b.stored.status === 'failed', 'B: o goal termina failed', b.stored.status);
        assert(b.result.finalOutput.includes(SIGNATURE_HEAD) && b.result.finalOutput.includes(SIGNATURE_TAIL),
            'B: mesma assinatura — o motivo específico virou fato de entrada, não substituiu a mensagem', b.result.finalOutput);
        assert(/O que aconteceu:.*pandoc/s.test(b.result.finalOutput),
            'B: a instrução acionável do motivo ("pandoc não pôde ser instalado...") continua presente', b.result.finalOutput);

        // C — validação final falha com replan budget esgotado (era a única saída que já usava o orquestrador).
        const c = await runFailingGoal({ achieved: false, reason: 'o arquivo pedido não foi gerado' }, '__s278_c__',
            async () => ({ success: true, output: 'passo executado sem produzir o arquivo' }), { replanBudget: 0 });
        assert(c.stored.status === 'failed', 'C: o goal termina failed', c.stored.status);
        assert(c.result.finalOutput.includes(SIGNATURE_HEAD) && c.result.finalOutput.includes(SIGNATURE_TAIL),
            'C: mesma assinatura', c.result.finalOutput);
        assert(c.result.finalOutput.includes('o arquivo pedido não foi gerado'), 'C: o motivo da validação é preservado', c.result.finalOutput);
    } finally {
        permissionRegistry.setMode(OperationalMode.SAFE, 'test-s278-restore');
    }

    // ── 3. REGRAS ─────────────────────────────────────────────────────────────────────────────
    console.log('\n=== S278.3 [regras] — "existe um arquivo no disco" NÃO é "existe um arquivo pronto para o usuário" ===');
    {
        const authority = new GracefulDeliveryOrchestrator();
        const { goalStore } = makeLoop({ achieved: true });
        const goal = makeGoal(goalStore, [], {
            toolsTried: ['write', 'exec_command'],
            attempts: [
                { id: 'a1', planStepId: 's1', toolName: 'write', args: { path: 'tmp/reciclagem_plastico.md' }, result: 'success', durationMs: 5, executedAt: Date.now() },
                { id: 'a2', planStepId: 's2', toolName: 'write', args: { path: 'tmp/slides.html' }, result: 'success', durationMs: 5, executedAt: Date.now() },
                { id: 'a3', planStepId: 's3', toolName: 'exec_command', args: { command: 'bash scripts/html2pdf.sh tmp/slides.html' }, result: 'failure', error: 'bash: command not found', durationMs: 5, executedAt: Date.now() },
            ],
            blockers: [{ kind: 'tool_error', description: 'a conversão para PDF falhou', suggestedActions: [], detectedAt: Date.now() }],
        });
        const msg = authority.buildFailureMessage(goal, undefined, undefined);

        assert(msg.includes('tmp/reciclagem_plastico.md') && msg.includes('tmp/slides.html'),
            'os arquivos que existem são informados como FATO');
        assert(/NÃO foram enviados a você/.test(msg), 'e ditos explicitamente como NÃO enviados', msg);
        assert(/podem estar incompletos/.test(msg), 'sem afirmar que estão prontos', msg);
        assert(!/send_document|posso enviar|vou enviar|enviarei|quer que eu envie/i.test(msg),
            'a mensagem NÃO oferece nem promete envio — a decisão de entregar não é deste componente', msg);
        assert(msg.includes('a conversão para PDF falhou'), 'o que faltou (último bloqueio) é dito', msg);
        assert(msg.includes(SIGNATURE_TAIL), 'e há um próximo passo acionável', msg);

        // Arquivo JÁ entregue não é "pendente", e o fato "já enviei" não se perde (regressão do
        // caminho antigo do orquestrador, que substituía a mensagem e o perdia).
        const goal2 = makeGoal(goalStore, [], {
            sentArtifacts: ['tmp/slides.pdf'],
            attempts: [{ id: 'b1', planStepId: 's1', toolName: 'write', args: { path: 'tmp/slides.pdf' }, result: 'success', durationMs: 5, executedAt: Date.now() }],
        });
        const msg2 = authority.buildFailureMessage(goal2);
        assert(msg2.startsWith('Consegui gerar e enviar: tmp/slides.pdf.'), 'o que JÁ foi entregue abre a mensagem', msg2);
        assert(!/NÃO foram enviados/.test(msg2), 'um arquivo já entregue não aparece como pendente', msg2);

        // Incidente da S73: campos internos de replanejamento nunca vazam.
        const goal3 = makeGoal(goalStore, [], { strategiesTried: ["memory_search: x [ATENÇÃO — tentativa anterior retornou output irrelevante"], toolsTried: ['memory_search'] });
        const msg3 = authority.buildFailureMessage(goal3);
        assert(!msg3.includes('[ATENÇÃO —') && msg3.includes('Tentei: memory_search.'), 'strategiesTried não vaza; toolsTried é usado', msg3);

        // O motivo do chamador não é duplicado pelo último bloqueio.
        const goal4 = makeGoal(goalStore, [], { blockers: [{ kind: 'tool_error', description: 'pandoc ausente', suggestedActions: [], detectedAt: Date.now() }] });
        const msg4 = authority.buildFailureMessage(goal4, undefined, "O 'pandoc ausente' impediu a conversão");
        assert((msg4.match(/pandoc ausente/g) ?? []).length === 1, 'motivo que já contém o bloqueio não o repete em "O que faltou"', msg4);

        // PROCEDÊNCIA (achado da validação real de 21/09/2026): uma afirmação do modelo NÃO é um fato.
        // Sob "Informações coletadas" apareceu "O arquivo de apresentação foi enviado" — narração do LLM
        // (cognitiveContext.importantOutputs), FALSA, numa mensagem cujo objetivo é dizer a verdade.
        const goal5 = makeGoal(goalStore, [], {
            toolsTried: ['agentloop'],
            attempts: [
                { id: 'c1', planStepId: 's1', toolName: 'web_search', args: {}, result: 'success', output: 'Consulta: reciclagem de plástico\n\nResultados agregados: 5 fontes sobre PET e HDPE', durationMs: 5, executedAt: Date.now() },
                { id: 'c2', planStepId: 's2', toolName: 'web_search', args: {}, result: 'success', output: 'Consulta: reciclagem de plástico   Resultados agregados: 5 fontes sobre PET e HDPE', durationMs: 5, executedAt: Date.now() },
                { id: 'c3', planStepId: 's3', toolName: 'agentloop', args: {}, result: 'success', output: 'Pronto! O arquivo de apresentação foi enviado conforme seu pedido.', durationMs: 5, executedAt: Date.now() },
            ],
        });
        const narrativeCtx = {
            filesRead: [], filesModified: [], discoveries: [], failedStrategies: [], executedCommands: [],
            importantOutputs: ['Pronto para o próximo passo. O arquivo de apresentação foi enviado e estruturado conforme seu pedido.'],
            generatedArtifacts: ['arquivo-que-so-existe-na-narracao.pptx'],
        };
        const msg5 = authority.buildFailureMessage(goal5, narrativeCtx as any);
        assert(!/foi enviado/i.test(msg5), 'narração do modelo ("o arquivo foi enviado") NÃO entra como informação coletada', msg5);
        assert(!msg5.includes('arquivo-que-so-existe-na-narracao.pptx'), 'caminho vindo só de regex sobre narração NÃO vira "arquivo criado"', msg5);
        assert(msg5.includes('Resultados agregados: 5 fontes'), 'o resultado de FERRAMENTA (web_search) continua sendo informado', msg5);
        assert((msg5.match(/Resultados agregados/g) ?? []).length === 1, 'a mesma busca não aparece duas vezes (deduplicada)', msg5);
        assert(!/\n\s*\n\s*Resultados/.test(msg5.split('Informações coletadas:')[1] ?? ''), 'cada informação é uma linha só (quebras internas viram espaço)', msg5);

        // Caminho declarado pela própria FERRAMENTA (inclui steps agentloop) é fato e entra como "não enviado".
        const goal6 = makeGoal(goalStore, [], {
            attempts: [{ id: 'd1', planStepId: 's1', toolName: 'agentloop', args: {}, result: 'success', durationMs: 5, executedAt: Date.now(), producedArtifactPaths: ['tmp/apresentacao.pptx'] }],
        });
        const msg6 = authority.buildFailureMessage(goal6);
        assert(msg6.includes('tmp/apresentacao.pptx') && /NÃO foram enviados a você/.test(msg6), 'producedArtifactPaths (declarado pela tool) é informado como NÃO enviado', msg6);

        // Achado da 2ª validação real (21/09/2026): o mesmo arquivo aparecia duas vezes, e o caminho
        // absoluto vazava o nome de usuário e a estrutura de pastas do servidor para o canal.
        const goal7 = makeGoal(goalStore, [], {
            attempts: [
                { id: 'e1', planStepId: 's1', toolName: 'write', args: { path: 'tmp/gerar_pptx.py' }, result: 'success', durationMs: 5, executedAt: Date.now() },
                { id: 'e2', planStepId: 's2', toolName: 'write', args: { path: 'C:\\Users\\alguem\\AppData\\Local\\Temp\\workspace\\tmp\\gerar_pptx.py' }, result: 'success', durationMs: 5, executedAt: Date.now() },
                { id: 'e3', planStepId: 's3', toolName: 'write', args: { path: '/home/alguem/workspace/apenas_absoluto.txt' }, result: 'success', durationMs: 5, executedAt: Date.now() },
            ],
        });
        const msg7 = authority.buildFailureMessage(goal7);
        assert((msg7.match(/gerar_pptx\.py/g) ?? []).length === 1, 'o mesmo arquivo (relativo + absoluto) aparece UMA vez só', msg7);
        assert(msg7.includes('`tmp/gerar_pptx.py`'), 'prefere o caminho relativo ao workspace', msg7);
        assert(!/alguem|AppData|C:\\|\/home\//.test(msg7), 'nenhum caminho absoluto (nome de usuário / pastas do servidor) vaza para o usuário', msg7);
        assert(msg7.includes('`apenas_absoluto.txt`'), 'se só existe o absoluto, mostra apenas o nome do arquivo', msg7);

        // A autoridade não entrega: nenhuma referência a canal/envio no código do componente.
        assert(!/channelContext|deliveryTracking|sendDocument|\.execute\s*\(/.test(authoritySrc.replace(/\/\*[\s\S]*?\*\//g, '')),
            'o orquestrador (fora dos comentários) não tem como enviar nada: só devolve texto');
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S278 RESULTADO: ${passed} passou | ${failed} falhou`);
    if (failed > 0) process.exit(1);
    process.exit(0);
}

main().catch(err => { console.error('S278 erro inesperado:', err); process.exit(1); });
