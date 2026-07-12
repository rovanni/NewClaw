/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S60
 * Fix estrutural pedido explicitamente pelo usuário após [[project_session_bugs_jul2026_ai]]
 * (5ª rodada da mesma família de bug: send_audio.text/write.content decidido em tempo de plano,
 * antes de uma tool produtora de dado real ter rodado — "step_1" → "step 1" → "etapas
 * anteriores" → "gerado pelo assistente" → "passo 1", cada rodada uma frase nova escapando de
 * CONTENT_STUB_PATTERNS). Em vez de continuar caçando vocabulário por regex, sanitizePlanSteps()
 * ganhou uma checagem ESTRUTURAL: se uma tool de DATA_PRODUCING_TOOLS (weather, crypto_analysis,
 * web_search, web_navigate, read, read_document, memory_search, exec_command, ssh_exec) aparece
 * ANTES de um step de write/send_audio no MESMO plano, o conteúdo desse step posterior não pode
 * ser real (a tool ainda não rodou) — convertido para AgentLoop INDEPENDENTE do texto.
 *
 * A prova decisiva de que isso é estrutural (não mais uma regra de vocabulário) é o teste 1
 * abaixo: um texto que soa 100% como previsão real, sem NENHUMA palavra que qualquer padrão de
 * CONTENT_STUB_PATTERNS reconheceria, ainda assim é barrado — porque a garantia vem da ORDEM dos
 * steps no plano, não do que o LLM escreveu.
 *
 * Escopo tocado: loop/planning/sanitizePlanSteps.ts (DATA_PRODUCING_TOOLS, sawDataProducingTool,
 * reason='premature_content'). Nenhuma tool alterada.
 *
 * Execução: npx ts-node src/__tests__/regression/S60_SanitizePlanSteps_StructuralDataDependency.test.ts
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

// Sempre resolve a tool pedida — foco do teste é a checagem estrutural, não o registry.
const fakeToolRegistry = { get: (name: string) => ({ name }) };
const fakeDetectMissingRequiredArgs = (): string | null => null; // não é o alvo deste teste

// classifyContentStub (09/07/2026) substituiu o parâmetro de regex em sanitizePlanSteps() —
// ver mesmo comentário em S38. Mock regex-backed preserva o comportamento histórico testado
// aqui — irrelevante para S60 de qualquer forma, já que todo caso deste arquivo ou tem uma
// DATA_PRODUCING_TOOL antes (bypassa o classificador via checagem estrutural) ou usa texto
// deliberadamente limpo (sem stub, real ou mock).
const mockClassifyContentStub = async (content: string) =>
    ({ isStub: CONTENT_STUB_PATTERNS.some(p => p.test(content)), reason: 'mock (regex-backed)' });

async function main(): Promise<void> {

console.log('\n=== S60-1 — texto SEM nenhuma palavra-molde (não bateria em NENHUM regex) ainda é barrado ===');
{
    // Frase deliberadamente "limpa": nenhuma menção a step/passo/etapa/fase, nenhum futuro
    // "será gerado", nenhum "pelo assistente" — se algum padrão de CONTENT_STUB_PATTERNS
    // acidentalmente casasse isso, seria falso-positivo do regex, não da checagem estrutural.
    const plausibleButPremature = 'Vai fazer sol amanhã em Belo Horizonte, com máxima de trinta graus.';
    assert(!CONTENT_STUB_PATTERNS.some(p => p.test(plausibleButPremature)), 'pré-condição: nenhum regex de CONTENT_STUB_PATTERNS casa esse texto', plausibleButPremature);

    const rawSteps = [
        { id: 'step_1', toolName: 'weather', toolArgs: { city: 'Belo Horizonte' }, description: 'Buscar previsão do tempo' },
        { id: 'step_2', toolName: 'send_audio', toolArgs: { text: plausibleButPremature }, description: 'Enviar áudio com a previsão' },
    ];
    const result = await sanitizePlanSteps(rawSteps, fakeToolRegistry, '[TEST]', fakeDetectMissingRequiredArgs, mockClassifyContentStub);
    const audioStep = result.steps.find(s => s.id === 'step_2')!;
    assert(audioStep.toolName === undefined, 'mesmo sem nenhuma palavra-molde, o step é convertido para AgentLoop (garantia estrutural)', audioStep);
    const mutation = result.mutations.find(m => m.stepId === 'step_2');
    assert(mutation?.reason === 'premature_content', 'motivo registrado é premature_content (não content_stub — não veio de regex)', mutation);
}

console.log('\n=== S60-2 — cobre outras DATA_PRODUCING_TOOLS além de weather ===');
{
    const cases: Array<{ tool: string; args: Record<string, unknown> }> = [
        { tool: 'crypto_analysis', args: { type: 'price', symbol: 'BTC' } },
        { tool: 'web_search', args: { query: 'cotação do dólar hoje' } },
        { tool: 'exec_command', args: { command: 'echo teste' } },
        { tool: 'read', args: { path: 'dados.txt' } },
        { tool: 'memory_search', args: { query: 'preferências' } },
    ];
    for (const c of cases) {
        const rawSteps = [
            { id: 'step_1', toolName: c.tool, toolArgs: c.args, description: 'Obter dado' },
            { id: 'step_2', toolName: 'write', toolArgs: { path: 'saida.txt', content: 'Resultado direto e específico, sem stub.' }, description: 'Escrever resultado' },
        ];
        const result = await sanitizePlanSteps(rawSteps, fakeToolRegistry, '[TEST]', fakeDetectMissingRequiredArgs, mockClassifyContentStub);
        const writeStep = result.steps.find(s => s.id === 'step_2')!;
        assert(writeStep.toolName === undefined, `write após '${c.tool}' com conteúdo pré-escrito é convertido para AgentLoop`, writeStep);
    }
}

console.log('\n=== S60-3 — SEM tool produtora de dado antes, conteúdo direto e legítimo NÃO é afetado (sem falso-positivo) ===');
{
    const rawSteps = [
        { id: 'step_1', toolName: 'write', toolArgs: { path: 'poema.txt', content: 'Folhas caem, outono chega, silêncio dourado no ar.' }, description: 'Escrever poema' },
    ];
    const result = await sanitizePlanSteps(rawSteps, fakeToolRegistry, '[TEST]', fakeDetectMissingRequiredArgs, mockClassifyContentStub);
    const writeStep = result.steps[0];
    assert(writeStep.toolName === 'write', 'write sem nenhuma tool de dado antes permanece direto (conteúdo autocontido é legítimo)', writeStep);
    assert(result.mutations.length === 0, 'nenhuma mutation registrada', result.mutations);
}

console.log('\n=== S60-4 — tools de AÇÃO (não produtoras de dado) antes do write NÃO disparam a checagem estrutural ===');
{
    const rawSteps = [
        { id: 'step_1', toolName: 'schedule', toolArgs: { when: 'amanhã 9h', text: 'lembrete' }, description: 'Criar lembrete' },
        { id: 'step_2', toolName: 'send_audio', toolArgs: { text: 'Lembrete criado com sucesso para amanhã às 9 horas.' }, description: 'Confirmar por áudio' },
    ];
    const result = await sanitizePlanSteps(rawSteps, fakeToolRegistry, '[TEST]', fakeDetectMissingRequiredArgs, mockClassifyContentStub);
    const audioStep = result.steps.find(s => s.id === 'step_2')!;
    assert(audioStep.toolName === 'send_audio', "'schedule' não é DATA_PRODUCING_TOOLS — send_audio permanece direto", audioStep);
    assert(result.mutations.length === 0, 'nenhuma mutation registrada', result.mutations);
}

console.log('\n=== S60-5 — tool produtora de dado em QUALQUER posição anterior (não só imediatamente antes) dispara a checagem ===');
{
    const rawSteps = [
        { id: 'step_1', toolName: 'weather', toolArgs: { city: 'Belo Horizonte' }, description: 'Buscar previsão' },
        { id: 'step_2', toolName: 'schedule', toolArgs: { when: 'amanhã 8h' }, description: 'Agendar lembrete' },
        { id: 'step_3', toolName: 'send_audio', toolArgs: { text: 'Céu limpo, 25 graus, sem chance de chuva.' }, description: 'Enviar áudio' },
    ];
    const result = await sanitizePlanSteps(rawSteps, fakeToolRegistry, '[TEST]', fakeDetectMissingRequiredArgs, mockClassifyContentStub);
    const audioStep = result.steps.find(s => s.id === 'step_3')!;
    assert(audioStep.toolName === undefined, 'weather no step_1 (não imediatamente anterior) ainda assim dispara a conversão do step_3', audioStep);
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S60 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;

}

main().catch((err) => {
    console.error('S60 erro inesperado:', err);
    process.exitCode = 1;
});
