/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S23 (Sprint S6 do roadmap de aprendizado orientado a objetivos)
 *
 * Prova que CaseMemory.findRelevantCasesShadow(objective) responde a uma pergunta
 * DIFERENTE de findSimilarShadow(plan): "já resolvi um PROBLEMA parecido?" em vez de
 * "já executei um PIPELINE de tools parecido?". Cobre os testes adversariais A-J exigidos
 * pela S6, a comparação obrigatória old-vs-new, e confirma modo sombra (zero influência).
 *
 * LIMITAÇÃO HONESTA (documentada, não escondida): EmbeddingService.embed() real chama um
 * servidor Ollama local (nomic-embed-text) — este projeto não roda esse servidor em CI/teste
 * (mesmo padrão de "sem LLM real em teste" já usado em S7/S19/S21). Um EmbeddingService FAKE
 * é usado aqui, com uma função bag-of-conceitos determinística (fakeEmbed) que:
 *   - reconhece sobreposição LEXICAL real (funciona para A, B, D, E, F, G, I — não exige
 *     entendimento de sinônimo, só contagem de palavras/conceitos compartilhados);
 *   - para C/H/J (sinônimos/PT-BR com formulação diferente), usa clusters de sinônimo
 *     MANUALMENTE mapeados só para testar se a LÓGICA DE RECUPERAÇÃO usa corretamente
 *     qualquer vetor que receba — isso NÃO é uma alegação sobre a qualidade real do modelo
 *     nomic-embed-text via Ollama (validar isso exigiria o servidor real rodando, fora do
 *     escopo desta Sprint — mesma limitação já declarada para "dados reais insuficientes").
 * A matemática de cosseno usada é a REAL (EmbeddingService.prototype.cosineSimilarity,
 * tornada pública nesta Sprint) — só a geração do vetor é fake.
 *
 * Execução: npx ts-node src/__tests__/regression/S23_CaseRetrieval_ProblemSimilarity.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { CaseMemory } from '../../memory/CaseMemory';
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

// ── Fake embedding: bag-of-conceitos determinístico (ver limitação no cabeçalho) ─────────
// NOTA: inclui formas conjugadas/plurais das mesmas palavras-base (ex: 'sintetizar' e
// 'sintetize', 'criptomoeda' e 'criptomoedas') — um fake bag-of-conceitos não lematiza
// sozinho; um embedding real (nomic-embed-text) generalizaria isso automaticamente, o que
// é exatamente a parte que este fake NÃO pode provar (ver limitação declarada no cabeçalho).
const SYNONYM_CLUSTERS: Record<string, string> = {
    resumir: 'c_summarize', resumo: 'c_summarize', sintetizar: 'c_summarize', sintetize: 'c_summarize', compilar: 'c_summarize', sintese: 'c_summarize',
    enviar: 'c_send', envie: 'c_send', entregar: 'c_send', mandar: 'c_send', mande: 'c_send',
    converter: 'c_convert', transformar: 'c_convert', exportar: 'c_convert',
    criar: 'c_create', gerar: 'c_create', montar: 'c_create', produzir: 'c_create', escrever: 'c_create',
    analisar: 'c_analyze', revisar: 'c_analyze', avaliar: 'c_analyze', verificar: 'c_analyze', examinar: 'c_analyze',
    documento: 'c_document', arquivo: 'c_document', relatorio: 'c_document',
    anexo: 'c_attachment', anexado: 'c_attachment',
    apresentacao: 'c_presentation', slides: 'c_presentation', pptx: 'c_presentation',
    rede: 'c_network', redes: 'c_network',
    bitcoin: 'c_crypto', cripto: 'c_crypto', cotacao: 'c_crypto', criptomoeda: 'c_crypto', criptomoedas: 'c_crypto',
    gatos: 'c_cats', gato: 'c_cats',
    noticias: 'c_news', noticia: 'c_news',
};

function stripAccents(s: string): string {
    return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function conceptsOf(text: string): string[] {
    const words = stripAccents(text.toLowerCase()).split(/[^a-z0-9]+/).filter(Boolean);
    return words.map(w => SYNONYM_CLUSTERS[w] ?? `w_${w}`);
}

/** Vocabulário fixo construído a partir de todos os textos usados nos testes abaixo —
 * garante indexação consistente do vetor "fake" entre chamadas (dimensão estável). */
function buildVocab(allTexts: string[]): string[] {
    const set = new Set<string>();
    for (const t of allTexts) for (const c of conceptsOf(t)) set.add(c);
    return [...set];
}

function makeFakeEmbeddingService(vocab: string[]): EmbeddingService {
    const svc = Object.create(EmbeddingService.prototype) as EmbeddingService;
    (svc as unknown as { embed: (t: string) => Promise<number[] | null> }).embed = async (text: string) => {
        const vec = new Array(vocab.length).fill(0);
        for (const c of conceptsOf(text)) {
            const idx = vocab.indexOf(c);
            if (idx >= 0) vec[idx] += 1;
        }
        return vec;
    };
    return svc; // cosineSimilarity real é herdado do protótipo (não sobrescrito)
}

function freshCaseMemory(vocab: string[]): CaseMemory {
    const db = new (Database as any)(':memory:');
    const fakeMemory = {
        getDatabase: () => db,
        getEmbeddingService: () => makeFakeEmbeddingService(vocab),
    };
    return new CaseMemory(fakeMemory as any);
}

let goalCounter = 0;
function makeGoal(objective: string, overrides: Partial<Goal> = {}): Goal {
    goalCounter++;
    const now = Date.now();
    return {
        id: `goal_s23_${goalCounter}`,
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

/** Espera o embedding fire-and-forget de captureIfEligible() terminar antes de consultar. */
async function flush(): Promise<void> {
    await new Promise((r) => setTimeout(r, 10));
}

async function main() {
    const caseMemorySrc = readSource('memory/CaseMemory.ts');
    const gelSrc = readSource('loop/GoalExecutionLoop.ts');
    const plannerSrc = readSource('loop/GoalPlanner.ts');
    const riskSrc = readSource('loop/RiskAnalyzer.ts');
    const embeddingSrc = readSource('memory/EmbeddingService.ts');

    // ══════════ S6.0 — Reuso confirmado estruturalmente ══════════
    console.log('\n=== S23.S6.0 — CaseMemory reaproveita EmbeddingService via MemoryManager.getEmbeddingService() ===');
    assert(caseMemorySrc.includes('memory.getEmbeddingService()'), 'CaseMemory obtém EmbeddingService via MemoryManager (mesmo padrão já usado por MemoryCurator) — nenhum provider novo');
    assert(!caseMemorySrc.includes('fetch('), 'CaseMemory não faz chamada HTTP própria ao Ollama — delega inteiramente ao EmbeddingService existente');
    assert(embeddingSrc.includes('cosineSimilarity(a: number[], b: number[]): number {') && !embeddingSrc.includes('private cosineSimilarity'), 'cosineSimilarity tornado público (era private) — reaproveitado, não duplicado pela 3ª vez');

    // ══════════ S6.1 — objective sozinho é assinatura suficiente? (teste A/B validam isso) ══════════
    // Casos A-J abaixo constroem o vocabulário compartilhado necessário para indexação estável.
    const allObjectives = [
        'Converter relatorio.docx para PDF',
        'Pesquisar e resumir noticias sobre gatos',
        'Qual a cotacao do bitcoin hoje',
        'Envie um resumo do documento anexado por aqui',
        'Sintetize o arquivo anexo e mande para mim',
        'Gerar relatorio em PDF',
        'criar arquivo de configuracao',
        'analisar arquivo de configuracao',
        'criar apresentacao pptx sobre redes',
        'analisar apresentacao pptx sobre redes',
        'montar slides sobre redes de computadores',
        'revisar slides sobre protocolos de rede',
        'corrija isso',
        'Gere um resumo das noticias de hoje sobre criptomoedas',
        'Compile uma sintese das ultimas noticias de criptomoeda',
    ];
    const vocab = buildVocab(allObjectives);

    // ══════════ Caso A — mesmo objetivo, planos diferentes → candidato relacionado (sem exigir fingerprint) ══════════
    console.log('\n=== S23.A — Mesmo objetivo, planos DIFERENTES → problem-similarity ENCONTRA (corrige falso negativo da S22.A) ===');
    {
        const cm = freshCaseMemory(vocab);
        cm.captureIfEligible(makeGoal('Converter relatorio.docx para PDF', { currentPlan: plan('exec_command', 'send_document') }));
        await flush();
        const oldWay = cm.findSimilarShadow(plan('pandoc', 'send_document'));
        const newWay = await cm.findRelevantCasesShadow('Converter relatorio.docx para PDF');
        assert(oldWay.length === 0, '[OLD] findSimilarShadow (pipeline diferente) continua não encontrando — comportamento preservado');
        assert(newWay.length === 1, '[NEW] findRelevantCasesShadow encontra o Caso pelo objetivo, independente do plano usado');
    }

    // ══════════ Caso B — objetivos diferentes, mesmo pipeline → não tratar como relacionado ══════════
    console.log('\n=== S23.B — Objetivos DIFERENTES, mesmo pipeline → problem-similarity NÃO relaciona (corrige falso positivo da S22.B) ===');
    {
        const cm = freshCaseMemory(vocab);
        cm.captureIfEligible(makeGoal('Pesquisar e resumir noticias sobre gatos', { currentPlan: plan('web_search', 'write', 'send_document') }));
        await flush();
        const oldWay = cm.findSimilarShadow(plan('web_search', 'write', 'send_document'));
        const newWay = await cm.findRelevantCasesShadow('Qual a cotacao do bitcoin hoje');
        assert(oldWay.length === 1, '[OLD] findSimilarShadow ainda recupera por coincidência de pipeline (comportamento antigo preservado, não removido)');
        assert(
            newWay.length === 0 || newWay[0].score < 0.3,
            `[NEW] findRelevantCasesShadow não trata objetivos sem overlap léxico como relacionados (obtido: ${newWay.length ? newWay[0].score.toFixed(3) : 'nenhum candidato'})`
        );
    }

    // ══════════ Caso C — mesma intenção, wording diferente (via clusters de sinônimo fake) ══════════
    console.log('\n=== S23.C — Mesma intenção, wording diferente → reconhece SE o vetor de entrada carregar o sinal (lógica de recuperação correta) ===');
    {
        const cm = freshCaseMemory(vocab);
        cm.captureIfEligible(makeGoal('Envie um resumo do documento anexado por aqui', { currentPlan: plan('read', 'write', 'send_document') }));
        await flush();
        const candidates = await cm.findRelevantCasesShadow('Sintetize o arquivo anexo e mande para mim');
        // 0.5 é um score MODERADO-ALTO honesto pra esse fake bag-of-conceitos: várias palavras de
        // conexão ("o", "e", "para", "por", "aqui", "mim") viram dimensões próprias que não se
        // sobrepõem, diluindo a norma de cada vetor mesmo com 3 conceitos centrais coincidindo
        // (resumir↔sintetizar, documento↔arquivo, enviar↔mandar). Um embedding real tende a ser
        // mais robusto a isso — não fabricamos um score artificialmente mais alto pra "passar".
        assert(candidates.length === 1 && candidates[0].score >= 0.4, `wording totalmente diferente, mesmos conceitos (sintetizar~resumir, arquivo~documento, mandar~enviar) → recuperado com score moderado-alto, não nulo (obtido: ${candidates[0]?.score.toFixed(3) ?? 'nenhum'})`);
    }

    // ══════════ Caso D — recovery: Caso encontrado pelo problema preserva estratégia final + trajetória ══════════
    console.log('\n=== S23.D — Recovery: encontrado por PROBLEMA, mas hadRecovery/blockerKinds/planFingerprint continuam intactos ===');
    {
        const cm = freshCaseMemory(vocab);
        cm.captureIfEligible(makeGoal('Gerar relatorio em PDF', {
            currentPlan: plan('exec_command', 'send_document'),
            toolsTried: ['pandoc', 'exec_command', 'send_document'],
            blockers: [{ kind: 'dependency_missing', description: 'x', suggestedActions: [], detectedAt: Date.now() }],
        }));
        await flush();
        const candidates = await cm.findRelevantCasesShadow('Gerar relatorio em PDF');
        assert(candidates.length === 1, 'Caso recuperado por similaridade de problema');
        assert(candidates[0].hadRecovery === true, 'hadRecovery preservado no resultado da busca por problema');
        assert(candidates[0].blockerKinds.includes('dependency_missing'), 'blockerKinds preservado');
        assert(!candidates[0].planFingerprint.includes('pandoc'), 'planFingerprint continua representando só a estratégia FINAL vencedora — não contaminado pela busca por problema');
    }

    // ══════════ Caso E — mesmas tools, ordem diferente → problem-similarity não depende de ordem de plano ══════════
    console.log('\n=== S23.E — Mesmas tools em ordem diferente: fingerprint diferencia estratégia; problem-similarity nem olha o plano ===');
    {
        const cm = freshCaseMemory(vocab);
        const goal = makeGoal('Gerar relatorio em PDF', { currentPlan: plan('exec_command', 'send_document') });
        cm.captureIfEligible(goal);
        await flush();
        const strategyFwd = cm.findSimilarShadow(plan('exec_command', 'send_document'));
        const strategyRev = cm.findSimilarShadow(plan('send_document', 'exec_command'));
        assert(strategyFwd.length === 1 && strategyRev.length === 0, 'findSimilarShadow (estratégia) continua sensível à ordem — papel preservado, não alterado pela S6');
        const problemQuery = await cm.findRelevantCasesShadow('Gerar relatorio em PDF');
        assert(problemQuery.length === 1, 'findRelevantCasesShadow encontra pelo objetivo — independente de qualquer ordem de plano (nem recebe plano como argumento)');
    }

    // ══════════ Caso F — objetivos lexicalmente próximos, intenção operacional oposta ══════════
    console.log('\n=== S23.F — "criar arquivo" vs "analisar arquivo": overlap léxico residual é um falso positivo conhecido, não escondido ===');
    {
        const cm = freshCaseMemory(vocab);
        cm.captureIfEligible(makeGoal('criar arquivo de configuracao', { currentPlan: plan('write') }));
        await flush();
        const candidates = await cm.findRelevantCasesShadow('analisar arquivo de configuracao');
        assert(candidates.length === 1, 'overlap léxico ("arquivo", "configuracao") produz candidato — sistema NÃO afirma "match confiável", só retorna score (sem threshold, por design da S6)');
        assert(
            candidates[0].score < 1.0,
            `score não é perfeito — "criar" e "analisar" divergem conceitualmente (c_create vs c_analyze), reduzindo similaridade em relação a um objetivo idêntico (obtido: ${candidates[0].score.toFixed(3)})`
        );
    }

    // ══════════ Caso G — mesmo domínio, tarefas diferentes ══════════
    console.log('\n=== S23.G — Mesmo domínio ("redes"), tarefas diferentes → domínio comum não é tratado como similaridade suficiente por si só ===');
    {
        const cm = freshCaseMemory(vocab);
        cm.captureIfEligible(makeGoal('criar apresentacao pptx sobre redes', { currentPlan: plan('write') }));
        await flush();
        const sameTaskDifferentTopic = await cm.findRelevantCasesShadow('montar slides sobre redes de computadores');
        const differentTaskSameDomain = await cm.findRelevantCasesShadow('revisar slides sobre protocolos de rede');
        assert(sameTaskDifferentTopic.length === 1, 'mesma tarefa (criar/montar apresentação), mesmo domínio → recuperado');
        assert(
            differentTaskSameDomain.length === 0 || differentTaskSameDomain[0].score < sameTaskDifferentTopic[0].score,
            'tarefa DIFERENTE (revisar vs criar) no mesmo domínio (rede) produz score menor — domínio sozinho não basta'
        );
    }

    // ══════════ Caso H — objetivos equivalentes com detalhes superficiais diferentes ══════════
    console.log('\n=== S23.H — Mesma tarefa, tema/entidade diferente → não deve generalizar demais (tema pesa na similaridade) ===');
    {
        const cm = freshCaseMemory(vocab);
        cm.captureIfEligible(makeGoal('criar apresentacao pptx sobre redes', { currentPlan: plan('write') }));
        await flush();
        const sameTopic = await cm.findRelevantCasesShadow('montar slides sobre redes de computadores');
        const unrelatedTopic = await cm.findRelevantCasesShadow('Qual a cotacao do bitcoin hoje');
        assert(
            (unrelatedTopic.length === 0 ? 0 : unrelatedTopic[0].score) < sameTopic[0].score,
            'tema completamente diferente (bitcoin) pontua bem abaixo do mesmo tema (redes) — não generaliza demais'
        );
    }

    // ══════════ Caso I — objetivo curto/ambíguo ══════════
    console.log('\n=== S23.I — Objetivo curto/ambíguo ("corrija isso") → não gera confiança artificial ===');
    {
        const cm = freshCaseMemory(vocab);
        cm.captureIfEligible(makeGoal('Gerar relatorio em PDF', { currentPlan: plan('exec_command') }));
        await flush();
        const candidates = await cm.findRelevantCasesShadow('corrija isso');
        assert(Array.isArray(candidates), 'objetivo ambíguo não causa erro/exceção — retorna array (vazio ou não), nunca lança');
        assert(
            candidates.length === 0 || candidates[0].score < 0.5,
            `objetivo sem conteúdo léxico compartilhado não produz score alto artificial (obtido: ${candidates.length ? candidates[0].score.toFixed(3) : 'nenhum candidato'})`
        );
    }

    // ══════════ Caso J — PT-BR, formulação diferente (mesma limitação de C — via cluster fake) ══════════
    console.log('\n=== S23.J — PT-BR com formulação bem diferente, mesmos conceitos → mecanismo de recuperação funciona corretamente sobre o vetor recebido ===');
    {
        const cm = freshCaseMemory(vocab);
        cm.captureIfEligible(makeGoal('Gere um resumo das noticias de hoje sobre criptomoedas', { currentPlan: plan('web_search', 'write') }));
        await flush();
        const candidates = await cm.findRelevantCasesShadow('Compile uma sintese das ultimas noticias de criptomoeda');
        assert(candidates.length === 1 && candidates[0].score > 0.5, `formulação bem diferente, mesmos conceitos (resumo~sintese, noticias, criptomoeda) → recuperado (obtido: ${candidates[0]?.score.toFixed(3) ?? 'nenhum'})`);
    }
    console.log('  ℹ️  NOTA (C/H/J): a generalização de sinônimo acima vem de um cluster FAKE hand-crafted para este teste — prova que a LÓGICA de recuperação usa corretamente o vetor recebido. NÃO prova a qualidade real do modelo nomic-embed-text via Ollama (isso exige o servidor real rodando — fora do escopo desta Sprint, mesma limitação já declarada em "dados reais insuficientes").');

    // ══════════ Tabela old vs new (síntese) ══════════
    console.log('\n=== S23.TABELA — old (fingerprint) vs new (problem-similarity) ===');
    console.log('  A (mesmo objetivo, plano dif.):     old=NÃO encontra  | new=ENCONTRA');
    console.log('  B (objetivo dif., mesmo pipeline):  old=FALSO POSITIVO| new=NÃO relaciona');
    console.log('  C (sinônimos, mesma intenção):      old=N/A (não usa objetivo) | new=ENCONTRA (com fake sinônimo)');
    console.log('  D (recovery):                       old=preserva estratégia final | new=preserva + ainda acha por problema');
    console.log('  E (ordem de tools):                 old=diferencia (correto p/ estratégia) | new=indiferente (correto p/ problema)');
    console.log('  F/G/H (overlap léxico parcial):     new=score parcial, SEM threshold/confiança declarada (risco residual documentado)');
    console.log('  I (objetivo ambíguo):                new=não crasha, não afirma confiança artificial');

    // ══════════ RFC-002 (24/07): findApplicableCasesShadow ativado em GoalPlanner.plan() ══════════
    // Este bloco originalmente provava "zero influência" (modo sombra). RFC-002 ativou de
    // propósito a dimensão de similaridade de problema — ver docs/RFC-002_ATIVACAO_CASEMEMORY.md.
    // Assertions atualizadas para provar a NOVA garantia: a consulta saiu de GoalExecutionLoop
    // (fire-and-forget, removida) e passou para dentro de GoalPlanner.plan() (awaited, real).
    console.log('\n=== S23.RFC-002 — findApplicableCasesShadow agora consultado de verdade dentro de GoalPlanner.plan() ===');
    assert(plannerSrc.includes('CaseMemory') && plannerSrc.includes('buildCaseEvidenceHint'), 'GoalPlanner.ts referencia CaseMemory via buildCaseEvidenceHint (RFC-002)');
    assert(!riskSrc.includes('CaseMemory'), 'RiskAnalyzer.ts continua sem qualquer referência a CaseMemory — RFC-002 não estendeu a ativação até ali');
    assert(
        !/void this\.caseMemory\.findApplicableCasesShadow\(goal\.objective\)\.catch/.test(gelSrc),
        'GoalExecutionLoop NÃO chama mais findApplicableCasesShadow fire-and-forget — call site removido (RFC-002), substituído pela consulta real em GoalPlanner.plan()'
    );
    assert(caseMemorySrc.includes('async buildCaseEvidenceHint('), 'CaseMemory.ts expõe buildCaseEvidenceHint() — Evidence Provider que encapsula findApplicableCasesShadow para o novo consumidor real');

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S23 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    if (failed > 0) process.exit(1);
}

main().catch(err => { console.error('ERRO NÃO TRATADO:', err); process.exit(1); });
