/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S46
 * Investigação de log real (05/07/2026, 14:29-14:31, Telegram, goal_1783272571191_4y62y):
 * usuário pediu análise de cripto com áudio e recebeu um áudio incompreensível: "Analis e
 * completa das criptomoedas solicitadas... Os preços e variações coletados nas etapas
 * anteriores devem ser inseridos aqui para na ração."
 *
 * Essa frase é a MESMA classe de bug já documentada e corrigida antes (RiskAnalyzer/Q2
 * reescrevendo um step de send_audio.text com prosa que descreve o processo em vez de conter
 * os dados reais — ver histórico em contentStubPatterns.ts, incidentes de 04/07/2026), mas com
 * vocabulário novo que escapou de TODOS os padrões existentes:
 *   - "etapas anteriores" em vez de "step_N"/"step N" (só o inglês "step" era coberto)
 *   - modal "devem ser" + verbo "inseridos" em vez de "será/vai ser" + "gerado/criado/produzido"
 *
 * Correção: dois padrões novos em CONTENT_STUB_PATTERNS (shared/contentStubPatterns.ts, fonte
 * única usada por sanitizePlanSteps/GoalPlanner/RiskAnalyzer/WriteTool) cobrindo (1) referência
 * a "etapa(s)/passo(s)/fase(s) anterior(es)" em prosa livre — mesmo princípio já usado pra
 * "step_N" (referência a mecânica interna do pipeline é sempre sinal de stub) — e (2) o par
 * modal "deve(m) ser" + verbos de inserção (inserido/preenchido/adicionado/colocado).
 *
 * Escopo tocado: shared/contentStubPatterns.ts (nenhuma tool alterada).
 *
 * Execução: npx ts-node src/__tests__/regression/S46_ContentStub_PreviousStepsPortuguese.test.ts
 */

import { CONTENT_STUB_PATTERNS } from '../../shared/contentStubPatterns';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

async function main(): Promise<void> {

console.log('\n=== S46-1 — texto EXATO do incidente real é detectado como content-stub ===');
{
    const realIncidentText = 'Análise completa das criptomoedas solicitadas, Bitcoin, Ethereum, Dogecoin, Pi Network e River. Os preços e variações coletados nas etapas anteriores devem ser inseridos aqui para narração.';
    const matched = CONTENT_STUB_PATTERNS.some(p => p.test(realIncidentText));
    assert(matched, 'texto real do áudio incompreensível do incidente é detectado', realIncidentText);
}

console.log('\n=== S46-2 — cada padrão novo isoladamente cobre variações do mesmo problema ===');
{
    const variantsEtapas = [
        'os dados coletados nas etapas anteriores',
        'conforme apurado no passo anterior',
        'de acordo com a fase anterior do processo',
    ];
    for (const v of variantsEtapas) {
        assert(CONTENT_STUB_PATTERNS.some(p => p.test(v)), `referência a etapa/passo/fase anterior é detectada: "${v}"`);
    }

    const variantsInserir = [
        'os valores devem ser inseridos aqui',
        'o preço deve ser preenchido posteriormente',
        'a variação deve ser adicionada neste ponto',
        'o resultado deve ser colocado aqui',
    ];
    for (const v of variantsInserir) {
        assert(CONTENT_STUB_PATTERNS.some(p => p.test(v)), `modal "deve(m) ser" + verbo de inserção é detectado: "${v}"`);
    }
}

console.log('\n=== S46-3 — conteúdo real e legítimo (sem menção a etapas/inserção) NÃO é falsamente sinalizado ===');
{
    const legitimateTexts = [
        'Bitcoin está cotado a 65 mil dólares, com alta de 2% nas últimas 24 horas.',
        'A previsão do tempo para amanhã é de céu limpo, com máxima de 28 graus.',
        'Ethereum apresenta variação de 1,7% em 24 horas, cotado a 1769 dólares.',
        'River está na posição 321 do ranking de market cap, com preço de 9 dólares e 29 centavos.',
    ];
    for (const text of legitimateTexts) {
        assert(!CONTENT_STUB_PATTERNS.some(p => p.test(text)), `conteúdo legítimo NÃO é falsamente sinalizado: "${text}"`);
    }
}

console.log('\n=== S46-4 — padrões pré-existentes continuam funcionando (sem regressão) ===');
{
    assert(CONTENT_STUB_PATTERNS.some(p => p.test('Baseado nos dados obtidos no step_1, a previsão é...')), 'padrão antigo step_1 (underscore) continua detectado');
    assert(CONTENT_STUB_PATTERNS.some(p => p.test('conforme apurado no step 1 anterior')), 'padrão antigo "step 1" (espaço) continua detectado');
    assert(CONTENT_STUB_PATTERNS.some(p => p.test('conteúdo será gerado em um time com base nos dados de memória recuperados')), 'padrão antigo "será gerado" (sem colchetes) continua detectado');
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S46 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;

}

main().catch((err) => {
    console.error('S46 erro inesperado:', err);
    process.exitCode = 1;
});
