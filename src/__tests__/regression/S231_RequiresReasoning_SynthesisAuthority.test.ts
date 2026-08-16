/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S231
 *
 * REESCRITO na campanha "requiresReasoning → Authority", sprint "Autoridade da Classificação".
 *
 * Histórico: a versão original deste arquivo testava `UnifiedIntentRouter.deterministicGate()`/
 * `buildDecisionFromRule()`/`isExhaustiveRuleMatch()` — um gate de regex/keyword contra o texto
 * bruto do usuário que decidia diretamente a categoria de intenção (weather_query, current_time,
 * greeting, etc.) ANTES de qualquer LLM rodar. Uma verificação adversarial posterior (mesma
 * campanha) provou que isso violava "Determinismo valida / LLM interpreta" mesmo para vocabulário
 * fechado ("oi", "hora atual") — reconhecer que um texto SIGNIFICA uma saudação já é classificar
 * intenção, não validar um fato estrutural. Esse mecanismo inteiro foi removido de
 * `UnifiedIntentRouter.ts` (ver header do arquivo) — os testes que exercitavam apenas ele foram
 * removidos junto; não há mais nada ali para testar.
 *
 * CONTRATO ATUAL:
 *   - Autoridade semântica única: `llmClassify()` (LLM real) — única função que pode popular
 *     `category`/`toolName`/`toolParams`/`cognitiveLoad` a partir do texto do usuário.
 *   - `semanticRoute()` (Camada 2b) é degradação por indisponibilidade do provider, nunca uma
 *     segunda autoridade — prova estrutural: nunca declara `toolName`.
 *   - `route()` consulta `classificationCache` (chave = texto normalizado + contexto) ANTES de
 *     chamar `llmClassify()` — reaproveita uma decisão que o LLM já tomou para o mesmo texto,
 *     nunca substitui a chamada por uma heurística.
 *   - `strategySelection()` só mapeia categoria→executionMode/riskLevel (consequência objetiva de
 *     uma categoria já decidida) e repassa `toolName`/`toolParams` sem os reinterpretar; força
 *     `executionMode='direct'` quando `toolName==='current_time'` (não é uma tool real).
 *   - `toolFirstFastPath`/`SYNTHESIS-BYPASS`/earlyReturn de `current_time` (AgentLoop.ts) não
 *     mudaram de mecanismo — continuam consumindo `requiresReasoning`/`toolName` genericamente,
 *     sem saber ou se importar com qual camada produziu a decisão.
 *
 * `llmClassify()` chama um provider real — não instanciável aqui sem LLM (mesma técnica já usada
 * pela suíte para métodos com DI pesado: reprodução fiel do algoritmo de parsing/validação,
 * copiado do source, + verificação estrutural de que o fix está presente no source real). A
 * validação de que um LLM real de fato segue o contrato do prompt (declara toolName/toolParams
 * corretamente) não é testável aqui por natureza — isso é o que a skill `verify` (LLM real) prova,
 * não um teste sintético.
 *
 * Execução: npx ts-node src/__tests__/regression/S231_RequiresReasoning_SynthesisAuthority.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { UnifiedIntentRouter } from '../../loop/UnifiedIntentRouter';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

const router = new UnifiedIntentRouter(); // sem providerFactory — força o caminho de fallback em todo teste abaixo

async function main(): Promise<void> {

console.log('\n=== S231-1 — Sem provider, route()/routeSync() usam SEMPRE semanticRoute() — nunca gate determinístico (removido) ===');
{
    for (const msg of ['Oi!', 'sim', 'tempo hoje?', 'hora atual', 'Compare a temperatura de hoje com amanhã']) {
        const decision = await router.route(msg);
        assert(decision.source === 'fallback', `"${msg}" → source='fallback' (nunca 'deterministic' — mecanismo removido)`, decision.source);
    }
}

console.log('\n=== S231-2 — semanticRoute() (Camada 2b, fallback) NUNCA declara toolName — prova estrutural de que não é uma segunda autoridade ===');
{
    for (const msg of ['tempo hoje?', 'hora atual', 'qual a previsão do tempo em Curitiba', 'que horas são']) {
        const decision = await router.route(msg);
        assert(decision.toolName === undefined, `"${msg}" via fallback nunca recebe toolName (só llmClassify pode declarar) — toolName=${decision.toolName}`, decision);
    }
}

console.log('\n=== S231-3 — cache: route() reaproveita uma decisão já tomada para o mesmo texto, sem rechamar a classificação ===');
{
    const first = await router.route('mensagem de teste para cache S231');
    const firstSteps = first.trace.steps.map(s => s.step);
    assert(firstSteps.includes('semantic_routing'), '1ª chamada: passou por semantic_routing (cache miss, classificação real)', firstSteps);

    const second = await router.route('mensagem de teste para cache S231');
    const secondSteps = second.trace.steps.map(s => s.step);
    // trace.steps preserva o histórico original (semantic_routing da 1ª chamada) + anexa
    // cache_hit — não decide de novo, só documenta que esta chamada específica foi resolvida
    // por cache. O que prova "não reclassificou" é cache_hit presente UMA VEZ SÓ (não uma 2ª
    // rodada de semantic_routing/strategy_selection empilhada por cima).
    assert(secondSteps.includes('cache_hit'), '2ª chamada (mesmo texto): passo cache_hit presente', secondSteps);
    assert(secondSteps.filter(s => s === 'semantic_routing').length === 1, 'semantic_routing aparece só UMA VEZ no histórico (da 1ª chamada) — a 2ª não reclassificou', secondSteps);
    assert(second.category === first.category, 'decisão reaproveitada é idêntica à original', { first: first.category, second: second.category });
}

console.log('\n=== S231-4 — Reprodução fiel: guard de toolFirstFastPath (AgentLoop.ts) depende de requiresReasoning + toolName, não recalcula ===');
{
    function fastPathAuthorized(intentDecision: { executionMode: string; toolName?: string; confidence: number; requiresReasoning: boolean }): boolean {
        return intentDecision.executionMode === 'tool' && !!intentDecision.toolName && intentDecision.confidence >= 0.85 && intentDecision.requiresReasoning === false;
    }

    assert(fastPathAuthorized({ executionMode: 'tool', toolName: 'weather', confidence: 0.9, requiresReasoning: false }) === true, 'LLM declarou weather + cognitiveLoad minimal → Fast Path autorizado', null);
    assert(fastPathAuthorized({ executionMode: 'tool', toolName: 'weather', confidence: 0.9, requiresReasoning: true }) === false, 'LLM declarou weather mas requiresReasoning=true (pedido composto) → Fast Path NEGADO', null);
    assert(fastPathAuthorized({ executionMode: 'hybrid', toolName: 'weather', confidence: 0.9, requiresReasoning: false }) === false, 'executionMode≠tool (LLM não confiante o bastante) → Fast Path NEGADO mesmo com toolName', null);
}

console.log('\n=== S231-5 — Reprodução fiel: SYNTHESIS-BYPASS depende de requiresReasoning, generaliza a qualquer tool (não hardcoded) ===');
{
    function synthesisBypassAuthorized(
        cycleHistory: Array<{ tool: string; status: string }>,
        requiresReasoning: boolean,
        directDeliverableTools: Set<string> = new Set(['weather', 'crypto_analysis']),
    ): boolean {
        const successfulExecutions = cycleHistory.filter(h => h.status === 'success');
        return successfulExecutions.length === 1 && directDeliverableTools.has(successfulExecutions[0].tool) && requiresReasoning === false;
    }

    assert(synthesisBypassAuthorized([{ tool: 'weather', status: 'success' }], false) === true, 'weather isolado + requiresReasoning=false → bypass autorizado', null);
    assert(synthesisBypassAuthorized([{ tool: 'weather', status: 'success' }], true) === false, 'weather isolado + requiresReasoning=true (composto) → bypass NEGADO', null);
    assert(synthesisBypassAuthorized([{ tool: 'crypto_analysis', status: 'success' }], true) === false, 'crypto_analysis + requiresReasoning=true ("compare Bitcoin e River") → bypass NEGADO', null);
    assert(synthesisBypassAuthorized([{ tool: 'crypto_analysis', status: 'success' }], false) === true, 'crypto_analysis + requiresReasoning=false (atômico) → bypass autorizado', null);

    const fakeAllowlist = new Set(['weather', 'crypto_analysis', 'stock_quote_fictitious']);
    assert(synthesisBypassAuthorized([{ tool: 'stock_quote_fictitious', status: 'success' }], true, fakeAllowlist) === false, 'tool fictícia + requiresReasoning=true → bypass NEGADO — depende de requiresReasoning, nunca do nome da tool', null);
    assert(synthesisBypassAuthorized([{ tool: 'stock_quote_fictitious', status: 'success' }], false, fakeAllowlist) === true, 'tool fictícia + requiresReasoning=false → bypass autorizado — simetria total', null);
}

console.log('\n=== S231-6 — Reprodução fiel: earlyReturn de current_time depende do MARCADOR toolName===\'current_time\' declarado pelo LLM ===');
{
    function currentTimeAuthorized(intentDecision: { toolName?: string; executionMode: string; requiresReasoning: boolean }): boolean {
        return intentDecision.toolName === 'current_time' && intentDecision.executionMode === 'direct' && intentDecision.requiresReasoning === false;
    }

    assert(currentTimeAuthorized({ toolName: 'current_time', executionMode: 'direct', requiresReasoning: false }) === true, 'LLM declarou current_time, sem mais nada → autorizado', null);
    assert(currentTimeAuthorized({ toolName: 'current_time', executionMode: 'direct', requiresReasoning: true }) === false, 'LLM declarou current_time MAS marcou requiresReasoning=true (pedido composto) → NEGADO', null);
    assert(currentTimeAuthorized({ toolName: undefined, executionMode: 'direct', requiresReasoning: false }) === false, 'sem toolName declarado → NEGADO (não é mais decidido por regex/trace.deterministicMatch)', null);
}

console.log('\n=== S231-7 — Reprodução fiel: validação de toolName do LLM contra KNOWN_TOOL_NAMES (nunca aceito cru) ===');
{
    // Mesma lógica de llmClassify() — um LLM mal-comportado ou alucinando um nome de tool
    // qualquer não deve nunca virar um toolName aceito sem essa validação estrutural.
    const KNOWN_TOOL_NAMES = new Set(['weather', 'current_time']);
    function validateToolName(raw: unknown): string | undefined {
        return typeof raw === 'string' && KNOWN_TOOL_NAMES.has(raw) ? raw : undefined;
    }

    assert(validateToolName('weather') === 'weather', 'toolName conhecido é aceito', null);
    assert(validateToolName('current_time') === 'current_time', 'toolName conhecido é aceito', null);
    assert(validateToolName('exec_command') === undefined, 'toolName fora do conjunto conhecido é REJEITADO (LLM não pode declarar qualquer tool arbitrária para Fast Path)', null);
    assert(validateToolName('crypto_analysis') === undefined, 'crypto_analysis não está em KNOWN_TOOL_NAMES — LLM não pode autorizar Fast Path pra ela via este canal (só via SYNTHESIS-BYPASS, mecanismo separado)', null);
    assert(validateToolName(undefined) === undefined, 'ausência de toolName é um valor válido (pedido não é atomicamente respondível por tool)', null);
    assert(validateToolName(123) === undefined, 'valor não-string é rejeitado (proteção contra JSON malformado do LLM)', null);
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S231 RESULTADO (comportamento): ${passed} passou | ${failed} falhou até aqui`);

console.log('\n=== S231-8 — Fix presente estruturalmente: mecanismo antigo REMOVIDO de UnifiedIntentRouter.ts ===');
{
    const source = fs.readFileSync(path.join(process.cwd(), 'src', 'loop', 'UnifiedIntentRouter.ts'), 'utf-8');
    // Checa a DECLARAÇÃO real (array/função/const), não menções em comentário histórico —
    // o header do arquivo e um comentário de contexto documentam deliberadamente o mecanismo
    // removido (ver linhas 135 e 215), o que é esperado, não uma regressão.
    assert(!/const DETERMINISTIC_RULES/.test(source), 'DETERMINISTIC_RULES (array) não existe mais no source');
    assert(!/interface DeterministicRule/.test(source), 'DeterministicRule (interface) não existe mais no source');
    assert(!/private deterministicGate/.test(source), 'deterministicGate() não existe mais no source');
    assert(!/private buildDecisionFromRule/.test(source), 'buildDecisionFromRule() não existe mais no source');
    assert(!/isExhaustiveRuleMatch/.test(source), 'isExhaustiveRuleMatch() não existe mais no source (era específico do gate removido)');
    assert(!/const GREETING_PATTERN|const CONFIRMATION_PATTERN|const REJECTION_PATTERN|const DESTRUCTIVE_KEYWORDS/.test(source), 'nenhum dos regex/keyword-lists antigos (declaração real) sobrevive no source');
    assert(!/isGreeting\(input: string\)/.test(source), 'isGreeting() (utilitário morto que dependia de GREETING_PATTERN) foi removido junto');
}

console.log('\n=== S231-9 — Fix presente estruturalmente: route() lê o cache ANTES de classificar ===');
{
    const source = fs.readFileSync(path.join(process.cwd(), 'src', 'loop', 'UnifiedIntentRouter.ts'), 'utf-8');
    const asyncRouteIdx = source.indexOf('async route(');
    const routeSyncIdx = source.indexOf('routeSync(input: string');
    const routeBody = source.slice(asyncRouteIdx, routeSyncIdx);
    assert(/classificationCache\.get\(this\.buildCacheKey/.test(routeBody), 'route() consulta classificationCache (achado desta campanha: antes só escrevia, nunca lia)');
    const cacheReadIdx = routeBody.indexOf('classificationCache.get');
    const llmCallIdx = routeBody.indexOf('llmClassify');
    assert(cacheReadIdx !== -1 && llmCallIdx !== -1 && cacheReadIdx < llmCallIdx, 'a leitura do cache acontece ANTES da chamada a llmClassify (não depois)', { cacheReadIdx, llmCallIdx });
}

console.log('\n=== S231-10 — Fix presente estruturalmente: llmClassify() pode declarar toolName/toolParams, validados contra KNOWN_TOOL_NAMES ===');
{
    const source = fs.readFileSync(path.join(process.cwd(), 'src', 'loop', 'UnifiedIntentRouter.ts'), 'utf-8');
    assert(/KNOWN_TOOL_NAMES = new Set\(\['weather', 'current_time'\]\)/.test(source), 'KNOWN_TOOL_NAMES presente e restrito a weather/current_time');
    assert(/UnifiedIntentRouter\.KNOWN_TOOL_NAMES\.has\(parsed\.toolName\)/.test(source), 'toolName do LLM é validado contra KNOWN_TOOL_NAMES antes de ser aceito — nunca confiado cru');
    assert(/toolBridge/.test(source) && /Known simple capabilities/.test(source), 'prompt de classificação inclui a ponte de tool (toolBridge) explicando quando declarar toolName');
    assert(/never when it also asks for comparison, summary, analysis/.test(source), 'prompt instrui explicitamente o LLM a NÃO declarar toolName quando há comparação/resumo/análise — a interpretação continua sendo do LLM, não de um veto determinístico');
}

console.log('\n=== S231-11 — Fix presente estruturalmente: strategySelection() repassa toolName/toolParams e força direct para current_time ===');
{
    const source = fs.readFileSync(path.join(process.cwd(), 'src', 'loop', 'UnifiedIntentRouter.ts'), 'utf-8');
    assert(/toolName === 'current_time'\) \{\s*\n\s*executionMode = 'direct';/.test(source), 'strategySelection() força executionMode=direct quando toolName===current_time (não é tool real)');
    assert(/toolName,\s*\n\s*toolParams,\s*\n\s*source: 'semantic'/.test(source), 'strategySelection() repassa toolName/toolParams no IntentDecision final, sem reinterpretar');
}

console.log('\n=== S231-12 — Fix presente estruturalmente: AgentLoop.ts consumindo o novo contrato ===');
{
    const source = fs.readFileSync(path.join(process.cwd(), 'src', 'loop', 'AgentLoop.ts'), 'utf-8');
    assert(
        /intentDecision\.toolName === 'current_time' &&\s*\n\s*intentDecision\.executionMode === 'direct' &&\s*\n\s*intentDecision\.requiresReasoning === false/.test(source),
        'current_time: guard usa toolName===\'current_time\' (não mais trace.deterministicMatch/source===\'deterministic\')',
    );
    assert(!/trace\.deterministicMatch === 'current_time'/.test(source), 'não-regressão: o campo antigo (trace.deterministicMatch) não é mais consultado em nenhum guard');
    assert(
        /intentDecision\.executionMode === 'tool' && intentDecision\.toolName && intentDecision\.confidence >= 0\.85 && intentDecision\.requiresReasoning === false/.test(source),
        'toolFirstFastPath: guard inalterado (já era genérico, independente de qual camada produz a decisão)',
    );
    assert(
        /DIRECT_DELIVERABLE_TOOLS\.includes\(successfulExecutions\[0\]\.tool\) &&\s*\n\s*requiresReasoning === false;/.test(source),
        'SYNTHESIS-BYPASS: guard logicamente inalterado — 14/08/2026: DIRECT_DELIVERABLE_TOOLS virou array importado de core/ToolRegistry.ts (fonte única com GoalExecutionLoop.buildResult()), .has() virou .includes()',
    );
    assert(
        /import \{ ToolRegistry, DIRECT_DELIVERABLE_TOOLS \} from '\.\.\/core\/ToolRegistry';/.test(source),
        'DIRECT_DELIVERABLE_TOOLS é importado de core/ToolRegistry, não declarado localmente',
    );
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S231 RESULTADO FINAL: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;

}

main().catch((err) => {
    console.error('S231 erro inesperado:', err);
    process.exitCode = 1;
});
