/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S156
 *
 * Pedido real do usuário (26/07/2026): hoje, quando ele manda uma mensagem para o NewClaw e,
 * ENQUANTO ela ainda está sendo processada (um Goal rodando, potencialmente vários minutos), ele
 * manda uma SEGUNDA mensagem que é um complemento/detalhe adicional ("esqueci de dizer que
 * também precisa incluir X"), o sistema responde só com um ACK genérico
 * ("Estou concluindo a tarefa anterior...") e processa a segunda mensagem como um turno
 * TOTALMENTE SEPARADO só depois que a primeira termina — o complemento nunca influencia o
 * raciocínio do Goal em andamento. Investigação confirmou (ver conversa): a fila
 * (ConversationQueueManager) é 100% serial — B só começa a ser processada depois que A termina
 * por completo — e não existia NENHUM mecanismo de injeção mid-flight.
 *
 * Fix: MessageBus desvia mensagens de TEXTO comuns (não-comando) para
 * GoalOrchestrator.trySupplementActiveGoal() quando já existe um goal ativo na sessão, em vez de
 * enfileirar como turno novo. GoalExecutionLoop consome esses complementos a cada ciclo (mesmo
 * checkpoint que já relê o goal do banco, usado antes para o kill-switch de /cancelar) e dispara
 * um replan levando a informação nova em conta, via um novo BlockerKind 'user_supplement' — que
 * NÃO é tratado como falha (não passa por reflectionMemory.record()/recordFailedStrategy(), não
 * força status='blocked' via addBlocker(), usa recordBlocker() em vez disso). Rede de segurança:
 * se o goal terminar antes do complemento ser consumido, MessageBus.reprocessOrphanedSupplements()
 * reprocessa o texto como uma mensagem nova, para nunca perder silenciosamente o que o usuário
 * mandou.
 *
 * GoalOrchestrator/MessageBus são pesados para instanciar diretamente em teste unitário (mesmo
 * motivo documentado em S155: ReflectionMemory/CaseMemory/OperationalKnowledge/GoalExecutionLoop/
 * CapabilityRegistry.bootstrap() no construtor) — por isso este teste cobre:
 *   1-6   → GoalStore.addSupplement()/consumeSupplements()/hasSupplements() (comportamento real,
 *           DB em memória)
 *   7     → domainTypes.ts: 'user_supplement' presente em BlockerKind
 *   8-10  → inspeção de source: GoalOrchestrator.trySupplementActiveGoal() existe, não captura
 *           goal 'blocked' aguardando auth, retorna null sem goal ativo
 *   11-14 → inspeção de source: MessageBus.ts desvia mensagem de texto pro goal ativo ANTES do
 *           enqueue normal, ignora comandos e anexos, envia ACK diferente do genérico de fila
 *   15-17 → inspeção de source: rede de segurança (reprocessOrphanedSupplements) é chamada
 *           depois de processMessageCore(), consome supplements órfãos, reprocessa via
 *           processMessage()
 *   18-21 → inspeção de source: GoalExecutionLoop.ts consome supplements DEPOIS do switch de
 *           outcome (nunca antes — resultado real do step já foi registrado), usa
 *           recordBlocker() (não addBlocker()), respeita replanBudget
 *
 * Execução: npx ts-node src/__tests__/regression/S156_GoalSupplement_MidFlightContextInjection.test.ts
 */

process.env.WORKSPACE_DIR = process.env.WORKSPACE_DIR || 'D:/IA/newclaw/workspace';

import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { GoalStore } from '../../loop/GoalStore';
import { BlockerKind } from '../../shared/domainTypes';

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string, detail?: unknown): void {
    if (cond) { console.log(`  ✅ ${msg}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${msg}`, detail ?? ''); failed++; }
}

function makeGoalInput(overrides: Record<string, unknown> = {}) {
    return {
        sessionKey: 'web:conv-s156',
        conversationId: 'conv-s156',
        userIntent: 'Gerar apresentação',
        objective: 'Gerar apresentação em pptx',
        status: 'active',
        currentPlan: [],
        attempts: [],
        blockers: [],
        toolsTried: [],
        strategiesTried: [],
        nextAction: null,
        cycleFocus: null,
        retryBudget: 5,
        replanBudget: 3,
        confidence: 0.85,
        requiresAuth: false,
        authorizationScope: [],
        pendingTxnId: null,
        expiresAt: Date.now() + 600_000,
        completedAt: null,
        isConstruction: false,
        roadmap: [],
        currentMilestoneIndex: 0,
        allowRoadmapAdjustment: true,
        successCriteria: [],
        sentArtifacts: [],
        ...overrides,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
}

async function main() {
    console.log('\n=== S156 — GoalStore.addSupplement()/consumeSupplements()/hasSupplements() ===');
    {
        const db = new Database(':memory:');
        const goalStore = new GoalStore(db as any);
        const goal = goalStore.create(makeGoalInput());

        // 1: sem supplement, hasSupplements/consumeSupplements retornam vazio.
        assert(goalStore.hasSupplements(goal.id) === false, 'hasSupplements() false sem nenhum complemento registrado');
        assert(goalStore.consumeSupplements(goal.id).length === 0, 'consumeSupplements() retorna array vazio sem nenhum complemento');

        // 2: um complemento registrado aparece em hasSupplements() e é devolvido por consumeSupplements().
        goalStore.addSupplement(goal.id, 'também precisa incluir um slide sobre X');
        assert(goalStore.hasSupplements(goal.id) === true, 'hasSupplements() true após addSupplement()');
        const consumed = goalStore.consumeSupplements(goal.id);
        assert(consumed.length === 1 && consumed[0] === 'também precisa incluir um slide sobre X', 'consumeSupplements() devolve o texto exato registrado', consumed);

        // 3: consumir é destrutivo — não vaza para uma leitura futura.
        assert(goalStore.hasSupplements(goal.id) === false, 'hasSupplements() false depois de consumeSupplements() (consumo é destrutivo)');
        assert(goalStore.consumeSupplements(goal.id).length === 0, 'segunda chamada a consumeSupplements() não repete o mesmo texto');

        // 4: múltiplos complementos acumulam em ordem antes de serem consumidos juntos.
        goalStore.addSupplement(goal.id, 'primeiro complemento');
        goalStore.addSupplement(goal.id, 'segundo complemento');
        const multi = goalStore.consumeSupplements(goal.id);
        assert(multi.length === 2 && multi[0] === 'primeiro complemento' && multi[1] === 'segundo complemento', 'múltiplos complementos acumulam em ordem de chegada', multi);

        // 5: complementos de goals diferentes não se misturam.
        const goal2 = goalStore.create(makeGoalInput({ conversationId: 'conv-s156-b', sessionKey: 'web:conv-s156-b' }));
        goalStore.addSupplement(goal.id, 'complemento do goal 1');
        goalStore.addSupplement(goal2.id, 'complemento do goal 2');
        assert(goalStore.consumeSupplements(goal.id)[0] === 'complemento do goal 1', 'complemento de goal A não vaza para goal B (A)');
        assert(goalStore.consumeSupplements(goal2.id)[0] === 'complemento do goal 2', 'complemento de goal A não vaza para goal B (B)');
    }

    console.log('\n=== S156 — domainTypes.ts: "user_supplement" presente em BlockerKind ===');
    {
        // Checagem de tipo em tempo de compilação (o teste falha em tsc se removido) + valor real.
        const kind: BlockerKind = 'user_supplement';
        assert(kind === 'user_supplement', 'BlockerKind aceita "user_supplement" (checado em compile-time pelo próprio import)');
    }

    console.log('\n=== S156 — inspeção de source: GoalOrchestrator.trySupplementActiveGoal() ===');
    {
        const src = fs.readFileSync(path.join(process.cwd(), 'src', 'loop', 'GoalOrchestrator.ts'), 'utf-8');
        assert(/trySupplementActiveGoal\(channel: string, userId: string, message: string\): Goal \| null/.test(src), 'método trySupplementActiveGoal(channel, userId, message) existe com a assinatura esperada');
        assert(/if \(goal\.status === 'blocked' && goal\.pendingTxnId\) return null;/.test(src), 'NÃO captura goal "blocked" aguardando auth — esse caso já tem seu próprio caminho de resposta sim/não');
        assert(/this\.goalStore\.addSupplement\(goal\.id, message\)/.test(src), 'delega a gravação para GoalStore.addSupplement()');
    }

    console.log('\n=== S156 — inspeção de source: MessageBus.ts desvia mensagem de texto pro goal ativo ANTES do enqueue ===');
    {
        const src = fs.readFileSync(path.join(process.cwd(), 'src', 'channels', 'MessageBus.ts'), 'utf-8');

        const supplementIdx = src.indexOf('trySupplementActiveGoal(msg.channel, msg.userId, msg.text)');
        const enqueueIdx = src.indexOf('const result = this.conversationQueues.enqueue(');
        assert(supplementIdx > 0 && enqueueIdx > supplementIdx, 'checagem de complemento acontece ANTES do enqueue normal na fila (senão nunca teria efeito)', { supplementIdx, enqueueIdx });

        assert(/msg\.type === 'text' && !msg\.text\.startsWith\('\/'\) && msg\.text\.trim\(\)/.test(src), 'só desvia mensagens de texto puro, sem barra de comando e não-vazias — anexos/comandos seguem o fluxo normal');

        assert(/📎 Anotado — vou considerar isso no que já está em andamento\./.test(src), 'ACK do complemento é diferente do ACK genérico de fila ("Estou concluindo a tarefa anterior")');
        assert(!/capturedGoal[\s\S]{0,80}Estou concluindo a tarefa anterior/.test(src), 'o caminho de complemento NUNCA reusa o texto do ACK genérico de fila');
    }

    console.log('\n=== S156 — inspeção de source: rede de segurança (reprocessOrphanedSupplements) ===');
    {
        const src = fs.readFileSync(path.join(process.cwd(), 'src', 'channels', 'MessageBus.ts'), 'utf-8');
        assert(/private async reprocessOrphanedSupplements\(/.test(src), 'método reprocessOrphanedSupplements() existe');

        const processCoreIdx = src.indexOf('await this.processMessageCore(msg, correlationId);');
        const reprocessCallIdx = src.indexOf('await this.reprocessOrphanedSupplements(msg, queueId, correlationId);');
        assert(processCoreIdx > 0 && reprocessCallIdx > processCoreIdx, 'chamado DEPOIS de processMessageCore() resolver — mesma task da fila, serializado corretamente', { processCoreIdx, reprocessCallIdx });

        assert(/goalStore\.consumeSupplements\(recentGoal\.id\)/.test(src), 'consome (não só verifica) os supplements órfãos, evitando reprocessar duas vezes');
        assert(/await this\.processMessage\(syntheticMsg\)/.test(src), 'reprocessa o texto órfão via processMessage() — mesmo caminho de uma mensagem nova legítima');
    }

    console.log('\n=== S156 — inspeção de source: GoalExecutionLoop.ts consome complementos com segurança ===');
    {
        const src = fs.readFileSync(path.join(process.cwd(), 'src', 'loop', 'GoalExecutionLoop.ts'), 'utf-8');

        const switchIdx = src.indexOf("case 'failed':");
        const outcomeAssignIdx = src.indexOf('priorFeedback = outcomeHandled.priorFeedback;');
        const supplementIdx = src.indexOf('const supplements = this.goalStore.consumeSupplements(currentGoal.id);');
        const ttlIdx = src.indexOf('// Verificar TTL após cada ciclo');
        assert(
            switchIdx > 0 && outcomeAssignIdx > switchIdx && supplementIdx > outcomeAssignIdx && ttlIdx > supplementIdx,
            'consumo de complementos roda DEPOIS do switch de outcome (resultado real do step já registrado) e ANTES da checagem de TTL',
            { switchIdx, outcomeAssignIdx, supplementIdx, ttlIdx }
        );

        assert(/kind: 'user_supplement'/.test(src), "blocker sintético usa kind: 'user_supplement'");
        assert(/this\.goalStore\.recordBlocker\(currentGoal\.id, supplementBlocker\)/.test(src), 'usa recordBlocker() (não altera status) em vez de addBlocker() (forçaria "blocked")');
        assert(!/addBlocker\(currentGoal\.id, supplementBlocker\)/.test(src), 'NUNCA usa addBlocker() para o supplementBlocker — evitaria status="blocked" incorreto');
        assert(/supplements\.length > 0 && currentGoal\.replanBudget > 0/.test(src), 'só dispara replan dedicado se ainda houver replanBudget — evita loop infinito de complementos');
        assert(/replanBudget esgotado — anexando como feedback sem replan dedicado/.test(src), 'sem replanBudget, ainda assim NÃO descarta — soma ao priorFeedback em vez de perder a informação');
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S156 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
    console.error('S156 erro inesperado:', err);
    process.exitCode = 1;
});
