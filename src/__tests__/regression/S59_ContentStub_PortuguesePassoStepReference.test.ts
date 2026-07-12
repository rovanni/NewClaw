/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S59
 * Investigação de log real (06/07/2026, 19:52, Telegram, goal_1783378324137_lim8e): usuário
 * pediu áudio da previsão do tempo e recebeu "Previsão do tempo para amanhã em Belo Horizonte,
 * inserir dados reais obtidos no passo 1." em vez da previsão real.
 *
 * Causa: mesma classe de bug de [[project_session_bugs_jul2026_z]]/[[project_session_bugs_jul2026_aa]]
 * — RiskAnalyzer (Q2) reduziu o plano de 3 para 2 steps (removendo o step "agentloop" inválido
 * que sintetizaria a narrativa real a partir do weather) e escreveu send_audio.text diretamente,
 * ANTES do step de weather rodar. O texto resultante referenciava "o passo 1" (em português) em
 * vez de conter os dados reais.
 *
 * Confirmado no audit log: nenhum "content stub detectado" apareceu para este goal — o texto
 * escapou de TODOS os CONTENT_STUB_PATTERNS existentes porque o padrão de referência a step
 * numerado (linha "step[_\s-]?\d+") só cobria a palavra em INGLÊS. O sistema roda com
 * Language: pt-BR (confirmado no log de boot), então o LLM naturalmente usa "passo"/"etapa"/
 * "fase" em vez de "step".
 *
 * Correção: novo padrão em CONTENT_STUB_PATTERNS exigindo verbo (obtido/coletado/retornado/
 * extraído/recuperado/gerado) + preposição (no/na/nos/nas/do/da/dos/das) + step/passo/etapa/fase
 * + número — NÃO um "passo\d+"/"etapa\d+" livre, que bloquearia cabeçalhos legítimos de
 * receitas/tutoriais reais ("Passo 1: pré-aqueça o forno").
 *
 * Escopo tocado: shared/contentStubPatterns.ts (nenhuma tool alterada).
 *
 * Execução: npx ts-node src/__tests__/regression/S59_ContentStub_PortuguesePassoStepReference.test.ts
 */

import { CONTENT_STUB_PATTERNS } from '../../shared/contentStubPatterns';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

async function main(): Promise<void> {

console.log('\n=== S59-1 — texto EXATO do incidente real é detectado como content-stub ===');
{
    const realIncidentText = 'Previsão do tempo para amanhã em Belo Horizonte, inserir dados reais obtidos no passo 1.';
    assert(CONTENT_STUB_PATTERNS.some(p => p.test(realIncidentText)), 'texto real do incidente é detectado', realIncidentText);
}

console.log('\n=== S59-2 — variações de palavra (passo/etapa/fase), verbo e preposição são cobertas ===');
{
    const variants = [
        'os dados obtidos no passo 1 mostram alta de preço',
        'valores coletados na etapa 2 do processo',
        'informações retornadas no step 3',
        'preços extraídos da fase 1 da análise',
        'resultados recuperados nos passo_1 anteriores',
        'conforme os dados gerados no passo 4',
        'Dados obtidos no Passo 2:', // maiúscula, checa case-insensitive
    ];
    for (const v of variants) {
        assert(CONTENT_STUB_PATTERNS.some(p => p.test(v)), `variação detectada: "${v}"`);
    }
}

console.log('\n=== S59-3 — cabeçalhos legítimos de receita/tutorial (sem verbo de "dado-fonte") NÃO são falsamente sinalizados ===');
{
    const legitimateTexts = [
        'Passo 1: Pré-aqueça o forno a 180°C.',
        'Etapa 2: Misture os ingredientes secos em uma tigela.',
        'Fase 3 do projeto: revisão final antes da entrega.',
        'A previsão do tempo para Belo Horizonte hoje é de céu nublado, com máxima de 24 graus.',
    ];
    for (const text of legitimateTexts) {
        assert(!CONTENT_STUB_PATTERNS.some(p => p.test(text)), `conteúdo legítimo NÃO é falsamente sinalizado: "${text}"`);
    }
}

console.log('\n=== S59-4 — padrões pré-existentes continuam funcionando (sem regressão) ===');
{
    assert(CONTENT_STUB_PATTERNS.some(p => p.test('Baseado nos dados obtidos no step_1, a previsão é...')), 'padrão antigo step_1 continua detectado');
    assert(CONTENT_STUB_PATTERNS.some(p => p.test('os dados coletados nas etapas anteriores devem ser inseridos aqui')), 'padrão de etapas anteriores (S46) continua detectado');
    assert(CONTENT_STUB_PATTERNS.some(p => p.test('conteúdo gerado pelo assistente.')), 'padrão "gerado pelo assistente" (S50) continua detectado');
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S59 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;

}

main().catch((err) => {
    console.error('S59 erro inesperado:', err);
    process.exitCode = 1;
});
