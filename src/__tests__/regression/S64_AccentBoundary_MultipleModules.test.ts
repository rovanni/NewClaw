/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S64
 * Continuação da auditoria geral de regex ([[project_session_bugs_jul2026_ai]], parte 5),
 * mudando de ângulo: em vez de colisão de substring (classes já corrigidas nas partes 3-4),
 * procurei o bug de "\b" (JS, sem flag "u") não reconhecer letras acentuadas como \w — bug já
 * documentado e corrigido pontualmente em PromptComposer.ts/memory_write.ts/
 * contentStubPatterns.ts em sessões anteriores, mas nunca varrido sistematicamente no resto do
 * código. Achados reais, verificados rodando as funções/regex de produção:
 *
 * 1. **GoalExtractor.ts (NOT_GOAL_SIGNALS, 6 regex)**: "\b" final logo após alternativas
 *    terminadas em vogal acentuada ("olá", "aí", "você", "é") nunca fechava quando seguida de
 *    espaço/pontuação/fim de string (o caso comum). Confirmado: um "Olá" sozinho, "O que é
 *    isso?", "Na verdade é isso", "Quem é você?" (sem "?") e "sim, é" NÃO eram reconhecidos
 *    pela heurística determinística (zero latência) — caíam pro estágio 2 (classificação via
 *    LLM), perdendo o fast-path para mensagens conversacionais extremamente comuns. Fix: "\b"
 *    final trocado por "(?!\w)" (mesmo padrão já usado em memory_write.ts).
 *
 * 2. **AgentLoop.ts (VOLATILE_QUERY_PATTERN)**: bug DIFERENTE — faltavam parênteses ao redor
 *    da alternação inteira. "\bprice|X|Y|coin\b" só aplica "\b" na PRIMEIRA e na ÚLTIMA
 *    alternativa (precedência de "|"); todas as alternativas do meio (clima, notícia, dólar,
 *    câmbio, cripto...) casavam como substring livre. Confirmado: "Precisamos nos aclimatar ao
 *    novo horário" (sem nenhuma relação com clima) era tratado como consulta volátil, via
 *    "clima" casando dentro de "aclimatar". Fix: alternativas envolvidas em parênteses.
 *
 * 3. **memory_write.ts (isFamilyOrSocialContent + inferFamilyRelation)**: bug ainda diferente
 *    — stems incompletos "namorad"/"casad" seguidos de QUALQUER boundary ("\b" ou "(?!\w)")
 *    nunca fecham, porque a letra que completa a palavra real ("o"/"a" de "namorado") É um
 *    caractere de palavra. Não é bug de acento — é usar boundary logo depois de um prefixo em
 *    vez da palavra completa. Confirmado: "Ela é minha namorada"/"Ele é meu namorado"/"Sou
 *    casado" NUNCA eram reconhecidos como conteúdo familiar/social, e inferFamilyRelation
 *    retornava o fallback genérico 'has_relation' em vez de 'has_spouse'. Fix: formas completas
 *    enumeradas (namorado/namorada/namorados/namoradas, casado/casada/casados/casadas), mesmo
 *    padrão já usado para "irmã"/plurais nesse mesmo arquivo.
 *
 * Escopo tocado: loop/GoalExtractor.ts, loop/AgentLoop.ts, tools/memory_write.ts.
 *
 * Execução: npx ts-node src/__tests__/regression/S64_AccentBoundary_MultipleModules.test.ts
 */

process.env.WORKSPACE_DIR = process.env.WORKSPACE_DIR || 'D:/IA/newclaw/workspace';

import { GoalExtractor } from '../../loop/GoalExtractor';
import { computeMemoryConfidence } from '../../loop/AgentLoop';
import { MemoryWriteTool } from '../../tools/memory_write';
import type { MemoryManager } from '../../memory/MemoryManager';
import type { ContextBuildMetadata } from '../../loop/ContextBuilder';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

const fakeProviderFactory = {} as unknown as import('../../core/ProviderFactory').ProviderFactory;
const extractor = new GoalExtractor(fakeProviderFactory) as unknown as {
    quickClassify(message: string): boolean | null;
};

const fakeMemoryManager = { getFacade: () => ({}) } as unknown as MemoryManager;
const memTool = new MemoryWriteTool(fakeMemoryManager) as unknown as {
    isFamilyOrSocialContent(name: string, content: string): boolean;
    inferFamilyRelation(content: string): string;
};

async function main(): Promise<void> {

console.log('\n=== S64-1 — GoalExtractor: mensagens conversacionais comuns voltam a ser reconhecidas (fast-path) ===');
{
    assert(extractor.quickClassify('Olá') === false, '"Olá" sozinho reconhecido como NÃO-goal', extractor.quickClassify('Olá'));
    assert(extractor.quickClassify('O que é isso?') === false, '"O que é isso?" reconhecido como NÃO-goal', extractor.quickClassify('O que é isso?'));
    assert(extractor.quickClassify('Na verdade é isso mesmo') === false, '"Na verdade é isso mesmo" reconhecido como NÃO-goal', extractor.quickClassify('Na verdade é isso mesmo'));
    assert(extractor.quickClassify('Quem é você') === false, '"Quem é você" (sem "?") reconhecido como NÃO-goal', extractor.quickClassify('Quem é você'));
    assert(extractor.quickClassify('sim, é') === false, '"sim, é" reconhecido como NÃO-goal', extractor.quickClassify('sim, é'));
}

console.log('\n=== S64-2 — AgentLoop: VOLATILE_QUERY_PATTERN não colide mais com "aclimatar" ===');
{
    const meta = (selectedCount: number): ContextBuildMetadata => ({
        memoryUsed: true, selectedCount, hasEntityMatch: true, hasHighRelevancePreference: false,
    } as unknown as ContextBuildMetadata);

    assert(computeMemoryConfidence(meta(1), 'Precisamos nos aclimatar ao novo horário.') !== 'low', '"aclimatar" não ativa mais volatilidade via "clima"', computeMemoryConfidence(meta(1), 'Precisamos nos aclimatar ao novo horário.'));
    assert(computeMemoryConfidence(meta(1), 'Qual o preço do bitcoin agora?') === 'low', 'consulta de preço genuína continua marcada como volátil', computeMemoryConfidence(meta(1), 'Qual o preço do bitcoin agora?'));
}

console.log('\n=== S64-3 — memory_write.ts: namorado/namorada/casado reconhecidos corretamente ===');
{
    assert(memTool.isFamilyOrSocialContent('', 'Ela é minha namorada') === true, '"namorada" reconhecida como conteúdo familiar/social', memTool.isFamilyOrSocialContent('', 'Ela é minha namorada'));
    assert(memTool.isFamilyOrSocialContent('', 'Ele é meu namorado') === true, '"namorado" reconhecido como conteúdo familiar/social', memTool.isFamilyOrSocialContent('', 'Ele é meu namorado'));
    assert(memTool.inferFamilyRelation('Sou casado há 10 anos') === 'has_spouse', '"casado" infere has_spouse (não mais o fallback genérico has_relation)', memTool.inferFamilyRelation('Sou casado há 10 anos'));
    assert(memTool.inferFamilyRelation('Ela é minha namorada') === 'has_spouse', '"namorada" infere has_spouse', memTool.inferFamilyRelation('Ela é minha namorada'));
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S64 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;

}

main().catch((err) => {
    console.error('S64 erro inesperado:', err);
    process.exitCode = 1;
});
