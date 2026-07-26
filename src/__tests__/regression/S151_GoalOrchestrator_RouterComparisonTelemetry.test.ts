/// <reference types="node" />
/**
 * S151 — Fase 3 da migração GoalExtractor → UnifiedIntentRouter: fonte de verdade do roteamento.
 *
 * Contexto: docs/Auditorias/2026-07-26/REVISAO_ADVERSARIAL_GOALEXTRACTOR_2026-07-25.md ("Arquitetura Final") propôs
 * substituir `GoalExtractor.classify().isGoal` (regex + lista de verbos em português — nunca
 * entende "Áudio da previsão." sem verbo, nem mensagens em outro idioma) por `UnifiedIntentRouter`
 * (chamada LLM real, já multilíngue) como fonte da decisão "abrir Goal ou não". A Fase 2 (commit
 * anterior desta mesma Sprint) só instrumentou a comparação, sem mudar comportamento. Esta versão
 * (Fase 3) foi validada com tráfego real antes de trocar a fonte de verdade (skill verify,
 * 2026-07-26, instância isolada/LLM real, 5 mensagens): UnifiedIntentRouter acertou 5/5;
 * GoalExtractor errou 3/5 (todas as vezes sem verbo reconhecido em PT ou com o bug de saudação
 * sem âncora de fim). `routerRequiresGoal` agora decide o roteamento.
 *
 * Como `GoalOrchestrator` depende de runtime completo (ProviderFactory, GoalStore com DB,
 * MemoryManager, AgentLoop com todas as tools — mesmo padrão já documentado em S69), este teste
 * verifica a INVARIANTE no código-fonte, não instancia a classe real:
 *   1. a chamada existe e reaproveita `agentLoop.getIntentRouter()` (nenhuma segunda
 *      instância/chamada de LLM nova é criada);
 *   2. está protegida por try/catch, com fail-open explícito para `classification.isGoal` se o
 *      router falhar (nunca introduz um novo ponto único de falha);
 *   3. o `route`/`if` que de fato decidem o roteamento agora leem `routerRequiresGoal`, não mais
 *      `classification.isGoal` diretamente;
 *   4. `classification` continua sendo computado por inteiro e usado abaixo (objective/
 *      isAmbiguous/isConstruction/requiredTools) — só o papel de decidir isGoal foi substituído,
 *      nada do resto foi descartado.
 */
import * as fs from 'fs';
import * as path from 'path';

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string, detail?: unknown): void {
    if (cond) { console.log(`  ✅ ${msg}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${msg}`, detail ?? ''); failed++; }
}

const src = fs.readFileSync(
    path.join(__dirname, '..', '..', 'loop', 'GoalOrchestrator.ts'),
    'utf-8',
);

console.log('\n=== S151-1 — reaproveita agentLoop.getIntentRouter(), não cria segunda instância ===');
{
    assert(src.includes('this.agentLoop.getIntentRouter().route('), 'chama this.agentLoop.getIntentRouter().route(...)');
    assert(!/new UnifiedIntentRouter\(/.test(src), 'não instancia um segundo UnifiedIntentRouter dentro de GoalOrchestrator');
}

console.log('\n=== S151-2 — chamada ao router é fail-safe com fallback explícito ===');
{
    const tryIdx = src.indexOf('let routerRequiresGoal');
    assert(tryIdx !== -1, 'variável routerRequiresGoal declarada');
    const region = src.slice(tryIdx, tryIdx + 1200);
    assert(/try\s*{/.test(region), 'bloco try{ envolve a chamada ao router');
    assert(/catch\s*\(err\)/.test(region), 'bloco catch(err) presente');
    assert(
        /routerRequiresGoal = classification\.isGoal/.test(region),
        'fallback explícito: em caso de falha do router, volta para classification.isGoal (fail-open, não novo ponto único de falha)',
    );
}

console.log('\n=== S151-3 — roteamento real agora decide por routerRequiresGoal (fonte de verdade trocada) ===');
{
    const routeLine = src.match(/const route = routerRequiresGoal[^\n]*/);
    const ifLine = src.match(/if \(!routerRequiresGoal\)[^\n]*/);
    assert(routeLine !== null, 'linha "const route = routerRequiresGoal ..." encontrada');
    assert(ifLine !== null, 'linha "if (!routerRequiresGoal)" encontrada');

    const staleRouteLine = src.match(/const route = classification\.isGoal[^\n]*/);
    const staleIfLine = src.match(/if \(!classification\.isGoal\)[^\n]*/);
    assert(staleRouteLine === null, 'não sobrou "const route = classification.isGoal" (fonte antiga removida, não duplicada)');
    assert(staleIfLine === null, 'não sobrou "if (!classification.isGoal)" (fonte antiga removida, não duplicada)');
}

console.log('\n=== S151-4 — classification continua sendo usado para objective/ambiguidade/construção (não descartado) ===');
{
    assert(/classification\.objective/.test(src), 'classification.objective ainda é lido (Goal.objective)');
    assert(/classification\.isAmbiguous/.test(src), 'classification.isAmbiguous ainda decide o fluxo de clarificação');
    assert(/classification\.isConstruction/.test(src), 'classification.isConstruction ainda é lido');
    assert(/classification\.requiredTools/.test(src), 'classification.requiredTools ainda é lido (authorizationScope)');
}

console.log(`\n${'─'.repeat(60)}`);
console.log(failed === 0 ? `✅ S151 passou (${passed} verificações)` : `❌ S151: ${failed} falha(s) de ${passed + failed}`);
process.exitCode = failed === 0 ? 0 : 1;
