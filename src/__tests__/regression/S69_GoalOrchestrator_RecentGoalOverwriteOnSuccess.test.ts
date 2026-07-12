/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S69
 * Mesmo incidente de S68 (log real 2026-07-08, sessão web:powerpoint-addin-...): além do bug
 * de sessionKey.channel, o rastreamento de logs mostrou uma segunda causa contribuinte na
 * classificação de "sim":
 *
 *   [2026-07-08 01:09:23] [GoalOrchestrator] recent goal context injected for classification
 *   (177s ago): "crie uma aula sobre o IPV4 e sobre o IPV6 sua principais diferenças..."
 *
 * O goal "criar aula IPv4/IPv6" tinha COMPLETADO COM SUCESSO (arquivo já entregue) muito antes
 * disso. Entre a conclusão desse goal e o "sim", houve um turno AgentLoop inteiro e não-goal
 * (heuristic_negative) — o pedido de fundo branco, que terminou com uma pergunta de
 * confirmação pendente ("Quer que eu execute agora?"), apenas 21s antes do "sim". Mesmo assim,
 * o classificador recebeu como "goal recente" a aula de IPv4/IPv6 (177s atrás), não o pedido
 * de fundo branco (21s atrás) — porque o AgentLoop.ts:294-296 tinha uma guarda de
 * "PRESERVAÇÃO" que bloqueia sobrescrever recentCompletedGoals sempre que existe uma entrada
 * de goal (isGoal=true) dentro da janela de 5 min, **independente de o goal ter tido sucesso
 * ou falhado**. A guarda existe para um caso legítimo (não perder a referência a um goal
 * FALHO quando o usuário manda uma clarificação curta em seguida — "Conseguiu criar os
 * slides?"), mas aplicada também a goals bem-sucedidos e já entregues, ela trava a entrada por
 * até 5 minutos inteiros mesmo depois de outro turno inteiramente novo já ter acontecido.
 *
 * Fix: a preservação agora só se aplica quando o goal existente FALHOU (success === false) —
 * o caso original que a motivou. Um goal já entregue com sucesso não tem mais nada pendente
 * que valha a pena preservar; o turno AgentLoop mais recente (com seu próprio outcome) deve
 * poder atualizar a entrada normalmente.
 *
 * Escopo tocado: loop/GoalOrchestrator.ts (branch !classification.isGoal, guarda
 * existingIsRecentGoal).
 *
 * Execução: npx ts-node src/__tests__/regression/S69_GoalOrchestrator_RecentGoalOverwriteOnSuccess.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`); failed++; }
}

const orchestratorPath = path.join(process.cwd(), 'src', 'loop', 'GoalOrchestrator.ts');
const orchestratorSource = fs.readFileSync(orchestratorPath, 'utf-8');

// Reproduz a condição exata do patch, isolada do resto do GoalOrchestrator (mesmo padrão dos
// testes anteriores da suíte — a classe real depende de dependências de runtime completas).
const RECENT_GOAL_TTL_MS = 5 * 60 * 1000;
interface RecentCompletedGoal {
    intent: string;
    objective: string;
    finalOutput: string;
    completedAt: number;
    success: boolean;
    isGoal: boolean;
}
function existingIsRecentGoal(existingGoal: RecentCompletedGoal | undefined, now: number): boolean {
    return !!(existingGoal?.isGoal && existingGoal.success === false &&
        (now - existingGoal.completedAt) < RECENT_GOAL_TTL_MS);
}

async function main(): Promise<void> {

console.log('\n=== S69-1 — guarda de preservação agora exige success === false no código-fonte ===');
{
    const match = orchestratorSource.match(/const existingIsRecentGoal = existingGoal\?\.isGoal[^\n]*/);
    assert(match !== null, 'linha da guarda existingIsRecentGoal encontrada');
    if (match) {
        assert(
            /existingGoal\.success === false/.test(match[0]),
            `guarda agora checa existingGoal.success === false (encontrado: "${match[0]}")`,
        );
    }
}

console.log('\n=== S69-2 — reprodução isolada: goal BEM-SUCEDIDO recente não bloqueia mais a atualização ===');
{
    const now = Date.now();
    const successfulGoalDelivered177sAgo: RecentCompletedGoal = {
        intent: 'crie uma aula sobre o IPV4 e sobre o IPV6...',
        objective: 'criar uma aula sobre IPv4 e IPv6',
        finalOutput: 'Aula_IPv4_vs_IPv6.pptx entregue',
        completedAt: now - 177_000,
        success: true,
        isGoal: true,
    };
    assert(
        existingIsRecentGoal(successfulGoalDelivered177sAgo, now) === false,
        'goal concluído com sucesso 177s atrás NÃO bloqueia mais a entrada mais recente (caso do incidente real)',
    );
}

console.log('\n=== S69-3 — reprodução isolada: goal FALHO recente CONTINUA preservado (comportamento original mantido) ===');
{
    const now = Date.now();
    const failedGoal90sAgo: RecentCompletedGoal = {
        intent: 'gerar slides sobre o River',
        objective: 'gerar slides sobre o River',
        finalOutput: 'Falha: web_search retornou resultados irrelevantes',
        completedAt: now - 90_000,
        success: false,
        isGoal: true,
    };
    assert(
        existingIsRecentGoal(failedGoal90sAgo, now) === true,
        'goal FALHO 90s atrás continua preservado — não regride o caso original ("Conseguiu criar os slides?")',
    );
}

console.log('\n=== S69-4 — reprodução isolada: fora da janela de 5 min, nunca preserva (mesmo se falho) ===');
{
    const now = Date.now();
    const failedGoal10minAgo: RecentCompletedGoal = {
        intent: 'gerar slides sobre o River',
        objective: 'gerar slides sobre o River',
        finalOutput: 'Falha: web_search retornou resultados irrelevantes',
        completedAt: now - 10 * 60_000,
        success: false,
        isGoal: true,
    };
    assert(
        existingIsRecentGoal(failedGoal10minAgo, now) === false,
        'goal falho fora da janela de 5 min não é mais tratado como recente',
    );
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S69 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;

}

main().catch((err) => {
    console.error('S69 erro inesperado:', err);
    process.exitCode = 1;
});
