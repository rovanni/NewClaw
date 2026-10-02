/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S314 (RFC-008, item (a) do replay do RC1)
 * `powerpoint_control` passa a declarar `requiredArgsHint` (mecanismo ARCH-015 já existente). Antes, o Planner só via o NOME e uma linha de
 * descrição da tool e emitia o passo SEM `action` (22 de 22 passos no replay do RC1, 02/10/2026).
 *
 *   1  → a linha existe, segue o formato das demais ("- powerpoint_control: ...") e cita `action`, o valor aceito, `text`, `x`/`y` e a precondição de sessão.
 *   2  → fonte única: a lista de ações vem de `parameters`; se o `enum` ganhar valores, o hint acompanha (e é restaurado ao fim).
 *   3  → o texto chega aos prompts REAIS de plan() e de replan(), sob os cabeçalhos de cada um, exatamente uma vez.
 *   4  → controle negativo: as linhas das tools que já tinham hint continuam verbatim; uma tool sem hint (web_search) continua fora da seção.
 *   5  → custo: o acréscimo no prompt é exatamente a linha (+ quebra) e fica abaixo de um teto.
 *   6  → o hint não contradiz a tool: o valor que ele cita é o único que `execute()` aceita (guarda de deriva).
 *
 * Execução: npx ts-node src/__tests__/regression/S314_PowerPointControl_RequiredArgsHint_FromSchema.test.ts
 */
process.env.WORKSPACE_DIR = process.env.WORKSPACE_DIR || 'D:/IA/newclaw/workspace';

import { GoalPlanner } from '../../loop/GoalPlanner';
import { ToolRegistry } from '../../core/ToolRegistry';
import { Goal, GoalBlocker } from '../../loop/GoalTypes';
import { powerpointControlTool } from '../../tools/powerpoint_control';
import { EditTool } from '../../tools/edit_tool';
import { SendDocumentTool } from '../../tools/send_document';
import { WebSearchTool } from '../../tools/web_search';
import { ReadTool } from '../../tools/read_tool';

// ToolRegistry é singleton por processo: try/catch para tool já registrada (mesmo padrão de S124).
try { ToolRegistry.register(powerpointControlTool as never); } catch { /* já registrado */ }
try { ToolRegistry.register(new EditTool()); } catch { /* já registrado */ }
try { ToolRegistry.register(new SendDocumentTool({} as never)); } catch { /* já registrado */ }
try { ToolRegistry.register(new WebSearchTool()); } catch { /* já registrado */ }
try { ToolRegistry.register(new ReadTool()); } catch { /* já registrado */ }

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

const OK_PLAN = JSON.stringify({ steps: [{ id: 'step_1', description: 'passo', toolName: 'read', toolArgs: { path: 'a.txt' } }], strategy: 'S314', successCriteria: [] });

function makeFakePlanner(): { planner: GoalPlanner; prompts: string[] } {
    const prompts: string[] = [];
    const chat = async (messages: Array<{ content: string }>) => { prompts.push(messages[0]?.content ?? ''); return { content: OK_PLAN }; };
    const pf = {
        getProviderWithModel: () => ({ chat }),
        chatWithFallback: async (messages: Array<{ content: string }>) => { const r = await chat(messages); return { status: 'success', content: r.content, attempts: [] }; },
    } as any;
    return { planner: new GoalPlanner(pf, { findBlockerLessons: () => '', findHardConstraints: () => [] } as any), prompts };
}

function makeGoal(): Goal {
    const now = Date.now();
    const blockers: GoalBlocker[] = [{ kind: 'goal_incomplete', description: 'faltou entregar o resultado', suggestedActions: [], detectedAt: now } as GoalBlocker];
    return {
        id: 'goal_s314', sessionKey: 'test:s314', conversationId: 'test-conv-s314', userIntent: 'objetivo de teste S314', objective: 'Objetivo de teste S314',
        status: 'blocked', currentPlan: [], attempts: [], blockers, toolsTried: [], strategiesTried: [], successCriteria: [], sentArtifacts: [],
        retryBudget: 3, replanBudget: 5, confidence: 0.9, requiresAuth: false, authorizationScope: [], createdAt: now, updatedAt: now, expiresAt: now + 3_600_000,
    } as Goal;
}

async function main(): Promise<void> {
    const hint = powerpointControlTool.requiredArgsHint;

    console.log('\n[1] a linha existe e segue o formato das demais');
    assert(typeof hint === 'string' && hint.length > 0, 'requiredArgsHint definido');
    assert(hint.startsWith('- powerpoint_control: '), 'segue o formato "- <tool>: ..." (como as outras tools)', hint.slice(0, 40));
    assert(/\baction\b/.test(hint) && /addTextBox/.test(hint), 'cita `action` e o valor aceito addTextBox', hint);
    assert(/\btext\b/.test(hint) && /\bx\b/.test(hint) && /\by\b/.test(hint), 'cita `text` (obrigatório) e `x`/`y` (opcionais)');
    assert(/suplemento do PowerPoint/.test(hint), 'registra a precondição de sessão (só funciona no suplemento)');
    assert(!hint.includes('\n'), 'é uma linha só (o bloco agregado é uma linha por tool)');

    console.log('\n[2] fonte única: a lista de ações vem de `parameters`');
    const enumRef = (powerpointControlTool as any).parameters.properties.action.enum as string[];
    const saved = enumRef.slice();
    try {
        enumRef.push('getSlide');
        assert(powerpointControlTool.requiredArgsHint.includes('addTextBox|getSlide'), 'ao ganhar um valor no enum, o hint o inclui (sem segunda lista a manter)', powerpointControlTool.requiredArgsHint);
    } finally {
        enumRef.length = 0; saved.forEach(v => enumRef.push(v));
    }
    assert(powerpointControlTool.requiredArgsHint === hint, 'enum restaurado → o hint volta a ser idêntico ao original');

    console.log('\n[3] chega aos prompts reais de plan() e de replan()');
    const goal = makeGoal();
    const rep = makeFakePlanner(); await rep.planner.replan(goal, goal.blockers[0]);
    const replanPrompt = rep.prompts[0] ?? '';
    const refIdx = replanPrompt.indexOf('REFERÊNCIA DE ARGS OBRIGATÓRIOS:');
    assert(refIdx > -1 && replanPrompt.indexOf(hint) > refIdx, 'replan(): a linha está sob "REFERÊNCIA DE ARGS OBRIGATÓRIOS"');
    assert(replanPrompt.split(hint).length === 2, 'replan(): aparece exatamente uma vez');
    const pl = makeFakePlanner(); await pl.planner.plan(makeGoal());
    const planPrompt = pl.prompts[0] ?? '';
    const planRefIdx = planPrompt.indexOf('ARGS OBRIGATÓRIOS POR FERRAMENTA:');
    assert(planRefIdx > -1 && planPrompt.indexOf(hint) > planRefIdx, 'plan(): a linha está sob "ARGS OBRIGATÓRIOS POR FERRAMENTA"');
    assert(planPrompt.split(hint).length === 2, 'plan(): aparece exatamente uma vez');

    console.log('\n[4] controle negativo: as demais linhas ficam como estavam');
    for (const [name, prompt] of [['replan', replanPrompt], ['plan', planPrompt]] as const) {
        assert(prompt.includes('- edit: SEMPRE forneça oldText+newText (substituição) OU startLine+endLine+content (patch) OU append=true+content. Nunca chame edit sem esses parâmetros.'), `${name}(): hint de "edit" verbatim`);
        assert(prompt.includes('- send_document: SEMPRE forneça file_path com o caminho completo do arquivo. Nunca chame send_document sem file_path.'), `${name}(): hint de "send_document" verbatim`);
        assert(!prompt.slice(prompt.indexOf('ARGS OBRIGATÓRIOS')).includes('- web_search:'), `${name}(): tool sem hint (web_search) continua fora da seção`);
    }

    console.log('\n[5] custo no prompt');
    assert(replanPrompt.length - replanPrompt.replace(`${hint}\n`, '').length === hint.length + 1, 'o acréscimo é exatamente a linha + uma quebra');
    assert(hint.length <= 300, `a linha é curta (${hint.length} chars ≤ 300) — vai a TODO prompt de plano/replan de todos os canais`);

    console.log('\n[6] guarda de deriva: o hint não contradiz a tool');
    const accepted = (powerpointControlTool as any).parameters.properties.action.enum as string[];
    const m = hint.match(/action \(([^)]*)\)/);
    assert(!!m && m[1] === accepted.join('|'), 'o valor citado no hint é exatamente o do enum', m?.[1]);
    const rejected = await (async () => { powerpointControlTool.setContext('powerpoint-addin-s314'); return powerpointControlTool.execute({ action: 'valor_inexistente' }); })();
    assert(rejected.success === false && /não é suportada/.test(rejected.output ?? ''), 'execute() rejeita uma ação fora do enum — o hint não promete mais do que a tool faz');

    console.log(`\n${passed} passou, ${failed} falhou`);
    process.exit(failed === 0 ? 0 : 1);
}

main().catch(err => { console.error('ERRO NÃO TRATADO:', err); process.exit(1); });
