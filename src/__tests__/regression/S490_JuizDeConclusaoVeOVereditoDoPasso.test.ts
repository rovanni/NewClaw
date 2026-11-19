/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S490 (18/11/2026, dois desvios do laço de objetivos na validação real da ADR-041)
 *
 * S490-1/2 — "Crie um agendamento: toda segunda-feira às 9h…" (goal_1795025275187_fhknb, instância isolada, Bonsai 27B).
 *   O `schedule` gravou `0 9 * * *` (todo dia). O juiz do passo acusou ("indica '9h todo dia' em vez de 'toda
 *   segunda-feira'", 0.90) e a tentativa foi rebaixada para `partial`. O replanejamento trocou para `memory_write`, e o juiz
 *   de conclusão aprovou: a resposta disse "toda segunda-feira às 9h", com a tarefa diária errada ativa. Causa: o juiz de
 *   conclusão só recebia tentativas `success` (o efeito real e o veredito do passo sumiam), e a descrição do passo era
 *   procurada no plano ATUAL pelo id ("step_1" se repete a cada replanejamento) — o `memory_write` da geração anterior saía
 *   rotulado "Confirmar a persistência do agendamento semanal na memória".
 *
 * S490-3 — "Crie um agendamento para me mandar a cotação do bitcoin todo dia às 8:30 e às 12h." (goal_1795025642336_u08mf).
 *   O roteador classificou o mesmo tipo de pedido como `creation`, `memory_operation` e `system_operation` em três turnos;
 *   as duas primeiras impõem contrato de resposta em texto, e o plano certo `[schedule, schedule, read]` foi rejeitado
 *   (`response_contract_without_answer_step`). As definições das categorias não falavam de agendamento nem de lembrete:
 *   o classificador adivinhava. Decisão da operadora (18/11): a decisão fica com o roteador; ele passa a receber a
 *   definição que faltava. A prova de comportamento é a execução real (Validação Progressiva, etapa 4); este teste trava
 *   a informação que o classificador recebe.
 *
 * Execução: npx ts-node src/__tests__/regression/S490_JuizDeConclusaoVeOVereditoDoPasso.test.ts
 */
import Database from 'better-sqlite3';
import { GoalExecutionLoop } from '../../loop/GoalExecutionLoop';
import { GoalStore } from '../../loop/GoalStore';
import { buildClassificationMessages } from '../../loop/UnifiedIntentRouter';
import { ensureResponseContractCriterion, findResponseContractGap } from '../../loop/planning/ensureDeliverySuccessCriteria';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

const SAIDA_DO_SCHEDULE = '✅ Agendamento criado!\n📋 ID: #1\n🏷️ Agendamento custom\n⏰ 9h todo dia\n📌 Tipo: custom\n\nVou te enviar automaticamente nesses horários!';
const MOTIVO = "O resultado da ferramenta confirma a criação do agendamento, mas indica '9h todo dia' em vez de 'toda segunda-feira'.";

/** As tentativas do goal real, como ficaram gravadas no banco da instância (gerações 0–3). */
function goalDoDesvio1(): any {
    return {
        planGeneration: 3,
        currentPlan: [{ id: 'step_1', description: 'Confirmar a persistência do agendamento semanal na memória', status: 'completed' }],
        attempts: [
            { planGeneration: 0, planStepId: 'step_1', toolName: 'schedule', result: 'failure', output: '', args: {} },
            { planGeneration: 1, planStepId: 'step_1', toolName: 'schedule', result: 'partial', output: SAIDA_DO_SCHEDULE, args: {},
              vereditoDoPasso: { motivo: MOTIVO, confianca: 0.9 } },
            { planGeneration: 2, planStepId: 'step_1', toolName: 'memory_write', result: 'success', output: '✅ Nó "recurso_semanal" (preference) criado.', args: {} },
            { planGeneration: 2, planStepId: 'step_2', toolName: 'memory_write', result: 'failure', output: '', args: {} },
            { planGeneration: 3, planStepId: 'step_1', toolName: 'memory_write', result: 'success', output: '✅ Execução de "recurso_semanal" registrada como success.', args: {} },
        ],
    };
}

async function main(): Promise<void> {

console.log('\n=== S490-1 — o juiz de conclusão recebe o efeito real e o veredito do passo ===');
{
    const r = (GoalExecutionLoop as any).resultadosParaOJuiz(goalDoDesvio1(), { saidasCompletas: new Map() }, 30_000);
    const linhas: string[] = r.ferramentas.split('\n- ');
    const doSchedule = linhas.find(l => l.includes('schedule'));
    assert(!!doSchedule && doSchedule.includes('9h todo dia'), 'a tentativa rebaixada do schedule entra, com o efeito que ficou no sistema ("9h todo dia")', r.ferramentas);
    assert(!!doSchedule && doSchedule.includes(MOTIVO) && doSchedule.includes('0.90'), 'o motivo e a confiança do juiz do passo vão junto dela', doSchedule);
    assert(!!doSchedule && /o efeito dela continua no sistema/.test(doSchedule), 'o juiz é avisado de que a ferramenta rodou (não é falha sem efeito)', doSchedule);
    assert(!r.ferramentas.includes('campo') && (r.ferramentas.match(/memory_write/g) ?? []).length === 2, 'falhas sem efeito continuam de fora; os dois sucessos entram', r.ferramentas);

    const daGeracao2 = linhas.find(l => l.includes('recurso_semanal" (preference) criado'));
    assert(!!daGeracao2 && !daGeracao2.includes('Confirmar a persistência'), 'tentativa de geração anterior NÃO herda a descrição do passo novo de mesmo id', daGeracao2);
    assert(!!daGeracao2 && daGeracao2.includes('de uma estratégia anterior do plano'), 'e diz que veio de uma estratégia anterior', daGeracao2);
    const daGeracao3 = linhas.find(l => l.includes('registrada como success'));
    assert(!!daGeracao3 && daGeracao3.includes('(passo: Confirmar a persistência'), 'a tentativa da geração atual mantém a descrição do seu passo', daGeracao3);

    const semVeredito = goalDoDesvio1();
    delete semVeredito.attempts[1].vereditoDoPasso;
    const r2 = (GoalExecutionLoop as any).resultadosParaOJuiz(semVeredito, { saidasCompletas: new Map() }, 30_000);
    assert(/resultado não confirmado/.test(r2.ferramentas) && !r2.ferramentas.includes('acusou'), 'partial sem veredito gravado (legado): "resultado não confirmado", sem inventar motivo', r2.ferramentas);
}

console.log('\n=== S490-2 — o rebaixamento grava o veredito na própria tentativa ===');
{
    const db = new Database(':memory:');
    const store = new GoalStore(db as any);
    const g = store.create({
        sessionKey: 's490', conversationId: 'c490', userIntent: 'toda segunda às 9h', objective: 'agendar', status: 'active',
        currentPlan: [], attempts: [], blockers: [], toolsTried: [], strategiesTried: [], nextAction: null, cycleFocus: null,
        retryBudget: 5, replanBudget: 3, confidence: 0.8, requiresAuth: false, authorizationScope: [], pendingTxnId: null,
        expiresAt: Date.now() + 60_000, completedAt: null, isConstruction: false, roadmap: [], currentMilestoneIndex: 0,
        allowRoadmapAdjustment: true, successCriteria: [], sentArtifacts: [],
    } as any);
    store.addAttempt(g.id, { id: 'a1', planStepId: 'step_1', toolName: 'schedule', result: 'success', output: SAIDA_DO_SCHEDULE, args: {}, durationMs: 1, executedAt: Date.now() } as any);
    store.downgradeLastAttemptToPartial(g.id, 'step_1', { motivo: MOTIVO, confianca: 0.9 });
    const a = store.getById(g.id)!.attempts[0];
    assert(a.result === 'partial' && a.vereditoDoPasso?.motivo === MOTIVO && a.vereditoDoPasso?.confianca === 0.9, 'persistido no banco: partial + motivo + confiança', a);
    assert(a.evaluation === undefined, '`evaluation` (avaliação heurística) não é tocado', a.evaluation);
}

console.log('\n=== S490-3 — o roteador recebe a definição de agendamento e lembrete ===');
{
    const sistema = buildClassificationMessages('Crie um agendamento para me mandar a cotação do bitcoin todo dia às 8:30 e às 12h.')[0].content;
    const linha = (cat: string) => sistema.split('\n').find(l => l.startsWith(`- ${cat}:`)) ?? '';
    assert(/schedules, reminders at a date\/time and recurring tasks/.test(linha('system_operation')), 'system_operation inclui criar/listar/mudar/apagar agendamentos, lembretes e tarefas recorrentes', linha('system_operation'));
    assert(/schedule or reminder is not content: see system_operation/.test(linha('creation')), 'creation diz que agendamento não é conteúdo', linha('creation'));
    assert(/reminder at a date\/time is a schedule: see system_operation/.test(linha('memory_operation')), 'memory_operation diz que lembrete com hora é agendamento', linha('memory_operation'));

    // O efeito da categoria no contrato (inalterado, documentado aqui): system_operation não impõe resposta em texto,
    // e o plano do desvio passa na admissão.
    const plano: any[] = [{ id: 'step_1', toolName: 'schedule' }, { id: 'step_2', toolName: 'schedule' }, { id: 'step_3', toolName: 'read' }];
    const comoSistema = ensureResponseContractCriterion('system_operation', [], plano);
    assert(findResponseContractGap(plano, comoSistema) === null, 'classificado como system_operation, [schedule, schedule, read] é admitido');
    const comoCriacao = ensureResponseContractCriterion('creation', [], plano);
    assert(findResponseContractGap(plano, comoCriacao) !== null, 'classificado como creation, segue rejeitado (o contrato de conteúdo não mudou)');
}

console.log('\n=== S490-4 — a tarefa gravada aparece no recibo, também quando o objetivo falha ===');
{
    // Execução real da correção (18/11, porta 3192): o Bonsai pôs o dia em `params`, a tarefa nasceu diária, o objetivo
    // terminou "Não consegui completar… Tentei: schedule" e a pessoa não soube que a tarefa #1 diária tinha ficado ativa.
    const { SchedulerService } = await import('../../services/SchedulerService');
    const { ScheduleTool } = await import('../../tools/schedule_tool');
    const svc = new SchedulerService(':memory:', new Database(':memory:'));
    const tool = new ScheduleTool(svc);
    tool.setContext('chat-490', 'web');
    const criado = await tool.execute({ action: 'create', time: '09:00', label: 'Revisar planejamento da semana' });
    const tarefa = svc.listTasks('chat-490')[0];
    const quando = svc.describeCron(tarefa.cron_expr);
    assert(criado.success && criado.alteracao === `Criou o agendamento "Revisar planejamento da semana" (#${tarefa.id}), ativo: ${quando}`,
        'create: recibo com nome, id e o horário que vai valer (describeCron do que foi gravado)', criado.alteracao);
    const desligado = await tool.execute({ action: 'toggle', task_id: tarefa.id, active: false });
    assert(desligado.alteracao === `Desativou o agendamento "Revisar planejamento da semana" (#${tarefa.id})`, 'toggle: recibo', desligado.alteracao);
    const apagado = await tool.execute({ action: 'delete', task_id: tarefa.id });
    assert(apagado.alteracao === `Apagou o agendamento "Revisar planejamento da semana" (#${tarefa.id})`, 'delete: o nome é lido antes de apagar', apagado.alteracao);
    const listado = await tool.execute({ action: 'list' });
    assert(listado.success && listado.alteracao === undefined, 'list: leitura não tem recibo');

    // O caminho genérico da ADR-028 leva o recibo à mensagem final: a tentativa rebaixada para `partial` mantém `alteracoes`.
    const tentativas = [{ result: 'partial', toolName: 'schedule', alteracoes: [criado.alteracao] }];
    const goalFake: any = { id: 'g490', currentPlan: [], sentArtifacts: [], attempts: tentativas, strategiesTried: [], blockers: [], userIntent: 'toda segunda às 9h', createdAt: Date.now() };
    const loopFake: any = {
        goalStore: { getById: () => ({ attempts: tentativas }) },
        pickBestAvailableContent: () => undefined,
        gracefulDelivery: { buildFailureMessage: () => 'Não consegui completar o agendamento.' },
    };
    const r = (GoalExecutionLoop.prototype as any).buildResult.call(loopFake, goalFake, false, 6, 5, 'Não consegui completar o agendamento.');
    assert(r.finalOutput.includes('Não consegui completar') && r.finalOutput.includes('📝 O que foi alterado neste objetivo:')
        && r.finalOutput.includes(`Criou o agendamento "Revisar planejamento da semana" (#${tarefa.id}), ativo: ${quando}`),
        'objetivo que falhou: a mensagem conta que a tarefa ficou gravada e ativa', r.finalOutput);
}

console.log(`\n${passed} passaram, ${failed} falharam`);
if (failed > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
