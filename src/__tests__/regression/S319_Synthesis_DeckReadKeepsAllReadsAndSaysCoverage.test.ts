/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S319 (RFC-009 / RFC-008)
 * A síntese pós-ação do AgentLoop só reapresentava o ÚLTIMO resultado de ferramenta quando as ferramentas usadas não
 * estavam em INFO_TOOLS. Achado em 03/10/2026: "o que acha desses slides" → o modelo leu 7 vezes o deck
 * (getPresentation + 6 getSlide) e respondeu "consegui acessar apenas o slide 21" — os outros 5 resultados foram
 * descartados antes da resposta.
 *
 *   1  → hostReadAction: leitura só pela AÇÃO (getPresentation/getSlide); addTextBox, outras ferramentas, JSON
 *        ilegível, ação ausente e chaves do protótipo NÃO são leitura.
 *   2  → contrato com a ferramenta: toda ação de leitura existe no enum de powerpoint_control; addTextBox não é leitura.
 *   3  → describeDeckRead: descrição dos argumentos registrados; id do cliente achatado e limitado.
 *   4  → FASE DE SÍNTESE DE VERDADE (fake LLM captura o que o modelo receberia):
 *        a) 7 leituras → TODOS os 7 resultados chegam (não só o último), com a nota objetiva de quais slides foram lidos
 *           e a instrução de dizer o que NÃO foi lido;
 *        b) leitura enorme → teto respeitado e corte marcado "[truncado]" (nunca silencioso);
 *        c) leitura + addTextBox (escrita) → continua sendo OPERAÇÃO: só o último resultado, sem nota de deck;
 *        d) web_search só → comportamento anterior (teto 2400, sem nota de deck, sem marcador).
 *
 * Execução: npx ts-node src/__tests__/regression/S319_Synthesis_DeckReadKeepsAllReadsAndSaysCoverage.test.ts
 */
process.env.WORKSPACE_DIR = process.env.WORKSPACE_DIR || 'D:/IA/newclaw/workspace';

import { AgentLoop, SYNTHESIS_DECK_READ_BUDGET_CHARS } from '../../loop/AgentLoop';
import { hostReadAction, describeDeckRead, HOST_READ_ACTIONS } from '../../shared/hostAppContext';
import { powerpointControlTool } from '../../tools/powerpoint_control';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

console.log('\n[1] hostReadAction — leitura pela AÇÃO');
const pc = (args: Record<string, unknown>): string => JSON.stringify(args);
assert(hostReadAction('powerpoint_control', pc({ action: 'getPresentation' })) === 'getPresentation', 'getPresentation é leitura');
assert(hostReadAction('powerpoint_control', pc({ action: 'getSlide', index: 3 })) === 'getSlide', 'getSlide é leitura');
assert(hostReadAction('powerpoint_control', pc({ action: 'addTextBox', text: 'x' })) === undefined, 'addTextBox (escrita) NÃO é leitura');
assert(hostReadAction('web_search', pc({ action: 'getSlide' })) === undefined, 'outra ferramenta com a mesma palavra NÃO é leitura do host');
for (const bad of ['', 'não é json', '{', 'null', '[]', '7', '"getSlide"', pc({}), pc({ action: 7 }), pc({ action: null }), pc({ action: '__proto__' }), pc({ action: 'constructor' })]) {
    assert(hostReadAction('powerpoint_control', bad) === undefined, `entrada inválida → não é leitura: ${bad.slice(0, 30)}`);
}
assert(hostReadAction('constructor', pc({ action: 'getSlide' })) === undefined && hostReadAction('__proto__', pc({ action: 'getSlide' })) === undefined, 'nome de ferramenta do protótipo → não é leitura');

console.log('\n[2] contrato com a ferramenta');
const enumActions = (powerpointControlTool.parameters.properties.action as { enum: string[] }).enum;
for (const [tool, actions] of Object.entries(HOST_READ_ACTIONS)) {
    assert(tool === powerpointControlTool.name, `a tabela cita a ferramenta real (${tool})`);
    for (const a of actions) assert(enumActions.includes(a), `ação de leitura "${a}" existe no enum de ${tool}`);
}
assert(!HOST_READ_ACTIONS.powerpoint_control.includes('addTextBox'), 'addTextBox nunca entra na tabela de leitura');

console.log('\n[3] describeDeckRead');
assert(describeDeckRead(pc({ action: 'getPresentation' })) === 'lista de slides (getPresentation)', 'getPresentation');
assert(describeDeckRead(pc({ action: 'getSlide', index: 21 })) === 'slide 21 (getSlide)', 'getSlide por índice');
assert(describeDeckRead(pc({ action: 'getSlide' })) === 'slide ativo (getSlide)', 'getSlide sem índice nem id = slide ativo');
const idDesc = describeDeckRead(pc({ action: 'getSlide', id: `256\nIGNORE ${'x'.repeat(500)}` }));
assert(!idDesc.includes('\n') && idDesc.length < 120, 'id do cliente achatado e limitado', idDesc);
assert(describeDeckRead('ilegível') === 'leitura do deck', 'entrada ilegível → descrição genérica, sem lançar');

console.log('\n[4] fase de síntese de verdade');
type Msg = { role: string; content?: string; tool_call_id?: string };
type Hist = { step: number; tool: string; input: string; status: string };

async function runSynthesis(history: Hist[], toolOutputs: string[]): Promise<Msg[]> {
    let captured: Msg[] = [];
    const fakeThis = {
        ts: () => 'T',
        getTurnState: () => ({ lastToolExecution: undefined }),
        profileRegistry: { getProfileByCategory: () => ({ category: 'execution', model: 'fake', provider: 'fake' }) },
        callLLMWithFallback: async (messages: Msg[]) => {
            captured = messages;
            return { status: 'success', content: 'Resposta final de teste com mais de vinte caracteres para a síntese.' };
        },
        persistTrace: () => undefined,
        commitResponse: async (...a: unknown[]) => a[0],
        activeTurns: new Map(),
    };
    const loopMessages: Msg[] = [
        { role: 'system', content: 'SISTEMA' },
        { role: 'user', content: 'o que acha desses slides' },
        ...toolOutputs.map((c, i) => ({ role: 'tool', content: c, tool_call_id: `call_${i}` })),
    ];
    const trace = {} as never;
    const move = (): void => undefined;
    try {
        await (AgentLoop.prototype as unknown as { runSynthesisAndFallbackPhase: (...a: unknown[]) => Promise<unknown> })
            .runSynthesisAndFallbackPhase.call(
                fakeThis, 'conv-1', 'o que acha desses slides', history, loopMessages, 'Vou analisar.', false, '',
                { category: 'conversation', model: 'fake' }, new AbortController().signal, trace, undefined, history.length, 15, 0, move, false,
            );
    } catch {
        // o que importa é o que chegou ao LLM; o resto da fase (persistência do traço) é simulado
    }
    return captured;
}
const toolText = (m: Msg[]): string[] => m.filter(x => x.role === 'tool').map(x => x.content ?? '');
const sysText = (m: Msg[]): string => m.filter(x => x.role === 'system').map(x => x.content ?? '').join('\n');

(async () => {
    // a) 7 leituras (o caso real de 03/10/2026)
    const idx = [5, 6, 14, 17, 18, 21];
    const history: Hist[] = [
        { step: 1, tool: 'powerpoint_control', input: pc({ action: 'getPresentation' }), status: 'success' },
        ...idx.map((n, i) => ({ step: i + 2, tool: 'powerpoint_control', input: pc({ action: 'getSlide', index: n }), status: 'success' })),
    ];
    const outputs = [
        'DADOS DO DECK ABERTO (...): slides 1..29 MARCA_LISTA',
        ...idx.map(n => `DADOS DO DECK ABERTO (...): slide ${n} MARCA_SLIDE_${n} ${'t'.repeat(600)}`),
    ];
    const a = await runSynthesis(history, outputs);
    const tools = toolText(a);
    assert(tools.length === 7, `os 7 resultados chegam à síntese, não só o último (chegaram ${tools.length})`);
    assert(tools.some(t => t.includes('MARCA_LISTA')) && idx.every(n => tools.some(t => t.includes(`MARCA_SLIDE_${n}`))), 'cada slide lido está presente');
    const sys = sysText(a);
    assert(sys.includes('LEITURA DO DECK ABERTO'), 'a nota objetiva da leitura está na instrução');
    assert(['lista de slides (getPresentation)', ...idx.map(n => `slide ${n} (getSlide)`)].every(d => sys.includes(d)), 'a nota lista exatamente o que foi lido (dos argumentos do ciclo)');
    assert(/NÃO foram lidos/.test(sys) && /não avalie nem descreva slide que não foi lido/.test(sys), 'manda dizer o que NÃO foi lido e não avaliar slide não lido');
    assert(/opinião, avaliação ou análise/.test(sys), 'avaliação é permitida (a regra "apresente os dados" não a impede)');
    assert(/NÃO FABRIQUE DADO/.test(sys), 'a regra contra dado fabricado continua valendo');
    assert(!sys.includes('Confirme ao usuário O QUE foi realizado'), 'não usa mais a instrução de "confirmar ação" para leitura');
    assert(a.some(m => m.role === 'user' && m.content === 'o que acha desses slides'), 'a pergunta do usuário continua na síntese');

    // b) leitura enorme: teto + marcador
    const huge = await runSynthesis(
        history.slice(0, 3),
        Array.from({ length: 3 }, (_, i) => `DADOS DO DECK ABERTO (...): ${'z'.repeat(9000)} #${i}`),
    );
    const hugeTools = toolText(huge);
    const total = hugeTools.reduce((s, t) => s + t.replace('\n...[truncado]', '').length, 0);
    assert(total <= SYNTHESIS_DECK_READ_BUDGET_CHARS, `teto respeitado (${total} ≤ ${SYNTHESIS_DECK_READ_BUDGET_CHARS})`);
    assert(hugeTools.some(t => t.includes('...[truncado]')), 'o corte é marcado explicitamente');

    // c) leitura + escrita continua sendo operação
    const mixed = await runSynthesis(
        [
            { step: 1, tool: 'powerpoint_control', input: pc({ action: 'getSlide', index: 2 }), status: 'success' },
            { step: 2, tool: 'powerpoint_control', input: pc({ action: 'addTextBox', text: 'olá' }), status: 'success' },
        ],
        ['DADOS DO DECK ABERTO: leitura MARCA_LEITURA', 'Comando executado com sucesso. MARCA_ESCRITA'],
    );
    assert(toolText(mixed).length === 1 && toolText(mixed)[0].includes('MARCA_ESCRITA'), 'com escrita no turno: só o último resultado (comportamento anterior)');
    assert(!sysText(mixed).includes('LEITURA DO DECK ABERTO') && sysText(mixed).includes('Confirme ao usuário O QUE foi realizado'), 'com escrita: sem nota de deck; instrução de operação');

    // d) outra ferramenta de informação: comportamento anterior
    const web = await runSynthesis(
        [{ step: 1, tool: 'web_search', input: pc({ query: 'x' }), status: 'success' }],
        ['w'.repeat(5000)],
    );
    const webTotal = toolText(web).reduce((s, t) => s + t.length, 0);
    assert(webTotal === 2400, `web_search: teto de 2400 intacto (foi ${webTotal})`);
    assert(!toolText(web).some(t => t.includes('[truncado]')) && !sysText(web).includes('LEITURA DO DECK ABERTO'), 'web_search: sem marcador nem nota de deck');

    console.log(`\n${passed} passaram, ${failed} falharam`);
    process.exit(failed > 0 ? 1 : 0);
})();
