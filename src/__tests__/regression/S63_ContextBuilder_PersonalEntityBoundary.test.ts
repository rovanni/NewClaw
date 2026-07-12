/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S63
 * Continuação da auditoria geral de regex ([[project_session_bugs_jul2026_ai]], parte 3+).
 * `ContextBuilder.PERSONAL_ENTITY_TERMS` (usado por `isPersonalMemoryQuery()` — decide se
 * upgrade o tier de contexto de 'minimal' pra 'normal' — e por `extractEntities()`) tinha a
 * MESMA classe de colisão de substring já corrigida em DomainRegistry.ts/ModelProfileRegistry.ts
 * nesta sessão.
 *
 * Evidência real (função de produção): "Toquei a campainha da casa nova." → `true` (deveria ser
 * `false`) porque o termo "pai" casa como substring de "campainha". "Eu sentia muita saudade
 * daquele lugar." e "Ele mentia sobre tudo." → `true` porque o termo "tia" casa dentro de
 * QUALQUER verbo terminado em "-tia" no pretérito imperfeito (sentia, mentia, repetia,
 * competia, permitia...) — uma conjugação verbal extremamente comum em português.
 *
 * Impacto real: baixo (ao contrário de DomainRegistry) — um falso positivo aqui só faz
 * `buildContext()` usar tier 'normal' em vez de 'minimal' (mais nós de memória, mais chars),
 * nunca uma classificação incorreta que vaza pro usuário. Corrigido mesmo assim, pela mesma
 * razão dos outros 2 fixes desta parte: mesma causa raiz, fix já pronto e barato de aplicar.
 *
 * Fix: `matchesPersonalTerm()` (novo, local a ContextBuilder.ts) usa `keywordBoundaryMatches()`
 * com `allowPluralS: false` pra termos ≤6 chars — estrito, não leniente com plural, porque esta
 * lista já enumera EXPLICITAMENTE as formas plurais como entradas separadas ('filho'/'filhos',
 * 'irmao'/'irmaos', 'hijo'/'hijos'...), diferente de DomainRegistry (que depende de substring
 * pra pegar plural, por isso usa `allowPluralS: true` lá).
 *
 * Escopo tocado: loop/ContextBuilder.ts (extractEntities, isPersonalMemoryQuery).
 *
 * Execução: npx ts-node src/__tests__/regression/S63_ContextBuilder_PersonalEntityBoundary.test.ts
 */

process.env.WORKSPACE_DIR = process.env.WORKSPACE_DIR || 'D:/IA/newclaw/workspace';

import { isPersonalMemoryQuery, extractEntities } from '../../loop/ContextBuilder';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

async function main(): Promise<void> {

console.log('\n=== S63-1 — colisões reais confirmadas: NÃO ativam mais isPersonalMemoryQuery ===');
{
    assert(isPersonalMemoryQuery('Toquei a campainha da casa nova.') === false, '"campainha" não ativa mais via "pai"', isPersonalMemoryQuery('Toquei a campainha da casa nova.'));
    assert(isPersonalMemoryQuery('Eu sentia muita saudade daquele lugar.') === false, '"sentia" não ativa mais via "tia"', isPersonalMemoryQuery('Eu sentia muita saudade daquele lugar.'));
    assert(isPersonalMemoryQuery('Ele mentia sobre tudo.') === false, '"mentia" não ativa mais via "tia"', isPersonalMemoryQuery('Ele mentia sobre tudo.'));
    assert(isPersonalMemoryQuery('Ela repetia sempre a mesma história.') === false, '"repetia" não ativa mais via "tia"', isPersonalMemoryQuery('Ela repetia sempre a mesma história.'));
}

console.log('\n=== S63-2 — usos LEGÍTIMOS continuam ativando (sem falso-negativo) ===');
{
    assert(isPersonalMemoryQuery('Meu pai mora em outra cidade.') === true, '"pai" isolado continua ativando', isPersonalMemoryQuery('Meu pai mora em outra cidade.'));
    assert(isPersonalMemoryQuery('Minha tia vem me visitar amanhã.') === true, '"tia" isolado continua ativando', isPersonalMemoryQuery('Minha tia vem me visitar amanhã.'));
    assert(isPersonalMemoryQuery('Meus filhos estão na escola.') === true, '"filhos" (plural já enumerado explicitamente) continua ativando', isPersonalMemoryQuery('Meus filhos estão na escola.'));
    assert(isPersonalMemoryQuery('Qual é o nome da minha esposa?') === true, '"esposa" continua ativando', isPersonalMemoryQuery('Qual é o nome da minha esposa?'));
}

console.log('\n=== S63-3 — extractEntities: mesma correção aplicada, sem regressão ===');
{
    assert(!extractEntities('Toquei a campainha da casa nova.').includes('pai'), 'extractEntities não extrai "pai" de "campainha"', extractEntities('Toquei a campainha da casa nova.'));
    assert(extractEntities('Meu pai mora em outra cidade.').includes('pai'), 'extractEntities ainda extrai "pai" quando genuíno', extractEntities('Meu pai mora em outra cidade.'));
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S63 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;

}

main().catch((err) => {
    console.error('S63 erro inesperado:', err);
    process.exitCode = 1;
});
