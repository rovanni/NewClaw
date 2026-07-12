/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S39
 * Investigação de log real (quarta rodada, 04/07/2026 23:07-23:19, após os commits
 * f8c408c, 4b03980 e 02ed604 já terem corrigido classificação de dependência,
 * resolução do edge-tts via PATH e generalização do content-stub-gate para
 * send_audio.text): usuário pediu áudio sobre "o que você sabe sobre mim", recebeu
 * áudio real, mas o conteúdo era: "conteúdo será gerado em um time com base nos
 * dados de memória recuperados" — outro meta-placeholder, NÃO conteúdo real.
 *
 * Rastreamento no audit log confirmou: o plano inicial já tinha send_audio direto
 * (tools=[memory_search,send_audio]), então a mesma checagem de content-stub do
 * commit anterior (02ed604) já rodava sobre esse toolArgs.text — mas o texto NÃO
 * foi barrado, porque:
 *
 *   Todos os padrões de "LLM descreve o que vai gerar em vez de gerar"
 *   (CONTENT_STUB_PATTERNS linhas 22-29, 33) pressupõem que a descrição venha
 *   entre COLCHETES: "[conteúdo será gerado...]", "[o modelo irá gerar...]", etc.
 *   O texto real do incidente é PROSA SOLTA, sem colchete nenhum: "conteúdo será
 *   gerado em um time com base nos dados de memória recuperados" — escapou de
 *   toda a lista porque nenhum padrão cobria a mesma classe semântica (substantivo
 *   + futuro passivo "será/vai ser gerado") fora de colchetes.
 *
 * Correção: novo padrão bracket-free cobrindo a mesma classe semântica
 * (conteúdo|texto|resposta|áudio|resultado + será/vai ser + gerado/criado/produzido)
 * independente de colchetes — generaliza a suposição estrutural incorreta
 * ("o LLM sempre usa colchetes para meta-placeholder"), não apenas hardcoda a
 * frase literal deste incidente.
 *
 * Escopo tocado: shared/contentStubPatterns.ts (fonte única, já consolidada —
 * o fix beneficia automaticamente WriteTool, GoalPlanner E RiskAnalyzer, que já
 * importam a mesma constante).
 *
 * ATUALIZAÇÃO (06/07/2026, [[project_session_bugs_jul2026_ai]]): S39-5 mudou de
 * reason='content_stub' para reason='premature_content' — sanitizePlanSteps ganhou uma checagem
 * ESTRUTURAL (ordem dos steps: tool produtora de dado antes de write/send_audio) que roda antes
 * da regex e cobre este mesmo cenário (memory_search antes de send_audio) sem depender do texto.
 * O resultado (conversão para AgentLoop) não mudou.
 *
 * Execução: npx ts-node src/__tests__/regression/S39_ContentStub_BraceFreeMetaPlaceholder.test.ts
 */

process.env.WORKSPACE_DIR = process.env.WORKSPACE_DIR || 'D:/IA/newclaw/workspace';

import { CONTENT_STUB_PATTERNS } from '../../shared/contentStubPatterns';
import { sanitizePlanSteps } from '../../loop/planning/sanitizePlanSteps';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

const fakeToolRegistry = { get: (name: string) => ({ name }) };
const fakeDetectMissingRequiredArgs = (): string | null => null;

// classifyContentStub (09/07/2026) substituiu o parâmetro de regex em sanitizePlanSteps() —
// ver mesmo comentário em S38. Mock regex-backed preserva o comportamento histórico testado aqui.
const mockClassifyContentStub = async (content: string) =>
    ({ isStub: CONTENT_STUB_PATTERNS.some(p => p.test(content)), reason: 'mock (regex-backed)' });

async function main(): Promise<void> {

// ── 1: texto exato do incidente (prosa solta, sem colchete) ──

console.log('\n=== S39-1 — texto exato do incidente ("conteúdo será gerado...", sem colchete) é detectado ===');
{
    const realIncidentText = 'conteúdo será gerado em um time com base nos dados de memória recuperados';
    assert(CONTENT_STUB_PATTERNS.some(p => p.test(realIncidentText)), 'texto real do incidente é detectado como content-stub mesmo sem colchetes', realIncidentText);
}

// ── 2: variações da mesma classe semântica ──

console.log('\n=== S39-2 — variações da mesma classe (substantivo + futuro passivo) sem colchetes ===');
{
    const variants = [
        'o texto será gerado com base nos dados obtidos',
        'a resposta vai ser gerada a partir da pesquisa',
        'o áudio será criado com os dados coletados',
        'resultado será produzido pelo sistema',
    ];
    for (const v of variants) {
        assert(CONTENT_STUB_PATTERNS.some(p => p.test(v)), `variante detectada: "${v}"`, v);
    }
}

// ── 3: comportamento antigo (com colchetes) continua funcionando — sem regressão ──

console.log('\n=== S39-3 — padrões antigos (com colchetes) continuam funcionando ===');
{
    const bracketed = '[Conteúdo completo abrangendo a análise solicitada]';
    assert(CONTENT_STUB_PATTERNS.some(p => p.test(bracketed)), 'formato antigo com colchetes continua detectado — sem regressão', bracketed);
}

// ── 4: conteúdo real e legítimo NÃO é falsamente sinalizado ──

console.log('\n=== S39-4 — conteúdo real e legítimo não é falsamente sinalizado (sem falso positivo) ===');
{
    const legitimateTexts = [
        'Pedro é um desenvolvedor que trabalha no projeto NewClaw, um assistente open-source.',
        'A previsão do tempo para amanhã em Belo Horizonte é de céu limpo com máxima de 28 graus.',
        'O relatório será entregue até sexta-feira, conforme combinado na reunião.', // "será entregue" != "será gerado/criado/produzido"
    ];
    for (const t of legitimateTexts) {
        assert(!CONTENT_STUB_PATTERNS.some(p => p.test(t)), `conteúdo legítimo NÃO sinalizado: "${t.slice(0, 50)}..."`, t);
    }
}

// ── 5: sanitizePlanSteps barra o cenário completo do incidente ──

console.log('\n=== S39-5 — sanitizePlanSteps converte send_audio.text com o meta-placeholder real para AgentLoop ===');
{
    const rawSteps = [
        { id: 'step_1', toolName: 'memory_search', toolArgs: { query: 'Pedro' }, description: 'Buscar memória sobre o usuário' },
        { id: 'step_2', toolName: 'send_audio', toolArgs: { text: 'conteúdo será gerado em um time com base nos dados de memória recuperados' }, description: 'Enviar áudio com o perfil' },
    ];
    const result = await sanitizePlanSteps(rawSteps, fakeToolRegistry, '[TEST]', fakeDetectMissingRequiredArgs, mockClassifyContentStub);
    const audioStep = result.steps.find(s => s.id === 'step_2')!;
    assert(audioStep.toolName === undefined, 'step de send_audio com o meta-placeholder real do incidente é convertido para AgentLoop', audioStep);
    assert(result.mutations.some(m => m.stepId === 'step_2' && m.reason === 'premature_content'), 'mutation registrada com reason=premature_content (detecção estrutural: memory_search antes de send_audio)', result.mutations);
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S39 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;

}

main().catch((err) => {
    console.error('S39 erro inesperado:', err);
    process.exitCode = 1;
});
