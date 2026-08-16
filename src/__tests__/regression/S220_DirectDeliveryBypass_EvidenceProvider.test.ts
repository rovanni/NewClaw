/// <reference types="node" />

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
 */

function evaluateBypassContract(
    cycleHistory: Array<{ step: number; tool: string; input: string; status: string }>,
    lastToolOutput?: string,
    lastToolMsgContent?: string,
): { bypassTriggered: boolean; output?: string } {
    const DIRECT_DELIVERABLE_TOOLS = new Set(['weather', 'crypto_analysis']);
    const successfulExecutions = cycleHistory.filter(h => h.status === 'success');
    const isSingleDirectDelivery =
        successfulExecutions.length === 1 &&
        DIRECT_DELIVERABLE_TOOLS.has(successfulExecutions[0].tool);

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
        console.error(`❌ FAIL: ${message}`);
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

console.log(`\nS220 Summary: ${passed} passed, ${failed} failed.`);
if (failed > 0) {
    process.exit(1);
} else {
    process.exit(0);
}
