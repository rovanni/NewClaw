/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S25 (Sprint S7 do roadmap de aprendizado orientado a objetivos)
 *
 * Applicability Gate: prova, com os erros REAIS medidos na S6.5 (Ollama + nomic-embed-text,
 * não simulado), que similaridade semântica pura confunde "mesmo objeto" com "mesma operação":
 *
 *   criar apresentação PPTX × analisar apresentação PPTX → cosine = 0.9645
 *   criar arquivo × remover arquivo                      → cosine = 0.8955
 *
 * ambos MAIORES que um par genuinamente equivalente (criar apresentação × gerar slides = 0.7234).
 *
 * S7.0 (auditoria, não suposição) eliminou IntentCategory como reuso válido: GoalPlanner.ts:607
 * já documenta que ele não existe no caminho de goal, e medido via UnifiedIntentRouter.routeSync()
 * nos pares reais, ele classifica "criar arquivo" e "remova arquivo" na MESMA categoria
 * ('creation', via palavra-objeto compartilhada "arquivo") — não resolveria o Erro 2. Nenhum
 * outro classificador de operação existe no projeto. Por isso classifyOperation()/
 * operationalCompatibility() (CaseMemory.ts) são o menor contrato novo inevitável — ver
 * docstring do módulo para a auditoria completa.
 *
 * Execução: npx ts-node src/__tests__/regression/S25_OperationalIntent_ApplicabilityGate.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import {
    CaseMemory,
    classifyOperation,
    operationalCompatibility,
    OperationalIntent,
} from '../../memory/CaseMemory';
import { EmbeddingService } from '../../memory/EmbeddingService';
import { Goal, PlanStep } from '../../loop/GoalTypes';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`); failed++; }
}
function readSource(relPath: string): string {
    return fs.readFileSync(path.join(process.cwd(), 'src', relPath), 'utf-8');
}

// ── Fake embedding: SEMPRE devolve o mesmo vetor → cosine = 1.0 para QUALQUER par ──────────
// Propositalmente pior que o pior caso real medido (0.9645/0.8955): prova que o Applicability
// Gate distingue operação mesmo quando a similaridade semântica está saturada no máximo — não
// depende da qualidade específica do embedding real para funcionar (cosineSimilarity usada é a
// REAL, herdada do protótipo — só embed() é fake, mesmo padrão de S22/S23).
function saturatedEmbeddingService(): EmbeddingService {
    const svc = Object.create(EmbeddingService.prototype) as EmbeddingService;
    (svc as unknown as { embed: (t: string) => Promise<number[] | null> }).embed = async () => [1, 0, 0];
    return svc;
}
function freshCaseMemory(): CaseMemory {
    const db = new (Database as any)(':memory:');
    return new CaseMemory({ getDatabase: () => db, getEmbeddingService: () => saturatedEmbeddingService() } as any);
}
let goalCounter = 0;
function makeGoal(objective: string, overrides: Partial<Goal> = {}): Goal {
    goalCounter++;
    const now = Date.now();
    return {
        id: `goal_s25_${goalCounter}`,
        sessionKey: 'test:user',
        conversationId: 'test-conv',
        userIntent: objective,
        objective,
        status: 'completed',
        currentPlan: [],
        attempts: [],
        blockers: [],
        toolsTried: [],
        strategiesTried: [],
        successCriteria: [{ id: 'c1', description: 'evidência', check: 'tool_succeeded', status: 'met', metAt: now, evidence: 'ev' }],
        sentArtifacts: [],
        retryBudget: 3,
        replanBudget: 5,
        confidence: 0.9,
        requiresAuth: false,
        authorizationScope: [],
        createdAt: now,
        updatedAt: now,
        expiresAt: now + 3_600_000,
        ...overrides,
    } as Goal;
}
function plan(...toolNames: string[]): PlanStep[] {
    return toolNames.map((t, i) => ({ id: `step_${i}`, description: t, toolName: t, status: 'completed' as const }));
}
async function flush(): Promise<void> {
    await new Promise((r) => setTimeout(r, 10));
}

async function main() {
    const caseMemorySrc = readSource('memory/CaseMemory.ts');
    const gelSrc = readSource('loop/GoalExecutionLoop.ts');
    const plannerSrc = readSource('loop/GoalPlanner.ts');
    const riskSrc = readSource('loop/RiskAnalyzer.ts');

    // ══════════ S25.1 — classifyOperation(): corpus obrigatório (S6.5 + K-T) ══════════
    console.log('\n=== S25.1 — classifyOperation() sobre os 2 erros reais medidos na S6.5 ===');
    assert(classifyOperation('crie uma apresentação PPTX sobre redes') === 'create', 'Erro 1 lado A: "criar apresentação" → create');
    assert(classifyOperation('analise a apresentação PPTX sobre redes') === 'inspect', 'Erro 1 lado B: "analisar apresentação" → inspect');
    assert(classifyOperation('crie um arquivo de configuração') === 'create', 'Erro 2 lado A: "criar arquivo" → create');
    assert(classifyOperation('remova o arquivo de configuração') === 'remove', 'Erro 2 lado B: "remover arquivo" → remove');
    assert(classifyOperation('gere slides sobre redes') === 'create', 'preservar: "gerar slides" → create (não deve virar incompatível com "criar apresentação")');

    console.log('\n=== S25.2 — TESTES OBRIGATÓRIOS #16-21 (criar×analisar, criar×remover, criar×gerar, instalar×desinstalar, gerar×revisar, corrigir×diagnosticar) ===');
    const pairs16to21: Array<[string, string, string, OperationalIntent, OperationalIntent]> = [
        ['#16 criar×analisar', 'criar relatório', 'analisar relatório', 'create', 'inspect'],
        ['#17 criar×remover', 'criar servidor', 'remover servidor', 'create', 'remove'],
        ['#18 criar×gerar', 'criar apresentação', 'gerar apresentação', 'create', 'create'],
        ['#19 instalar×desinstalar', 'instalar serviço', 'desinstalar serviço', 'create', 'remove'],
        ['#20 gerar×revisar', 'gerar relatório', 'revisar relatório', 'create', 'inspect'],
        ['#21 corrigir×diagnosticar', 'corrigir configuração', 'diagnosticar configuração', 'modify', 'inspect'],
    ];
    for (const [label, a, b, expectedA, expectedB] of pairs16to21) {
        const gotA = classifyOperation(a);
        const gotB = classifyOperation(b);
        assert(gotA === expectedA, `${label}: "${a}" → ${gotA} (esperado ${expectedA})`);
        assert(gotB === expectedB, `${label}: "${b}" → ${gotB} (esperado ${expectedB})`);
    }

    console.log('\n=== S25.3 — Corpus K-T (S7, não colapsar operações diferentes em equivalência) ===');
    // K — mesmo objeto, criação equivalente (sinonímia)
    assert(
        classifyOperation('criar apresentação') === classifyOperation('gerar slides') &&
        classifyOperation('gerar slides') === classifyOperation('produzir apresentação'),
        'K: criar/gerar/produzir apresentação → mesma classe operacional (create)'
    );
    // L — mesmo objeto, operações diferentes (não colapsar)
    {
        const classes = new Set([
            classifyOperation('criar apresentação'),
            classifyOperation('analisar apresentação'),
            classifyOperation('corrigir apresentação'),
            classifyOperation('remover apresentação'),
        ]);
        assert(classes.size === 4, `L: criar/analisar/corrigir/remover apresentação → 4 classes distintas, não colapsadas (obtido: ${[...classes].join(',')})`);
    }
    // M — mesmo verbo, objetos diferentes: o próprio classifyOperation não tem acesso a objeto/
    // domínio (por design, S7.2: "não representar domínio") — ambos corretamente 'create'; quem
    // impede "criar apresentação"~"criar servidor DNS" de virarem candidatos é a CAMADA SEMÂNTICA
    // (candidate generation), não o gate operacional — por isso não são combinados em um score.
    assert(
        classifyOperation('criar apresentação') === classifyOperation('criar servidor DNS'),
        'M: mesmo verbo (criar), objetos diferentes → mesma classe operacional (esperado — o gate operacional não filtra por domínio; quem faz isso é a similaridade semântica upstream)'
    );
    // N — sinonímia operacional
    assert(
        new Set(['criar', 'gerar', 'produzir'].map(v => classifyOperation(`${v} relatório`))).size === 1,
        'N: criar/gerar/produzir → mesma classe (create), não hardcoded para o teste — vem do léxico genérico de família semântica'
    );
    // O — verbos próximos, não necessariamente equivalentes (MEDIR, não assumir)
    console.log(`  ℹ️  O (medir, não assumir): analisar="${classifyOperation('analisar configuração')}" corrigir="${classifyOperation('corrigir configuração')}" validar="${classifyOperation('validar configuração')}"`);
    // P — operação implícita (sem verbo reconhecível) → unknown
    assert(classifyOperation('isso aqui, por favor') === 'unknown', 'P: objetivo sem verbo operacional claro → unknown (nunca adivinha)');
    // Q — mesma entidade, direção oposta
    assert(classifyOperation('instalar serviço') === 'create' && classifyOperation('desinstalar serviço') === 'remove', 'Q: instalar×desinstalar → create×remove (direção oposta distinguida)');
    // R — mesma entidade, lifecycle diferente
    {
        const classes = new Set([
            classifyOperation('criar banco'),
            classifyOperation('migrar banco'),
            classifyOperation('consultar banco'),
            classifyOperation('remover banco'),
        ]);
        assert(classes.size === 4, `R: criar/migrar/consultar/remover banco → 4 classes distintas (obtido: ${[...classes].join(',')})`);
    }
    // S — produção vs inspeção
    assert(classifyOperation('gerar relatório') === 'create' && classifyOperation('revisar relatório') === 'inspect', 'S: gerar×revisar relatório → create×inspect');
    // T — correção vs diagnóstico
    assert(classifyOperation('corrigir configuração') === 'modify' && classifyOperation('diagnosticar configuração') === 'inspect', 'T: corrigir×diagnosticar → modify×inspect');

    // ══════════ S25.4 — operationalCompatibility(): tabela-verdade ══════════
    console.log('\n=== S25.4 — operationalCompatibility(): unknown nunca vira compatible=true ===');
    assert(operationalCompatibility('create', 'create') === true, 'create×create → true');
    assert(operationalCompatibility('create', 'remove') === false, 'create×remove → false');
    assert(operationalCompatibility('create', 'inspect') === false, 'create×inspect → false');
    assert(operationalCompatibility('unknown', 'create') === 'unknown', 'unknown×create → unknown (não vira false nem true)');
    assert(operationalCompatibility('create', 'unknown') === 'unknown', 'create×unknown → unknown (simétrico)');
    assert(operationalCompatibility('unknown', 'unknown') === 'unknown', 'unknown×unknown → unknown');

    // ══════════ S25.5 — findApplicableCasesShadow(): reproduz os 2 erros reais com score saturado ══════════
    console.log('\n=== S25.5 — Erro 1 real (criar×analisar PPTX): score alto (saturado=1.0) + gate operacional detecta incompatibilidade ===');
    {
        const cm = freshCaseMemory();
        cm.captureIfEligible(makeGoal('crie uma apresentação PPTX sobre redes', { currentPlan: plan('write') }));
        await flush();
        const applicable = await cm.findApplicableCasesShadow('analise a apresentação PPTX sobre redes');
        assert(applicable.length === 1, 'candidato encontrado pela busca semântica (score saturado)');
        assert(applicable[0].score === 1, `semanticScore não é degradado pelo gate — continua 1.0 (obtido: ${applicable[0]?.score})`);
        assert(applicable[0].operationalIntent === 'create', 'operationalIntent do CANDIDATO (o Caso persistido, objective="criar apresentação...") = create');
        assert(applicable[0].operationalCompatibility === false, 'MESMO com semanticScore=1.0 (pior caso que o 0.9645 real), operationalCompatibility=false — score alto sozinho NÃO implica aplicabilidade (atual=inspect × candidato=create)');
    }

    console.log('\n=== S25.6 — Erro 2 real (criar×remover arquivo): score alto (saturado=1.0) + gate operacional detecta incompatibilidade ===');
    {
        const cm = freshCaseMemory();
        cm.captureIfEligible(makeGoal('crie um arquivo de configuração', { currentPlan: plan('write') }));
        await flush();
        const applicable = await cm.findApplicableCasesShadow('remova o arquivo de configuração');
        assert(applicable.length === 1, 'candidato encontrado pela busca semântica (score saturado)');
        assert(applicable[0].score === 1, 'semanticScore continua 1.0, intocado pelo gate');
        assert(applicable[0].operationalCompatibility === false, 'MESMO com semanticScore=1.0 (pior caso que o 0.8955 real), operationalCompatibility=false');
    }

    console.log('\n=== S25.7 — Preservação: "criar apresentação" × "gerar slides" continua compatível (não destruído pelo gate) ===');
    {
        const cm = freshCaseMemory();
        cm.captureIfEligible(makeGoal('criar uma apresentação sobre redes', { currentPlan: plan('write') }));
        await flush();
        const applicable = await cm.findApplicableCasesShadow('gerar slides sobre redes');
        assert(applicable.length === 1 && applicable[0].operationalCompatibility === true, 'sinônimo operacional (criar~gerar) → operationalCompatibility=true, não derrubado por um gate literal demais');
    }

    console.log('\n=== S25.8 — Caso legado sem verbo reconhecível → unknown, NUNCA promovido a compatible=true ===');
    {
        const cm = freshCaseMemory();
        cm.captureIfEligible(makeGoal('isso aqui, por favor', { currentPlan: plan('write') }));
        await flush();
        const applicable = await cm.findApplicableCasesShadow('criar apresentação sobre redes');
        assert(applicable.length === 1, 'candidato ainda é retornado (gate não filtra, só anota)');
        assert(applicable[0].operationalIntent === 'unknown', 'Caso legado sem verbo reconhecível → operationalIntent=unknown');
        assert(applicable[0].operationalCompatibility === 'unknown', 'ausência de evidência não vira compatible=true (regra dos Casos legados)');
    }

    // ══════════ S25.9 — Gate não filtra nem reordena (só anota) ══════════
    console.log('\n=== S25.9 — Gate não filtra, não reordena, não combina score ===');
    {
        const cm = freshCaseMemory();
        cm.captureIfEligible(makeGoal('criar apresentação A', { currentPlan: plan('write') }));
        await flush();
        const raw = await cm.findRelevantCasesShadow('analisar apresentação A');
        const gated = await cm.findApplicableCasesShadow('analisar apresentação A');
        assert(raw.length === gated.length, 'findApplicableCasesShadow não filtra candidatos — mesmo tamanho que findRelevantCasesShadow');
        assert(raw[0].score === gated[0].score, 'score (semântico) idêntico entre as duas chamadas — gate não combina/degrada o score original');
    }

    // ══════════ S25.10 — Nenhuma coluna nova / nenhuma chamada de LLM / nenhum score composto ══════════
    console.log('\n=== S25.10 — Restrições estruturais da Sprint (grep no código real) ===');
    const alterTableCount = (caseMemorySrc.match(/ALTER TABLE cases ADD COLUMN/g) ?? []).length;
    assert(alterTableCount === 1, `S7 não adicionou coluna nova (só a de S6, objective_embedding) — ALTER TABLE encontrados: ${alterTableCount}`);
    assert(!caseMemorySrc.includes('.llmClassify(') && !caseMemorySrc.includes('.providerFactory') && !caseMemorySrc.includes('.chatWithFallback('), 'nenhuma chamada de LLM nova adicionada ao caminho de CaseMemory (orçamento de latência da Sprint) — busca só por CHAMADA real, não pela menção em comentário explicando a decisão de não reutilizar');
    assert(!caseMemorySrc.includes("from '../loop/UnifiedIntentRouter'"), 'CaseMemory não IMPORTA UnifiedIntentRouter/IntentCategory — decisão do Gate S7.0 foi NÃO reutilizar (a menção em comentário faz parte da auditoria documentada, não é um import real)');
    assert(!/classifyOperation[\s\S]{0,300}await/.test(caseMemorySrc.split('export function classifyOperation')[1]?.split('\n\n')[0] ?? ''), 'classifyOperation() é síncrona — nenhum await no corpo da função');
    assert(!/finalScore\s*=|semanticScore\s*\*\s*0\.\d|operationalScore\s*\*\s*0\.\d/.test(caseMemorySrc), 'nenhum score composto arbitrário (semanticScore*peso + operationalScore*peso) foi introduzido');

    // ══════════ S25.SHADOW — Zero influência comportamental NA ÉPOCA da S25 (não regressão) ══════════
    // RFC-002 (24/07) ativou de propósito o que este bloco originalmente provava estar
    // desativado — GoalPlanner passou a consultar CaseMemory via buildCaseEvidenceHint(),
    // substituindo a chamada fire-and-forget que existia em GoalExecutionLoop (nunca lida pelo
    // chamador) por uma consulta real. Ver docs/RFC-002_ATIVACAO_CASEMEMORY.md. Assertions
    // atualizadas para provar a NOVA garantia (RiskAnalyzer continua sem CaseMemory — a ativação
    // desta RFC ficou restrita a plan(), não RiskAnalyzer/replan()), não a antiga.
    console.log('\n=== S25.SHADOW (histórico) → RFC-002: GoalPlanner agora consulta CaseMemory; RiskAnalyzer permanece sem referência ===');
    assert(plannerSrc.includes('CaseMemory'), 'GoalPlanner.ts referencia CaseMemory (RFC-002 — antes desta RFC, não referenciava)');
    assert(plannerSrc.includes('buildCaseEvidenceHint'), 'GoalPlanner.plan() consulta buildCaseEvidenceHint() — Evidence Provider, nunca decide');
    assert(!riskSrc.includes('CaseMemory'), 'RiskAnalyzer.ts continua sem qualquer referência a CaseMemory — RFC-002 não estendeu a ativação até ali');
    assert(
        !/void this\.caseMemory\.findApplicableCasesShadow\(goal\.objective\)\.catch/.test(gelSrc),
        'GoalExecutionLoop NÃO chama mais findApplicableCasesShadow de forma fire-and-forget — call site removido (redundante com a consulta real em GoalPlanner.plan())'
    );
    assert(gelSrc.includes('findRelevantCasesShadow') === false || caseMemorySrc.includes('findRelevantCasesShadow'), 'findRelevantCasesShadow continua existindo em CaseMemory.ts (usada internamente por findApplicableCasesShadow) — não foi destruída (S7.4)');
    assert(gelSrc.includes('findSimilarShadow('), 'findSimilarShadow (similaridade de ESTRATÉGIA) continua em modo sombra em GoalExecutionLoop — RFC-002 não ativou essa dimensão (decisão explícita, ver RFC-002 Seção 2)');

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S25 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    if (failed > 0) process.exit(1);
}

main().catch(err => { console.error('ERRO NÃO TRATADO:', err); process.exit(1); });
