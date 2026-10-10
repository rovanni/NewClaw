/// <reference types="node" />
import * as fs from 'fs';
import * as path from 'path';
import { DIRECT_DELIVERABLE_TOOLS } from '../../core/ToolRegistry';

console.log('\n=== S220 — Direct Delivery Bypass for Evidence Provider Tools (weather, crypto_analysis) ===');

/**
 * TESTE DE REGRESSÃO — S220
 * Validates the 6 scenarios of the Direct Delivery Bypass contract in runSynthesisAndFallbackPhase():
 * 1. weather (single success) -> bypass triggered, direct output returned, no LLM synthesis
 * 2. crypto_analysis (single success) -> bypass triggered, direct output returned, no LLM synthesis
 * 3. web_search (single success) -> bypass NOT triggered (not in DIRECT_DELIVERABLE_TOOLS), proceeds to LLM synthesis
 * 4. weather + web_search (multiple tools) -> bypass NOT triggered (successfulExecutions.length = 2), proceeds to LLM synthesis
 * 5. weather(A) + weather(B) (two successful executions) -> bypass NOT triggered (successfulExecutions.length = 2)
 * 6. weather (1 success + 3 DEDUP blocks) -> successfulExecutions.length = 1 -> bypass IS triggered
 * 7. weather (single success) com requiresReasoning=true -> bypass NOT triggered (o roteador exige interpretação)
 * 8. crypto_analysis (single success) com requiresReasoning=true -> bypass NOT triggered
 * 9. o conjunto REAL DIRECT_DELIVERABLE_TOOLS (core/ToolRegistry) tem weather e crypto_analysis e não tem web_search
 * 10. a réplica está TRAVADA contra o trecho real de AgentLoop.runSynthesisAndFallbackPhase
 *
 * AUDITORIA DA SUÍTE (10/10/2026): a decisão vive INLINE em `runSynthesisAndFallbackPhase` (método enorme, sem ponto de acesso), então
 * `evaluateBypassContract` é uma ESPECIFICAÇÃO EXECUTÁVEL, não o código de produção. Dois defeitos corrigidos aqui:
 *   - a réplica copiava o conjunto `['weather','crypto_analysis']`; agora usa a constante REAL exportada por core/ToolRegistry;
 *   - a réplica estava DEFASADA: a produção ganhou a condição `requiresReasoning === false` (campanha Response Contract / Synthesis
 *     Authority) e o teste não a modelava — o caso "roteador exige raciocínio, logo o bypass NÃO pode disparar" estava sem cobertura.
 * O cenário 10 trava a especificação contra o texto real, para que uma nova mudança em produção não a deixe defasada de novo.
 */

function evaluateBypassContract(
    cycleHistory: Array<{ step: number; tool: string; input: string; status: string }>,
    lastToolOutput?: string,
    lastToolMsgContent?: string,
    requiresReasoning = false,
): { bypassTriggered: boolean; output?: string } {
    const successfulExecutions = cycleHistory.filter(h => h.status === 'success');
    const isSingleDirectDelivery =
        successfulExecutions.length === 1 &&
        DIRECT_DELIVERABLE_TOOLS.includes(successfulExecutions[0].tool) &&
        requiresReasoning === false;

    if (isSingleDirectDelivery) {
        const directOutput = lastToolOutput ?? lastToolMsgContent;
        if (typeof directOutput === 'string' && directOutput.trim().length > 0) {
            return { bypassTriggered: true, output: directOutput };
        }
    }
    return { bypassTriggered: false };
}

let passed = 0;
let failed = 0;

function check(condition: boolean, message: string) {
    if (condition) {
        console.log(`✓ ${message}`);
        passed++;
    } else {
        console.error(`❌ FALHOU: ${message}`);
        failed++;
    }
}

// 1. Weather single success -> bypass
const case1 = evaluateBypassContract(
    [{ step: 1, tool: 'weather', input: '{"city":"Cornélio Procópio"}', status: 'success' }],
    'Cornélio Procópio, Paraná - Brasil agora: Nublado ☁️ | 14.4°C'
);
check(case1.bypassTriggered === true && case1.output === 'Cornélio Procópio, Paraná - Brasil agora: Nublado ☁️ | 14.4°C', 'Scenario 1: weather single success -> bypass triggered');

// 2. Crypto single success -> bypass
const case2 = evaluateBypassContract(
    [{ step: 1, tool: 'crypto_analysis', input: '{"symbol":"BTC"}', status: 'success' }],
    'Bitcoin (BTC) | Preço: $95,420.00 | 24h: +3.5%'
);
check(case2.bypassTriggered === true && case2.output === 'Bitcoin (BTC) | Preço: $95,420.00 | 24h: +3.5%', 'Scenario 2: crypto_analysis single success -> bypass triggered');

// 3. Web search single success -> bypass NOT triggered
const case3 = evaluateBypassContract(
    [{ step: 1, tool: 'web_search', input: '{"query":"previsão tempo"}', status: 'success' }],
    'Result 1: weather forecast...'
);
check(case3.bypassTriggered === false, 'Scenario 3: web_search -> bypass NOT triggered (LLM synthesis required)');

// 4. Multiple tools (weather + web_search) -> bypass NOT triggered
const case4 = evaluateBypassContract(
    [
        { step: 1, tool: 'weather', input: '{"city":"Cornélio"}', status: 'success' },
        { step: 2, tool: 'web_search', input: '{"query":"notícias"}', status: 'success' }
    ],
    'Result'
);
check(case4.bypassTriggered === false, 'Scenario 4: multiple tools -> bypass NOT triggered (LLM synthesis required)');

// 5. Two successful executions of same tool (weather A + weather B) -> bypass NOT triggered
const case5 = evaluateBypassContract(
    [
        { step: 1, tool: 'weather', input: '{"city":"Cornélio Procópio"}', status: 'success' },
        { step: 2, tool: 'weather', input: '{"city":"Londrina"}', status: 'success' }
    ],
    'Londrina: Ensolarado'
);
check(case5.bypassTriggered === false, 'Scenario 5: 2 successful executions of weather -> bypass NOT triggered');

// 6. Weather 1 success + 3 DEDUP blocks -> cycleHistory has 1 success -> bypass IS triggered
const case6 = evaluateBypassContract(
    [{ step: 1, tool: 'weather', input: '{"city":"Cornélio Procópio"}', status: 'success' }],
    'Cornélio Procópio, Paraná - Brasil agora: Nublado ☁️ | 14.4°C'
);
check(case6.bypassTriggered === true && case6.output === 'Cornélio Procópio, Paraná - Brasil agora: Nublado ☁️ | 14.4°C', 'Scenario 6: weather 1 success + DEDUP blocks -> bypass IS triggered');

// 7/8. O roteador decidiu que o turno exige raciocínio: nem uma tool de entrega direta pode pular a síntese
const case7 = evaluateBypassContract(
    [{ step: 1, tool: 'weather', input: '{"city":"Cornélio Procópio"}', status: 'success' }],
    'Cornélio Procópio: Nublado 14.4°C',
    undefined,
    true,
);
check(case7.bypassTriggered === false, 'Scenario 7: weather single success COM requiresReasoning=true -> bypass NOT triggered');
const case8 = evaluateBypassContract(
    [{ step: 1, tool: 'crypto_analysis', input: '{"symbol":"BTC"}', status: 'success' }],
    'Bitcoin (BTC) | Preço: $95,420.00',
    undefined,
    true,
);
check(case8.bypassTriggered === false, 'Scenario 8: crypto_analysis single success COM requiresReasoning=true -> bypass NOT triggered');

// 9. A constante REAL (fonte única), não uma cópia
check(
    DIRECT_DELIVERABLE_TOOLS.includes('weather') && DIRECT_DELIVERABLE_TOOLS.includes('crypto_analysis') && !DIRECT_DELIVERABLE_TOOLS.includes('web_search'),
    'Scenario 9: DIRECT_DELIVERABLE_TOOLS (real) tem weather e crypto_analysis e NÃO tem web_search',
);

// 10. A especificação acima está travada contra o código real de AgentLoop.ts
// (caminho sobrescrevível só para a prova de detecção com uma cópia mutada; em uso normal é sempre o arquivo real)
const FONTE_DE_PRODUCAO = process.env.NC_S220_FONTE ?? path.join(__dirname, '..', '..', 'loop', 'AgentLoop.ts');
const producao = fs.readFileSync(FONTE_DE_PRODUCAO, 'utf-8').replace(/\s+/g, ' ');
check(
    /const successfulExecutions = cycleHistory\.filter\(h => h\.status === 'success'\); const isSingleDirectDelivery = successfulExecutions\.length === 1 && DIRECT_DELIVERABLE_TOOLS\.includes\(successfulExecutions\[0\]\.tool\) && requiresReasoning === false; if \(isSingleDirectDelivery\) \{/.test(producao),
    'Scenario 10a: produção — bypass = exatamente 1 sucesso + tool de entrega direta (constante real) + requiresReasoning === false',
);
check(
    /const directOutput = turnState\.lastToolExecution\?\.toolOutput \?\? loopMessages\.slice\(\)\.reverse\(\)\.find\(m => m\.role === 'tool'\)\?\.content; if \(typeof directOutput === 'string' && directOutput\.trim\(\)\.length > 0\) \{/.test(producao),
    'Scenario 10b: produção — só entrega direto se houver saída textual não vazia (última saída da tool, senão última mensagem de tool)',
);

console.log(`\nS220 Summary: ${passed} passed, ${failed} failed.`);
if (failed > 0) {
    process.exit(1);
} else {
    process.exit(0);
}
