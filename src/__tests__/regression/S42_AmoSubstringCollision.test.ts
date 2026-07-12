/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S42 (regressão LOCAL do workspace, não versionada — política já
 * reafirmada pelo mantenedor sobre src/__tests__/)
 *
 * Achado durante auditoria arquitetural do fluxo semântico de memory_write.ts: a keyword
 * "amo" (verbo "amar", legítima em domain_preferencias/DomainRegistry.ts e no branch
 * has_spouse... na verdade branch 'prefers' de inferRelation, memory_write.ts) casa como
 * SUBSTRING ACIDENTAL dentro de "namorado"/"namorada"/"namorados"/"namoradas" — palavras
 * naturais e comuns, nada relacionadas ao verbo "amar" nessa posição (n-AMO-rado).
 *
 * DOIS mecanismos independentes afetados, causas raiz DIFERENTES (não compartilham código,
 * não nasceram no mesmo commit):
 *
 *   1. DomainRegistry.classifyDomain() — "amo" introduzido em domain_preferencias no commit
 *      0b1d8ed (17/05/2026), MESMO commit que introduziu "namorado"/"namorada" em
 *      domain_social — colisão interna ao próprio commit, nunca testada.
 *      Mecanismo: keyword scoring via `.includes()` (substring), sem boundary nenhum.
 *
 *   2. memory_write.inferRelation() branch 'fact' — "amo" introduzido no commit a958397
 *      (29/04/2026), como sinônimo legítimo de "prefiro/gosto" para detectar preferências
 *      ("eu amo café"). Nesse momento "namorado" não existia em NENHUM léxico do sistema —
 *      a colisão é inteiramente emergente/acidental, meses depois, sem relação com a origem
 *      de "amo". Mecanismo: regex `.match()` sem boundary nenhum.
 *
 * Reproduzido (funções reais): "meu namorado mora em Londrina" →
 *   classifyDomain: domain_preferencias, confidence=0.6455 (deveria ser domain_social, 0.6063)
 *   inferRelation('fact', '', ...): 'prefers' (deveria cair no fallback genérico 'has_trait')
 *
 * Impacto real demonstrado (não apenas plausível) — reconstrução de consumidores reais:
 *   - memory_write.create() (linha ~212-224): confidence 0.6455 < 0.65 → NÃO roteia via domain
 *     hub (o resultado errado de classifyDomain é descartado nesse ponto específico), mas CAI
 *     no fallback de inferRelation(), que tem SEU PRÓPRIO bug independente e retorna 'prefers'
 *     — a edge final criada (user_identity --prefers--> node) é diretamente incorreta.
 *   - MemoryManager.addNode() (linha 326-329, mesmo threshold 0.65): mesmo efeito nulo nesse
 *     ponto específico para esta confidence exata.
 *   - MemoryManager.ts:174-176 (DomainBackfill, threshold >= 0.55): 0.6455 >= 0.55 → DISPARA,
 *     persistindo domain_preferencias (errado) na coluna domain do nó.
 *   - ContextBuilder.ts:716,727 (buildContext, threshold >= 0.3) e :968-969
 *     (domainAwareRankAndSelect, threshold >= 0.5): ambos DISPARAM (0.6455 excede os dois),
 *     injetando o resumo de domínio ERRADO no prompt e filtrando retrieval pelo hub ERRADO.
 *   - CMIBuffer.ts:130,164 (chunking conversacional): SEM threshold nenhum, sempre usa o
 *     domainId retornado — decisões de corte de chunk por "domain shift" ficam erradas.
 *   - CMIIngestionPipeline.ts:148-149: SEM threshold, sempre adiciona o domainId errado como
 *     tópico de metadata do chunk ingerido.
 *
 * Testada a hipótese de boundary Unicode/acento: não se aplica — "amo" é 100% ASCII em
 * ambas as bordas, sem nenhum caractere acentuado envolvido (diferente da série anterior
 * de bugs \b+acento em PromptComposer.ts/memory_write.ts).
 *
 * Correção mínima, escopo estrito a "amo" apenas — as demais keywords/alternativas
 * (prefiro/gosto/adoro/favorit em ambos os mecanismos, e as 100+ outras keywords de
 * DOMAIN_DEFINITIONS) permanecem exatamente como estavam, sem boundary, comportamento
 * preservado (confirmado empiricamente contra toda a matriz antes de aplicar):
 *   - DomainRegistry.ts: dentro do loop de scoring, "amo" agora usa /\bamo\b/.test(normalized)
 *     em vez de normalized.includes(keyword); as demais keywords continuam com .includes().
 *   - memory_write.ts inferRelation(): "amo" isolado com \b...\b dentro da alternação
 *     (/prefiro|gosto|adoro|\bamo\b|favorit/i); prefiro/gosto/adoro/favorit inalterados.
 *
 * Achados relacionados, DELIBERADAMENTE NÃO corrigidos nesta rodada (causas/mecanismos
 * diferentes, fora do escopo estrito desta auditoria):
 *   - "favorit" continua sendo um stem que não fecha contra "favorito"/"favorita" (mesma
 *     classe do "namorad"/"casad" já documentados, mas não corrigidos, em rodada anterior).
 *   - "ramo" colide com a keyword "ram" (RAM) de domain_infra — substring acidental
 *     DIFERENTE, não relacionada a "amo", não tocada aqui.
 *   - O algoritmo de scoring (score = hits/sqrt(keywords.length)) inerentemente favorece
 *     domínios com listas de keywords menores para hits únicos (ex: "professor" sozinho
 *     vence "namorado" sozinho, independente do bug de "amo") — característica estrutural
 *     do algoritmo, não uma falha introduzida ou corrigida por este patch.
 *
 * Execução: npx ts-node src/__tests__/regression/S42_AmoSubstringCollision.test.ts
 */

import { classifyDomain } from '../../memory/DomainRegistry';
import { MemoryWriteTool } from '../../tools/memory_write';
import type { MemoryManager } from '../../memory/MemoryManager';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

const fakeMemoryManager = { getFacade: () => ({}) } as unknown as MemoryManager;
const tool = new MemoryWriteTool(fakeMemoryManager) as unknown as {
    inferRelation(type: string, name: string, content: string): string;
};

async function main(): Promise<void> {

// ── 1: texto exato do achado ──

console.log('\n=== S42-1 — "meu namorado mora em Londrina" não colide mais com "amo" ===');
{
    const dom = classifyDomain('meu namorado mora em Londrina');
    assert(dom?.domainId === 'domain_social', 'classifyDomain retorna domain_social (não domain_preferencias)', dom);
    const rel = tool.inferRelation('fact', '', 'meu namorado mora em Londrina');
    assert(rel !== 'prefers', 'inferRelation NÃO retorna "prefers" para fato sobre namoro', rel);
}

// ── 2: positivos legítimos de preferência preservados (sem regressão) ──

console.log('\n=== S42-2 — preferências legítimas continuam reconhecidas (sem regressão) ===');
{
    const positives = ['eu amo café', 'amo programação', 'eu gosto de Linux', 'adoro música', 'prefiro chá', 'meu favorito é café'];
    for (const p of positives) {
        const dom = classifyDomain(p);
        assert(dom?.domainId === 'domain_preferencias', `classifyDomain("${p}") continua domain_preferencias`, dom);
        assert(tool.inferRelation('fact', '', p) === 'prefers', `inferRelation("${p}") continua 'prefers'`, tool.inferRelation('fact', '', p));
    }
}

// ── 3: negativos relacionais — substring acidental corrigida ──

console.log('\n=== S42-3 — substring acidental de "amo" em namorado/namorada/plurais corrigida ===');
{
    const negatives = ['namorado', 'namorada', 'namorados', 'namoradas', 'meu namorado', 'minha namorada', 'meus namorados moram longe', 'minhas namoradas estudam aqui'];
    for (const n of negatives) {
        const dom = classifyDomain(n);
        assert(dom?.domainId !== 'domain_preferencias', `classifyDomain("${n}") NÃO é mais domain_preferencias`, dom);
        assert(tool.inferRelation('fact', '', n) !== 'prefers', `inferRelation("${n}") NÃO retorna mais 'prefers'`, tool.inferRelation('fact', '', n));
    }
}

// ── 4: casos ambíguos — "amo" explícito + namorado/namorada continua reconhecido ──

console.log('\n=== S42-4 — casos ambíguos ("amo" real + namorado) continuam reconhecendo a preferência ===');
{
    const ambiguous = ['eu amo meu namorado', 'amo minha namorada', 'eu amo a companhia do meu namorado'];
    for (const a of ambiguous) {
        assert(classifyDomain(a)?.domainId === 'domain_preferencias', `classifyDomain("${a}") reconhece "amo" real`, classifyDomain(a));
        assert(tool.inferRelation('fact', '', a) === 'prefers', `inferRelation("${a}") reconhece "amo" real`, tool.inferRelation('fact', '', a));
    }
}

// ── 5: controles de substring — outras palavras com "amo" interno não relacionadas ──

console.log('\n=== S42-5 — controles de substring (amostra/amoroso/amortecedor/reclamou) não casam mais "amo" ===');
{
    const controls = ['amostra', 'amortecedor', 'reclamou', 'amoedo'];
    for (const c of controls) {
        assert(classifyDomain(c)?.domainId !== 'domain_preferencias', `classifyDomain("${c}") NÃO ativa domain_preferencias via "amo"`, classifyDomain(c));
        assert(tool.inferRelation('fact', '', c) !== 'prefers', `inferRelation("${c}") NÃO retorna 'prefers' via "amo"`, tool.inferRelation('fact', '', c));
    }
}

// ── 6: demais keywords do léxico (prefiro/gosto/adoro/favorit) preservadas sem alteração ──

console.log('\n=== S42-6 — prefiro/gosto/adoro/favorit continuam com o mesmo comportamento de antes ===');
{
    assert(tool.inferRelation('fact', '', 'gostoso') === 'prefers', '"gostoso" continua casando via "gosto" (stem preservado, fora de escopo)', tool.inferRelation('fact', '', 'gostoso'));
    assert(tool.inferRelation('fact', '', 'favorita') === 'prefers', '"favorita" continua casando via stem "favorit" (fora de escopo, preservado)', tool.inferRelation('fact', '', 'favorita'));
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S42 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;

}

main().catch((err) => {
    console.error('S42 erro inesperado:', err);
    process.exitCode = 1;
});
