/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S38
 * Investigação de log real (terceira rodada, 04/07/2026 22:49-22:50, após os commits
 * f8c408c e 4b03980 já terem corrigido classificação missing_tool/needs_dependency e
 * a resolução do edge-tts via PATH): usuário recebeu um áudio real, mas o CONTEÚDO
 * era incompreensível — "Aqui está a previsão do tempo para belôrizonte para
 * amanhã. Um ser ir dado os obtidos no step 1." em vez da previsão de verdade.
 *
 * Rastreamento no audit log mostrou a causa exata:
 *   1. Plano inicial teve 'send_audio' sem 'text' → corretamente convertido para
 *      AgentLoop por detectMissingRequiredArgs (fix de sessão anterior, commit f8c408c).
 *   2. RiskAnalyzer (revisão Q2) reescreveu o plano e trocou o step AgentLoop de volta
 *      para uma chamada DIRETA de send_audio, gerando o "text" ele mesmo — mas sem
 *      acesso ao output real do step anterior (Q2 roda em tempo de plano, só vê
 *      DESCRIÇÕES de step, nunca resultados de execução). O texto gerado foi uma
 *      prosa referenciando "step 1" em vez do dado real.
 *   3. Esse texto foi direto pro TTS sem ser barrado porque:
 *      a) CONTENT_STUB_PATTERNS já tinha um detector de vazamento de step_N
 *         (`/\bstep_\d+\b/i`), mas exigia UNDERSCORE — a frase gerada dizia
 *         "step 1" (com espaço), não "step_1", e escapou do padrão.
 *      b) mesmo se o padrão pegasse, a checagem de content-stub em
 *         sanitizePlanSteps.ts só rodava para `resolvedTool === 'write'` — nunca
 *         para `send_audio.text`, apesar de ser exatamente o mesmo tipo de conteúdo
 *         livre gerado pelo LLM que write.content já protegia.
 *
 * Correção: (a) padrão ampliado para `/\bstep[_\s-]?\d+\b/i` (cobre step_1/step-1/
 * "step 1"); (b) checagem de content-stub generalizada via mapa
 * CONTENT_BEARING_ARG (write→content, send_audio→text) em vez de hardcoded só pra
 * 'write' — mesmo padrão de generalização já usado no projeto para evitar "soluções
 * pontuais" (consolidação de padrões divergentes em shared/, ver contentStubPatterns.ts
 * e placeholderPatterns.ts).
 *
 * Escopo tocado: shared/contentStubPatterns.ts, loop/planning/sanitizePlanSteps.ts.
 *
 * ATUALIZAÇÃO (06/07/2026, [[project_session_bugs_jul2026_ai]]): S38-2 mudou de
 * reason='content_stub' para reason='premature_content' — sanitizePlanSteps ganhou uma checagem
 * ESTRUTURAL (ordem dos steps: tool produtora de dado antes de write/send_audio) que roda antes
 * da regex e cobre este mesmo cenário sem depender do texto. O resultado (conversão para
 * AgentLoop) não mudou.
 *
 * Execução: npx ts-node src/__tests__/regression/S38_ContentStub_SendAudioTextLeak.test.ts
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

// Sempre resolve a tool pedida — foco do teste é a detecção de stub, não o registry.
const fakeToolRegistry = { get: (name: string) => ({ name }) };
const fakeDetectMissingRequiredArgs = (): string | null => null; // não é o alvo deste teste

// classifyContentStub (09/07/2026) substituiu o parâmetro de regex em sanitizePlanSteps() por
// um classificador LLM real (ver shared/contentStubClassifier.ts) — mas o FOCO deste teste é a
// fiação de sanitizePlanSteps() (decide converter pra AgentLoop quando o classificador diz
// isStub=true), não o classificador em si. Mock aqui reusa CONTENT_STUB_PATTERNS só pra manter
// os textos históricos deste arquivo classificados exatamente como antes, sem depender de rede.
const mockClassifyContentStub = async (content: string) =>
    ({ isStub: CONTENT_STUB_PATTERNS.some(p => p.test(content)), reason: 'mock (regex-backed)' });

async function main(): Promise<void> {

// ── 1: regex isolada reproduz o texto EXATO do incidente ──

console.log('\n=== S38-1 — regex de step_N agora casa a frase real do incidente ("step 1", com espaço) ===');
{
    const realIncidentText = 'Aqui está a previsão do tempo para belôrizonte para amanhã. Um ser ir dado os obtidos no step 1.';
    const matched = CONTENT_STUB_PATTERNS.some(p => p.test(realIncidentText));
    assert(matched, 'texto real do áudio garbled do incidente é detectado como content-stub', realIncidentText);

    const oldStyleUnderscore = 'Baseado nos dados obtidos no step_1, a previsão é...';
    assert(CONTENT_STUB_PATTERNS.some(p => p.test(oldStyleUnderscore)), 'formato antigo (step_1, com underscore) continua detectado — sem regressão', null);

    const withDash = 'Conforme apurado no step-1 anterior.';
    assert(CONTENT_STUB_PATTERNS.some(p => p.test(withDash)), 'formato com hífen (step-1) também é detectado', null);

    const legitimateText = 'A previsão do tempo para Belo Horizonte amanhã é de céu limpo, com máxima de 28 graus.';
    assert(!CONTENT_STUB_PATTERNS.some(p => p.test(legitimateText)), 'conteúdo real e legítimo (sem menção a "step") NÃO é falsamente sinalizado', legitimateText);
}

// ── 2: sanitizePlanSteps agora aplica a checagem de stub em send_audio.text, não só write.content ──

console.log('\n=== S38-2 — sanitizePlanSteps detecta stub em send_audio.text (reproduz o cenário do incidente) ===');
{
    const rawSteps = [
        {
            id: 'step_1',
            toolName: 'weather',
            toolArgs: { city: 'Belo Horizonte' },
            description: 'Buscar previsão do tempo',
        },
        {
            id: 'step_2',
            toolName: 'send_audio',
            toolArgs: { text: 'Aqui está a previsão do tempo para belôrizonte para amanhã. Um ser ir dado os obtidos no step 1.' },
            description: 'Enviar áudio com a previsão',
        },
    ];

    const result = await sanitizePlanSteps(rawSteps, fakeToolRegistry, "[TEST]", fakeDetectMissingRequiredArgs, mockClassifyContentStub);

    const audioStep = result.steps.find(s => s.id === 'step_2')!;
    assert(audioStep.toolName === undefined, 'step de send_audio com texto-stub foi convertido para AgentLoop (toolName undefined)', audioStep);
    assert(audioStep.toolArgs === undefined, 'toolArgs do step convertido foi limpo', audioStep);

    // Reason atualizado para 'premature_content': este cenário tem 'weather' (DATA_PRODUCING_TOOLS)
    // antes do send_audio — o fix estrutural (ver sanitizePlanSteps.ts) agora pega esse caso pela
    // ORDEM dos steps, sem precisar casar a palavra "step" no texto. O resultado (conversão para
    // AgentLoop) é o mesmo; só o motivo registrado ficou mais preciso.
    const mutation = result.mutations.find(m => m.stepId === 'step_2');
    assert(mutation?.reason === 'premature_content', 'mutation registrada com reason=premature_content (detecção estrutural, não por regex)', mutation);
    assert(mutation?.originalTool === 'send_audio', 'mutation preserva qual tool original foi convertida', mutation);
}

console.log('\n=== S38-3 — send_audio.text LEGÍTIMO (sem menção a step) continua passando direto ===');
{
    const rawSteps = [
        {
            id: 'step_1',
            toolName: 'send_audio',
            toolArgs: { text: 'A previsão do tempo para Belo Horizonte amanhã é de céu limpo, com máxima de 28 graus.' },
            description: 'Enviar áudio com a previsão',
        },
    ];

    const result = await sanitizePlanSteps(rawSteps, fakeToolRegistry, "[TEST]", fakeDetectMissingRequiredArgs, mockClassifyContentStub);
    const audioStep = result.steps[0];
    assert(audioStep.toolName === 'send_audio', 'send_audio com texto real (sem stub) NÃO é convertido — sem falso positivo', audioStep);
    assert(result.mutations.length === 0, 'nenhuma mutation registrada para step legítimo', result.mutations);
}

console.log('\n=== S38-4 — write.content continua protegido (comportamento pré-existente preservado) ===');
{
    const rawSteps = [
        {
            id: 'step_1',
            toolName: 'write',
            toolArgs: { path: 'relatorio.txt', content: '[Conteúdo completo gerado a partir do step_1]' },
            description: 'Escrever relatório',
        },
    ];

    const result = await sanitizePlanSteps(rawSteps, fakeToolRegistry, "[TEST]", fakeDetectMissingRequiredArgs, mockClassifyContentStub);
    const writeStep = result.steps[0];
    assert(writeStep.toolName === undefined, 'write com content-stub continua sendo convertido para AgentLoop — sem regressão', writeStep);
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S38 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;

}

main().catch((err) => {
    console.error('S38 erro inesperado:', err);
    process.exitCode = 1;
});
