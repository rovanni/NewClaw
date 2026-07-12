/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — P1.1
 * Artefatos entregues em goals anteriores não aparecem no Q1 do goal seguinte
 *
 * HIPÓTESE ORIGINAL:
 *   Goal A entrega arquivo → contexto não inclui o artefato → Goal B não sabe que foi entregue
 *
 * ARQUITETURA ATUAL (Strategy B — auditoria jun/2026):
 *   - ArtifactDeliveryRegistry removido (dead code, 8 bugs críticos)
 *   - sentArtifacts (Set<string>) é a fonte de verdade para dedup intra-goal
 *   - SessionManager.deliveredArtifacts provê contexto cognitivo cross-goal para o LLM
 *   - SessionContext.getDeliveredArtifactsBlock() injeta artefatos no prompt do AgentLoop
 *
 * Execução: npx ts-node src/__tests__/regression/P1_1_ArtifactPersistence_CrossGoal.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
    if (condition) {
        console.log(`  ✅ ${message}`);
        passed++;
    } else {
        console.error(`  ❌ FALHOU: ${message}`);
        failed++;
    }
}

// ── Teste 1: GoalExecutionLoop.contextualize() inclui artefatos entregues ──────

console.log('\n=== P1.1 — GoalExecutionLoop.contextualize() usa delivered artifacts ===');

const goalExecLoopPath = path.join(process.cwd(), 'src', 'loop', 'GoalExecutionLoop.ts');
const contextualizeSource = (() => {
    try {
        const content = fs.readFileSync(goalExecLoopPath, 'utf-8');
        const start = content.indexOf('private async contextualize(');
        if (start < 0) return '';
        const end = content.indexOf('\n    private ', start + 100);
        return end > start ? content.slice(start, end) : content.slice(start, start + 3000);
    } catch {
        return '';
    }
})();

if (contextualizeSource) {
    console.log(`  → Tamanho do método contextualize: ${contextualizeSource.length} chars`);

    const hasDeliveredArtifactsCall = contextualizeSource.includes('getDeliveredArtifactsBlock') ||
        contextualizeSource.includes('deliveredArtifacts');

    assert(
        hasDeliveredArtifactsCall,
        'contextualize() inclui artefatos entregues via sessionManager.getDeliveredArtifactsBlock()'
    );

    const hasSemSearch = contextualizeSource.includes('semanticSearch') || contextualizeSource.includes('memory.search');
    const hasFailureHints = contextualizeSource.includes('buildContextHint') || contextualizeSource.includes('toolsTried');
    const hasSkillDiscovery = contextualizeSource.includes('discoverSkills') || contextualizeSource.includes('SKILL-DISCOVERY');

    assert(hasSemSearch, 'contextualize() tem: busca semântica na memória');
    assert(hasFailureHints, 'contextualize() tem: hints de falhas passadas');
    assert(hasSkillDiscovery, 'contextualize() tem: skill discovery (Sprint 3.7A)');
}

// ── Teste 2: SessionContext injeta artefatos entregues no prompt do AgentLoop ───

console.log('\n=== P1.1 — SessionContext.ts usa getDeliveredArtifactsBlock ===');

const sessionContextPath = path.join(process.cwd(), 'src', 'session', 'SessionContext.ts');
const sessionContextSource = (() => {
    try { return fs.readFileSync(sessionContextPath, 'utf-8'); } catch { return ''; }
})();

if (sessionContextSource) {
    const hasDeliveredBlock = sessionContextSource.includes('getDeliveredArtifactsBlock');
    assert(hasDeliveredBlock, 'SessionContext.ts injeta artefatos entregues no contexto do LLM');
}

// ── Teste 3: ArtifactDeliveryRegistry não existe mais (Strategy B) ───────────

console.log('\n=== P1.1 — ArtifactDeliveryRegistry removido (Strategy B) ===');

const registryPath = path.join(process.cwd(), 'src', 'core', 'ArtifactDeliveryRegistry.ts');
assert(
    !fs.existsSync(registryPath),
    'ArtifactDeliveryRegistry.ts removido — dead code confirmado em auditoria jun/2026'
);

// ── Teste 4: sentArtifacts tem callback onArtifactDelivered (Correção 1) ───────

console.log('\n=== P1.1 — GoalExecutionLoop tem onArtifactDelivered callback (Correção 1) ===');

const goalExecLoopFull = (() => {
    try { return fs.readFileSync(goalExecLoopPath, 'utf-8'); } catch { return ''; }
})();

if (goalExecLoopFull) {
    assert(
        goalExecLoopFull.includes('onArtifactDelivered'),
        'GoalExecutionLoop usa onArtifactDelivered para receber notificação do DELIVERY-GUARD'
    );
    assert(
        goalExecLoopFull.includes('DELIVERY-GUARD-REGISTERED'),
        'GoalExecutionLoop loga DELIVERY-GUARD-REGISTERED quando callback é acionado'
    );
    assert(
        goalExecLoopFull.includes('S10-PARTIAL'),
        'GoalExecutionLoop tem S10-PARTIAL em case partial (Correção 2 — defense-in-depth)'
    );
}

// ── Teste 5: agentLoopTypes.ts declara onArtifactDelivered no ChannelContext ───

console.log('\n=== P1.1 — ChannelContext tem onArtifactDelivered ===');

const channelContextPath = path.join(process.cwd(), 'src', 'loop', 'agentLoopTypes.ts');
const channelContextSource = (() => {
    try { return fs.readFileSync(channelContextPath, 'utf-8'); } catch { return ''; }
})();

if (channelContextSource) {
    assert(
        channelContextSource.includes('onArtifactDelivered'),
        'ChannelContext declara onArtifactDelivered? (Correção 1)'
    );
}

// ── RELATÓRIO ─────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(60)}`);
console.log(`P1.1 RESULTADO:`);
console.log(`  ✅ Passou: ${passed}`);
console.log(`  ❌ Falhou: ${failed}`);
console.log(`\nARQUITETURA ATUAL:`);
console.log(`  1. sentArtifacts (Set<string>) — fonte de verdade de dedup intra-goal`);
console.log(`  2. onArtifactDelivered callback — DELIVERY-GUARD → sentArtifacts (Correção 1)`);
console.log(`  3. S10-PARTIAL — defense-in-depth em case 'partial' (Correção 2)`);
console.log(`  4. SessionManager.deliveredArtifacts — contexto cognitivo cross-goal para LLM`);
console.log(`  5. ArtifactDeliveryRegistry — REMOVIDO (Strategy B, auditoria jun/2026)`);
