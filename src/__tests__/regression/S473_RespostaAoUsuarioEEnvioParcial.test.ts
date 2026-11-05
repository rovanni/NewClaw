/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S473
 *
 * ADR-032 (A): quando o objetivo termina sem passo de texto, a mensagem final é a `resposta_ao_usuario` do avaliador de
 * conclusão — escrita PARA a pessoa, no idioma da instalação — e não um parecer sobre o sistema. Quarta ocorrência da
 * classe S175 nos testes reais de 17–19/10/2026 (River em áudio: "Objetivo concluído: obtida a cotação… A resposta final
 * foi entregue ao usuário…").
 *
 * Política O8 revista (04/11/2026): numa saída por falha, o que ficou pronto e validado é entregue antes da mensagem de
 * falha. Caso real (goal qejk6): 14 módulos e o .zip no disco, dois envios adiados registrados, e a resposta foi "Não
 * consegui completar" — o passo de conferência que falhou depois escondeu o trabalho pronto.
 *
 * Execução: npx ts-node src/__tests__/regression/S473_RespostaAoUsuarioEEnvioParcial.test.ts
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import { GoalExecutionLoop } from '../../loop/GoalExecutionLoop';
import { GoalStore } from '../../loop/GoalStore';
import { ToolRegistry } from '../../core/ToolRegistry';
import { Goal, PlanStep } from '../../loop/GoalTypes';
import { ChannelContext } from '../../loop/agentLoopTypes';
import { vereditoConclusao, tipoDaPerguntaDoMotor, orcamentoDeTeste } from './_fixtures/veredito';
import { descritorConclusaoDoObjetivo, adaptarConclusaoDoObjetivo } from '../../validation/tipos/demaisTipos';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  OK ${message}`); passed++; }
    else { console.error(`  FALHOU: ${message}`, detail ?? ''); failed++; }
}

const enviados: string[] = [];
ToolRegistry.register({
    name: 'send_document', description: 'test', parameters: {},
    execute: async (args: Record<string, unknown>) => { enviados.push(String(args['file_path'])); return { success: true, output: `Documento enviado.` }; },
});

const mensagensAoJuiz: string[] = [];
function provedor(respostaAoUsuario: string) {
    return {
        chatWithFallback: async (msgs: Array<{ content?: unknown }>) => {
            mensagensAoJuiz.push(msgs.map(m => String(m.content ?? '')).join('\n'));
            return { status: 'success', content: tipoDaPerguntaDoMotor(msgs) === 'conclusao' ? vereditoConclusao(true, { summary: respostaAoUsuario }) : JSON.stringify({ achieved: true, summary: respostaAoUsuario }) };
        },
        getBudgetAuxiliar: orcamentoDeTeste,
        getProvider: () => undefined,
        getProviderWithModel: () => ({ chat: async () => ({ status: 'success', content: '{}' }) }),
    } as unknown as import('../../core/ProviderFactory').ProviderFactory;
}

function montar(pf: import('../../core/ProviderFactory').ProviderFactory) {
    const db = new (Database as any)(':memory:');
    const goalStore = new GoalStore(db);
    const loop = new GoalExecutionLoop(
        {} as any, goalStore,
        { getAvailableSkills: () => [], setSkillContext: () => {}, setModel: () => {}, replan: async () => ({ steps: [], strategy: 'n/a' }) } as any,
        { record: () => {}, buildContextHint: () => '', findHardConstraints: () => [] } as any,
        ToolRegistry, pf, { getDatabase: () => db } as any,
        { findApplicableCasesShadow: async () => [], backfillMissingEmbeddings: async () => {}, captureIfEligible: () => {}, findSimilarShadow: () => [] } as any,
    );
    return { loop, goalStore };
}

function criarGoal(store: GoalStore, extra: Partial<Goal> & { currentPlan: PlanStep[] }): Goal {
    return store.create({
        sessionKey: 'test:s473', conversationId: 'test-conv-s473', userIntent: 'Vamos dividir esses slides em vários módulos',
        objective: 'Dividir o deck em módulos', status: 'executing', attempts: [], blockers: [], toolsTried: [], strategiesTried: [],
        successCriteria: [], sentArtifacts: [], retryBudget: 3, replanBudget: 5, confidence: 0.9, requiresAuth: false,
        authorizationScope: [], expiresAt: Date.now() + 3_600_000, ...extra,
    } as Omit<Goal, 'id' | 'createdAt' | 'updatedAt'>);
}

const estado = (goalId: string, canal?: ChannelContext) => ({
    cognitiveContext: { discoveries: [], failedStrategies: [], filesRead: [], filesModified: [], generatedArtifacts: [], executedCommands: [], importantOutputs: [] },
    progressModel: { goalId, components: [], overallPercent: 0, updatedAt: Date.now() },
    canal, saidasCompletas: new Map(),
});
const canal: ChannelContext = { channel: 'test', chatId: 'test-user' };

async function main(): Promise<void> {
    console.log('\n=== S473.1 — ADR-032: o descritor pede a resposta PARA o usuário, no idioma da instalação ===');
    {
        const campos = (descritorConclusaoDoObjetivo.camposExtras ?? []).map(c => c.nome);
        assert(campos.includes('resposta_ao_usuario') && !campos.includes('resumo'), 'campo resposta_ao_usuario no lugar de resumo', campos);
        assert(descritorConclusaoDoObjetivo.entradas.some(e => e.nome === 'idioma'), 'entrada idioma declarada');
        const lido = adaptarConclusaoDoObjetivo({ estado: 'aprovado', motivo: 'm', extras: { resumo: 'antigo' } } as never);
        assert(lido.achieved && lido.summary === 'antigo', 'compatibilidade: o campo antigo ainda é lido', lido);
    }

    console.log('\n=== S473.2 — ADR-032: sem passo de texto, a mensagem final é a resposta ao usuário, e o juiz recebe o idioma ===');
    {
        mensagensAoJuiz.length = 0;
        const resposta = 'Pronto! Dividi as aulas em 14 módulos, um por dia, e te enviei o Modulos.zip.';
        const { loop, goalStore } = montar(provedor(resposta));
        const goal = criarGoal(goalStore, { currentPlan: [] });
        const r = await (loop as any).runLoopInternal(goal, canal, undefined, 0, 0, undefined, estado(goal.id, canal));
        assert(r.success === true && String(r.finalOutput).includes(resposta), "a mensagem final é a resposta escrita para a pessoa", r.finalOutput);
        assert(mensagensAoJuiz.some(m => /português brasileiro/i.test(m)), 'o pedido ao avaliador leva a diretiva de idioma da instalação');
    }

    console.log('\n=== S473.3 — O8: na falha, sai o envio adiado VALIDADO; os outros, não ===');
    {
        enviados.length = 0;
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's473-'));
        const pronto = path.join(dir, 'Modulos.zip'); fs.writeFileSync(pronto, 'zip');
        const deOrigemFalha = path.join(dir, 'rascunho.md'); fs.writeFileSync(deOrigemFalha, 'x');
        const planejado = path.join(dir, 'planejado.md'); fs.writeFileSync(planejado, 'x');
        const ausente = path.join(dir, 'nao_existe.pptx');
        const adiado = (id: string, fp: string, origem?: string): PlanStep => ({ id, description: `Enviar ${fp}`, toolName: 'send_document', toolArgs: { file_path: fp }, status: 'pending', fallbackSteps: [], ...(origem ? { originStepId: origem } : {}) });
        const tentativa = (planStepId: string, result: string) => ({ id: `a_${planStepId}`, planStepId, toolName: 'agentloop', args: {}, result, output: 'ok', executedAt: Date.now(), planGeneration: 0 });
        const { loop, goalStore } = montar(provedor('n/a'));
        let goal = criarGoal(goalStore, {
            currentPlan: [
                adiado('d1', pronto, 'step_1'),          // origem com sucesso, arquivo existe → sai
                adiado('d2', deOrigemFalha, 'step_2'),   // origem falhou → não sai
                adiado('d3', planejado),                 // envio planejado (sem originStepId) → não sai
                adiado('d4', ausente, 'step_1'),         // arquivo não existe → não sai
            ],
            attempts: [tentativa('step_1', 'success'), tentativa('step_2', 'failed')] as never,
        });
        goal = await (loop as any).entregarProntosAntesDaFalha(goal, 1, estado(goal.id, canal));
        assert(enviados.length === 1 && enviados[0] === pronto, 'só o arquivo validado e existente foi enviado', enviados);
        assert((goal.sentArtifacts ?? []).includes(pronto), 'registrado em sentArtifacts (1 artefato = 1 entrega)', goal.sentArtifacts);
        const msg = (loop as any).gracefulDelivery.buildFailureMessage(goal);
        assert(/Consegui gerar e enviar: .*Modulos\.zip/.test(msg) && /não finalizei o restante/.test(msg), 'a mensagem de falha diz o que foi entregue', msg);
        // Repetir não reenvia.
        await (loop as any).entregarProntosAntesDaFalha(goalStore.getById(goal.id), 2, estado(goal.id, canal));
        assert(enviados.length === 1, 'chamada repetida não reenvia', enviados);
        // Sem canal (execução sem destino), nada sai.
        const g2 = criarGoal(goalStore, { currentPlan: [adiado('d1', pronto, 'step_1')], attempts: [tentativa('step_1', 'success')] as never });
        await (loop as any).entregarProntosAntesDaFalha(g2, 1, estado(g2.id));
        assert(enviados.length === 1, 'sem canal, nada é enviado');
    }

    console.log('\n=== S473.4 — as saídas por falha passam pela entrega parcial; o cancelamento pelo usuário não ===');
    {
        const src = fs.readFileSync(path.join(process.cwd(), 'src', 'loop', 'GoalExecutionLoop.ts'), 'utf-8');
        const chamadas = (src.match(/await this\.entregarProntosAntesDaFalha\(/g) ?? []).length;
        assert(chamadas === 4, 'quatro saídas por falha (bloqueio, falha, validação final, limite de ciclos) chamam a entrega', chamadas);
        const cancelamento = src.slice(src.indexOf("if (noInicioDoCiclo?.status === 'abandoned')"), src.indexOf("if (noInicioDoCiclo?.status === 'abandoned')") + 600);
        assert(!cancelamento.includes('entregarProntosAntesDaFalha'), 'cancelamento pelo usuário não envia nada');
    }

    console.log(`\nS473 RESULTADO: ${passed} passou | ${failed} falhou`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => { console.error('S473 erro inesperado:', err); process.exit(1); });
