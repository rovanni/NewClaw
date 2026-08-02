/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S176
 * A rota de goal é decidida por `requiresPlanning`, nunca por `requiresTools`.
 *
 * CONTEXTO (incidente real, 02/08/2026, logs/newclaw-audit.log): a pergunta "Explique melhor
 * scaffolding (andaime pedagógico)?" foi feita CINCO vezes no mesmo dia. Todas viraram goal com
 * ciclo completo de planejamento:
 *
 *     11:33 → 3m54s   · 6 ciclos · 2 replans · entregou 268 chars
 *     12:03 → 38m31s  · 5 ciclos · 2 replans · FALHOU  (goal_1785682989222_q7r69)
 *     15:12 → 1m02s   · 2 ciclos · 0 replans · entregou 266 chars
 *     15:38 → 53s     · 2 ciclos · 0 replans · entregou 308 chars
 *
 * CAUSA: `GoalOrchestrator` lia `routerDecision.requiresTools` para decidir "isto é um goal?".
 * Esse campo é `true` para QUALQUER mensagem que possa usar uma ferramenta — inclusive toda
 * pergunta capaz de disparar `memory_search`. E ele nunca separou os dois caminhos, porque o
 * AgentLoop também executa tools: `route=agentloop` não significa "sem ferramenta", significa
 * "sem o ciclo plan → execute → validate → replan".
 *
 * O campo que responde a pergunta certa já existia — `requiresPlanning`, documentado como
 * "Whether multi-step planning is needed" — mas estava MORTO: `false` em todas as 10 regras
 * determinísticas e em 7 das 12 categorias, e nunca consultado por ninguém.
 *
 * CORREÇÃO: `requiresPlanning` passa a ser populado segundo o contrato (etapas interdependentes
 * + desfecho verificável + falha recuperável por outra estratégia), e o `GoalOrchestrator` lê
 * ESSE campo. Não é uma exceção por categoria no orquestrador — é o campo certo, populado certo.
 *
 * MEDIÇÃO QUE GUIOU O DESENHO (sonda com classificador e LLM reais, 02/08/2026): `cognitiveLoad`
 * da pergunta é 'normal', não 'deep' — logo o override `cognitiveLoad === 'deep' →
 * requiresPlanning = true` não mascara a correção. A mesma sonda mostrou `requiresPlanning=false`
 * para 'audio' e 'data_analysis', provando que ler o campo CRU (sem repopulá-lo) tiraria do
 * caminho de goal justamente o que precisa dele.
 *
 * REGRESSÃO SE: o orquestrador voltar a ler `requiresTools`; ou uma pergunta pura voltar a
 * exigir o ciclo de goal; ou uma tarefa multi-etapa (criação, comando, áudio, visão, análise)
 * deixar de exigi-lo.
 *
 * Execução: npx ts-node src/__tests__/regression/S176_GoalRouting_RequiresPlanningNotRequiresTools.test.ts
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

// Sem providerFactory o router usa keyword routing — determinístico, sem LLM, sem rede.
const router = new UnifiedIntentRouter();

async function main(): Promise<void> {

console.log('\n=== S176-1 — GoalOrchestrator lê requiresPlanning, não requiresTools ===');
{
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'loop', 'GoalOrchestrator.ts'), 'utf-8');
    assert(
        /routerRequiresGoal = routerDecision\.requiresPlanning;/.test(src),
        'a decisão de rota vem de requiresPlanning',
    );
    assert(
        !/routerRequiresGoal = routerDecision\.requiresTools;/.test(src),
        'não volta a decidir a rota por requiresTools — era a causa do incidente',
    );
    assert(
        /router_requiresPlanning=\$\{routerRequiresGoal\}/.test(src),
        'a telemetria expõe o campo que de fato decidiu',
    );
    assert(
        /router_requiresTools=\$\{routerRequiresTools\}/.test(src),
        'requiresTools continua observável no log, agora como informação e não como decisão',
    );
}

console.log('\n=== S176-2 — o contrato do campo está documentado no tipo ===');
{
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'loop', 'UnifiedIntentRouter.ts'), 'utf-8');
    assert(
        /CONTRATO: `true` quando há etapas que dependem umas das outras/.test(src),
        'IntentDecision.requiresPlanning carrega o contrato explícito',
    );
    assert(
        /ATENÇÃO — isto NÃO responde "isto é um goal\?"/.test(src),
        'IntentDecision.requiresTools avisa que não responde a pergunta de roteamento',
    );
}

console.log('\n=== S176-3 — o campo deixou de estar morto nas regras determinísticas ===');
{
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'loop', 'UnifiedIntentRouter.ts'), 'utf-8');
    const bloco = src.slice(src.indexOf('const DETERMINISTIC_RULES'), src.indexOf('const SEMANTIC_RULES'));
    const comPlanning = (bloco.match(/requiresPlanning: true,/g) ?? []).length;
    assert(
        comPlanning >= 3,
        `regras determinísticas multi-etapa marcam requiresPlanning=true (encontradas: ${comPlanning})`,
    );
}

// O que esta correção mudou é o MAPEAMENTO categoria → flags (strategySelection), não o
// classificador. Testar via route() sem LLM mediria o fallback por keyword — que classifica
// "Explique melhor scaffolding" como 'conversation' — e não o mapeamento. A acurácia do
// classificador é escopo de S71; aqui a categoria é dada e verifica-se a decisão derivada dela.
type Semantic = Parameters<typeof strategySelection>[1];
const { strategySelection } = router as unknown as {
    strategySelection: (
        input: string,
        semantic: {
            category: string;
            modelCategory: string;
            cognitiveLoad: string;
            requiresReasoning: boolean;
            confidence: number;
        },
        context?: unknown,
    ) => { requiresPlanning: boolean; requiresTools: boolean };
};
const decidirPara = (category: string, cognitiveLoad = 'normal') =>
    strategySelection.call(router, '', {
        category, modelCategory: 'chat', cognitiveLoad,
        requiresReasoning: cognitiveLoad !== 'minimal', confidence: 0.9,
    } as Semantic);

console.log('\n=== S176-4 — categorias de resposta única NÃO exigem o ciclo de goal ===');
{
    for (const category of ['information', 'memory_operation', 'conversation', 'greeting']) {
        const d = decidirPara(category);
        assert(
            d.requiresPlanning === false,
            `category='${category}' → requiresPlanning=false`,
            d.requiresPlanning,
        );
    }
}

console.log('\n=== S176-5 — categorias multi-etapa CONTINUAM exigindo o ciclo de goal ===');
{
    // Proteção contra a regressão oposta: esvaziar o caminho de goal.
    for (const category of ['creation', 'system_operation', 'data_analysis', 'audio', 'vision', 'destructive']) {
        const d = decidirPara(category);
        assert(
            d.requiresPlanning === true,
            `category='${category}' → requiresPlanning=true`,
            d.requiresPlanning,
        );
    }
}

console.log('\n=== S176-6 — os dois campos respondem perguntas DIFERENTES ===');
{
    // Uma pergunta PODE usar tools (o AgentLoop as executa) sem por isso precisar de
    // planejamento. É exatamente essa coexistência que `requiresTools` não sabia expressar.
    const d = decidirPara('information');
    assert(
        d.requiresTools === true && d.requiresPlanning === false,
        'information: requiresTools=true e requiresPlanning=false convivem',
        { tools: d.requiresTools, planning: d.requiresPlanning },
    );
}

console.log('\n=== S176-6b — regras determinísticas multi-etapa, ponta a ponta ===');
{
    // Estas passam pelo gate determinístico (sem LLM), então route() é fiel aqui.
    const casos: Array<[string, string]> = [
        ['rode o comando npm install no servidor', 'system_operation'],
        ['me envie um áudio narrando o resumo', 'audio'],
        ['rm -rf /tmp/dados', 'system_operation'],
    ];
    for (const [input, esperado] of casos) {
        const d = await router.route(input);
        assert(
            d.requiresPlanning === true,
            `"${input.slice(0, 38)}" → requiresPlanning=true (categoria: ${d.category}, esperada ${esperado})`,
            d.requiresPlanning,
        );
    }
}

console.log('\n=== S176-7 — carga cognitiva profunda ainda escala para o ciclo de goal ===');
{
    // Escape hatch preservado: uma pergunta classificada como 'deep' volta a exigir planejamento
    // (override em strategySelection). Garante que o fix não fecha a porta para perguntas que
    // genuinamente precisam de várias etapas.
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'loop', 'UnifiedIntentRouter.ts'), 'utf-8');
    assert(
        /if \(cognitiveLoad === 'deep'\) \{\s*\n\s*requiresPlanning = true;/.test(src),
        'override de cognitiveLoad=deep preservado',
    );
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S176 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
console.log(`\nCOBERTURA:`);
console.log(`  Orquestrador lendo o campo correto: testado`);
console.log(`  Perguntas fora do ciclo de goal: testado`);
console.log(`  Tarefas multi-etapa dentro do ciclo: testado`);
console.log(`  Distinção requiresTools × requiresPlanning: testado`);
console.log(`  Escape hatch de carga profunda: testado`);
if (failed > 0) process.exitCode = 1;

}

main().catch((err) => {
    console.error('S176 erro inesperado:', err);
    process.exitCode = 1;
});
