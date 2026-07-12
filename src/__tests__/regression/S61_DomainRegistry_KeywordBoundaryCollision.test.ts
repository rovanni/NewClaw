/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S61
 * Achado durante uma pergunta aberta do usuário ("tem mais algum regex dando problema?"),
 * DEPOIS do fix estrutural de [[project_session_bugs_jul2026_ai]] (parte 2). Rodei
 * classifyDomain() (DomainRegistry.ts) com frases comuns do dia a dia, sem relação nenhuma com
 * os domínios detectados, e confirmei substring collision — a MESMA classe de bug já corrigida
 * uma vez para "amo"/"namorado" (S42), mas o fix anterior tinha escopo estrito só à palavra
 * "amo" ("as demais keywords... permanecem exatamente como estavam, sem boundary" — comentário
 * original do S42), deixando ~140 outras keywords do registro com o mesmo mecanismo frágil.
 *
 * Evidência real (função de produção, não hipotética):
 *   "Eles ficaram muito felizes com a notícia."  → domain_infra (0.57) — keyword "ram" (RAM de
 *     memória) casa como substring de QUALQUER verbo conjugado no pretérito "eles/elas"
 *     (ficaram, moraram, chegaram, estudaram...) — provavelmente o pior caso: praticamente
 *     qualquer frase sobre um grupo de pessoas no passado.
 *   "Preciso resolver esse problema no sistema hoje." → domain_clima (0.69) — keyword "sol"
 *     casa dentro de "resolver"/"resolução"/"solução".
 *   "Essa receita tem poucas calorias." → domain_clima (0.69) — keyword "calor" casa dentro de
 *     "calorias".
 *
 * Fix: shared/keywordBoundary.ts (novo) generaliza o boundary consciente de português que já
 * existia, mas vivia isolado, em UnifiedIntentRouter.ts — com UMA adição: `allowPluralS` (default
 * true), porque a maioria das keywords de DomainRegistry é um substantivo SINGULAR usado como
 * stem, contando com `.includes()` pra também casar o plural regular ("aula" em "aulas",
 * "projeto" em "projetos") — um boundary estrito nos dois lados (como o de
 * UnifiedIntentRouter, que não precisa dessa exceção pra suas próprias keywords) quebraria esse
 * casamento. DomainRegistry.classifyDomain() agora usa keywordBoundaryMatches() (com
 * allowPluralS) pra keywords ≤6 chars; keywords mais longas continuam com `.includes()` puro
 * (risco de colisão desprezível, e preserva casamento com plurais IRREGULARES tipo
 * "servidor"→"servidores", que adiciona "es" não só "s"). UnifiedIntentRouter.ts foi refatorado
 * pra consumir o MESMO helper com `allowPluralS: false` — comportamento 100% preservado
 * (verificado por equivalência direta das 2 regex inline antigas antes de trocar; suíte S25/
 * S53/S56, que exercitam UnifiedIntentRouter, continuam passando sem nenhuma alteração).
 *
 * A keyword "amo" (S42) não precisou de tratamento especial nesta rodada — o mecanismo geral
 * (comprimento 3, ≤6) já cobre o mesmo caso; o ternário hardcoded `keyword === 'amo' ? ... :
 * ...` que existia em DomainRegistry.ts foi removido, substituído pelo mecanismo geral (S42
 * continua 46/46 sem nenhuma modificação nas suas asserções).
 *
 * Escopo tocado: shared/keywordBoundary.ts (novo), memory/DomainRegistry.ts,
 * loop/UnifiedIntentRouter.ts (só consolidação, sem mudança de comportamento).
 * memory_write.ts (inferRelation, mecanismo INDEPENDENTE que também tem "gosto"/"favorit" como
 * stem) NÃO foi tocado — S42 já documentou esse casamento como preservado/fora de escopo
 * deliberadamente (ver S42-6).
 *
 * Execução: npx ts-node src/__tests__/regression/S61_DomainRegistry_KeywordBoundaryCollision.test.ts
 */

import { classifyDomain } from '../../memory/DomainRegistry';
import { keywordBoundaryMatches } from '../../shared/keywordBoundary';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

async function main(): Promise<void> {

console.log('\n=== S61-1 — as 3 frases reais do achado NÃO colidem mais com o domínio errado ===');
{
    assert(classifyDomain('Eles ficaram muito felizes com a notícia.')?.domainId !== 'domain_infra', '"ficaram" não ativa mais domain_infra via "ram"', classifyDomain('Eles ficaram muito felizes com a notícia.'));
    assert(classifyDomain('Meus pais moraram em São Paulo por muitos anos.')?.domainId !== 'domain_infra', '"moraram" não ativa mais domain_infra via "ram"', classifyDomain('Meus pais moraram em São Paulo por muitos anos.'));
    assert(classifyDomain('Meus amigos chegaram atrasados na festa.')?.domainId !== 'domain_infra', '"chegaram" não ativa mais domain_infra via "ram"', classifyDomain('Meus amigos chegaram atrasados na festa.'));
    assert(classifyDomain('Preciso resolver esse problema no sistema hoje.')?.domainId !== 'domain_clima', '"resolver" não ativa mais domain_clima via "sol"', classifyDomain('Preciso resolver esse problema no sistema hoje.'));
    assert(classifyDomain('Encontrei a solução para o problema.')?.domainId !== 'domain_clima', '"solução" não ativa mais domain_clima via "sol"', classifyDomain('Encontrei a solução para o problema.'));
    assert(classifyDomain('Essa receita tem poucas calorias.')?.domainId !== 'domain_clima', '"calorias" não ativa mais domain_clima via "calor"', classifyDomain('Essa receita tem poucas calorias.'));
}

console.log('\n=== S61-2 — controles: outras colisões de curto-alcance previstas pela mesma classe ===');
{
    assert(classifyDomain('Apertei o botão errado.')?.domainId !== 'domain_projetos', '"botão" não ativa mais domain_projetos via "bot"', classifyDomain('Apertei o botão errado.'));
    assert(classifyDomain('Vou para a capital do estado amanhã.')?.domainId !== 'domain_projetos', '"capital" não ativa mais domain_projetos via "api"', classifyDomain('Vou para a capital do estado amanhã.'));
    assert(classifyDomain('Esse bolo ficou muito gostoso.')?.domainId !== 'domain_preferencias', '"gostoso" não ativa mais domain_preferencias via "gosto" (classifyDomain especificamente — inferRelation em memory_write.ts preserva esse casamento por design, ver S42-6)', classifyDomain('Esse bolo ficou muito gostoso.'));
}

console.log('\n=== S61-3 — usos LEGÍTIMOS das mesmas keywords curtas continuam funcionando (sem falso-negativo) ===');
{
    assert(classifyDomain('A memória RAM do servidor está cheia.')?.domainId === 'domain_infra', '"RAM" isolada continua ativando domain_infra', classifyDomain('A memória RAM do servidor está cheia.'));
    assert(classifyDomain('Vou tomar sol na praia amanhã.')?.domainId === 'domain_clima', '"sol" isolado continua ativando domain_clima', classifyDomain('Vou tomar sol na praia amanhã.'));
    assert(classifyDomain('Meu namorado mora em Londrina.')?.domainId === 'domain_social', '"namorado" (S42) continua funcionando após a generalização', classifyDomain('Meu namorado mora em Londrina.'));
}

console.log('\n=== S61-4 — plural REGULAR das keywords curtas continua casando (sem quebrar DomainRegistry) ===');
{
    assert(classifyDomain('Tenho aulas de matemática hoje.')?.domainId === 'domain_docencia', '"aulas" (plural de "aula") continua ativando domain_docencia', classifyDomain('Tenho aulas de matemática hoje.'));
    assert(classifyDomain('Os projetos estão indo bem.')?.domainId === 'domain_projetos', '"projetos" continua funcionando (keyword >6 chars, .includes() inalterado)', classifyDomain('Os projetos estão indo bem.'));
    assert(classifyDomain('Meus alunos são muito dedicados.')?.domainId === 'domain_docencia', '"alunos" (plural de "aluno", keyword curta) continua ativando domain_docencia', classifyDomain('Meus alunos são muito dedicados.'));
}

console.log('\n=== S61-5 — keywords LONGAS (7+ chars) continuam com .includes() puro, incluindo plural irregular ===');
{
    assert(classifyDomain('Configurei três servidores novos ontem.')?.domainId === 'domain_infra', '"servidores" (plural irregular de "servidor", 8 chars — fora do escopo do fix) continua ativando domain_infra', classifyDomain('Configurei três servidores novos ontem.'));
}

console.log('\n=== S61-6 — shared/keywordBoundary.ts: unidade isolada (allowPluralS true/false) ===');
{
    assert(keywordBoundaryMatches('eles ficaram por lá', 'ram') === false, 'keywordBoundaryMatches rejeita "ram" dentro de "ficaram" (allowPluralS default)');
    assert(keywordBoundaryMatches('a memória ram está cheia', 'ram') === true, 'keywordBoundaryMatches aceita "ram" isolado');
    assert(keywordBoundaryMatches('tenho aulas hoje', 'aula') === true, 'keywordBoundaryMatches aceita plural regular "aulas" (allowPluralS default true)');
    assert(keywordBoundaryMatches('esse bolo ficou gostoso', 'gosto') === false, 'keywordBoundaryMatches rejeita "gosto" dentro de "gostoso" mesmo com allowPluralS (não é "gosto"+s+fim)');
    assert(keywordBoundaryMatches('tenho aulas hoje', 'aula', { allowPluralS: false }) === false, 'allowPluralS:false rejeita o plural "aulas" (modo estrito, usado por UnifiedIntentRouter)');
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S61 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;

}

main().catch((err) => {
    console.error('S61 erro inesperado:', err);
    process.exitCode = 1;
});
