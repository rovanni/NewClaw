/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S50
 * Investigação de log real (05/07/2026, 16:12, Telegram, goal_1783278739536_7u8s9): usuário
 * pediu áudio da previsão do tempo e ouviu literalmente "conteúdo gerado pelo assistente." em
 * vez da previsão real. O plano (primeira tentativa, sem replan) já tinha
 * tools=[weather,send_audio] com send_audio.text decidido no MOMENTO DO PLANEJAMENTO — antes
 * do step de weather sequer rodar — então não podia conter dados reais ainda.
 *
 * Confirmado no audit log: nenhum aviso "[SanitizePlanSteps] ... content stub detectado"
 * apareceu para este goal — ou seja, o texto passou direto por TODOS os CONTENT_STUB_PATTERNS
 * existentes sem disparar nenhum. Motivo (dois ao mesmo tempo):
 *   1. Sem colchetes e sem "será/vai ser" — é uma oração elíptica ("[substantivo] [particípio]
 *      pelo [X]"), diferente da forma "X será gerado" que os padrões anteriores exigiam.
 *   2. Usa a palavra "assistente", que não estava na lista fechada (modelo|agente|llm) dos
 *      padrões de meta-placeholder já existentes.
 *
 * Correção: novo padrão em CONTENT_STUB_PATTERNS (shared/contentStubPatterns.ts, fonte única)
 * cobrindo "gerado/produzido/criado/escrito pelo/pela assistente/modelo/agente/sistema/IA/bot",
 * independente de tempo verbal ou colchetes — mesma classe semântica de sempre (descrição de
 * quem/o-que produziu o conteúdo, em vez do conteúdo em si).
 *
 * Escopo tocado: shared/contentStubPatterns.ts (nenhuma tool alterada).
 *
 * Execução: npx ts-node src/__tests__/regression/S50_ContentStub_GeneratedByAssistant.test.ts
 */

import { CONTENT_STUB_PATTERNS } from '../../shared/contentStubPatterns';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

async function main(): Promise<void> {

console.log('\n=== S50-1 — texto EXATO do incidente real é detectado como content-stub ===');
{
    const realIncidentText = 'conteúdo gerado pelo assistente.';
    assert(CONTENT_STUB_PATTERNS.some(p => p.test(realIncidentText)), 'texto real do incidente é detectado', realIncidentText);
}

console.log('\n=== S50-2 — variações de entidade/verbo/tempo verbal são cobertas ===');
{
    const variants = [
        'texto produzido pela IA',
        'relatório criado pelo modelo',
        'resposta escrita pelo agente',
        'conteúdo gerado pelo sistema',
        'narração criada pelo bot',
        'Este texto foi gerado pelo assistente virtual', // "pelo assistente" ainda casa mesmo com prefixo extra
    ];
    for (const v of variants) {
        assert(CONTENT_STUB_PATTERNS.some(p => p.test(v)), `variação detectada: "${v}"`);
    }
}

console.log('\n=== S50-3 — conteúdo real e legítimo (sem meta-referência à origem) NÃO é falsamente sinalizado ===');
{
    const legitimateTexts = [
        'A previsão do tempo para Belo Horizonte hoje é de céu nublado, com máxima de 24 graus.',
        'Bitcoin está cotado a 65 mil dólares, com alta de 2% nas últimas 24 horas.',
        'O relatório mostra crescimento de 15% nas vendas do trimestre.',
        'Assistente social visitou a comunidade na semana passada.', // "assistente" fora do padrão específico
    ];
    for (const text of legitimateTexts) {
        assert(!CONTENT_STUB_PATTERNS.some(p => p.test(text)), `conteúdo legítimo NÃO é falsamente sinalizado: "${text}"`);
    }
}

console.log('\n=== S50-4 — padrões pré-existentes continuam funcionando (sem regressão) ===');
{
    assert(CONTENT_STUB_PATTERNS.some(p => p.test('Baseado nos dados obtidos no step_1, a previsão é...')), 'padrão antigo step_1 continua detectado');
    assert(CONTENT_STUB_PATTERNS.some(p => p.test('os dados coletados nas etapas anteriores devem ser inseridos aqui')), 'padrão de etapas anteriores (S46) continua detectado');
    assert(CONTENT_STUB_PATTERNS.some(p => p.test('conteúdo será gerado em um time com base nos dados de memória recuperados')), 'padrão antigo "será gerado" continua detectado');
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S50 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;

}

main().catch((err) => {
    console.error('S50 erro inesperado:', err);
    process.exitCode = 1;
});
