/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S157
 *
 * Achado real de produção (26-27/07/2026, goal_1785117691685_2cj7x): o LLM planejou
 * [write(tmp/gerar_pptx_teoria_computacao.js), ...sem exec_command..., send_document(saida.pptx)]
 * — escreveu o script GERADOR mas nunca agendou rodá-lo. `send_document` tentou enviar um
 * arquivo inexistente 3 VEZES SEGUIDAS (cada tentativa falhando com "Arquivo não encontrado")
 * antes do goal desistir — o que parou as tentativas foi o SAFETY-GUARD genérico de falhas
 * consecutivas do AgentLoop.ts (cego a "por quê", só conta repetições), não nenhuma lógica
 * ciente de arquivo/ordem. Já existia um aviso em TEXTO sobre isso na skill
 * (`pptx-generator/SKILL.md`, "REGRA CRÍTICA: escrever o script não é o fim da tarefa... sempre
 * write → exec_command → confirmar → send_document") — não impediu o LLM de ignorá-lo, porque é
 * só uma instrução de prompt, sem enforcement nenhum (feedback direto do usuário: "acho que
 * esses avisos só em texto não estão ajudando!").
 *
 * FIX: `sanitizePlanSteps.ts` ganha um check para REFERÊNCIA de arquivo: `send_document.file_path`
 * apontando pra um path que (a) ainda não existe em disco, e (b) nenhum step `write` ANTERIOR no
 * plano produz diretamente (mesmo path resolvido) — vira AgentLoop em vez de `send_document`,
 * IMPEDINDO a tentativa em vez de deixá-la falhar reativamente 3 vezes.
 *
 * SIMPLIFICAÇÃO (27/07/2026, revisão arquitetural pós-fix): a 1ª versão também tratava "algum
 * exec_command rodou antes no plano" como produtor plausível (reaproveitando `sawDataProducingTool`,
 * mecanismo de OUTRO check — `premature_content`, conteúdo inline). Removido deliberadamente:
 * "rodou exec_command" não tem relação verificável com "este arquivo específico vai existir" — o
 * nome final quase nunca aparece na linha de comando (o script decide internamente), então era uma
 * aposta não verificada, o mesmo tipo de falso-negativo que este check existe pra eliminar. Sem
 * essa muleta, write(script)→exec_command→send_document(nome diferente do script) TAMBÉM vira
 * AgentLoop — que resolve corretamente depois que o exec_command já rodou de verdade.
 *
 * Cobre os 9 casos pedidos:
 *   1-2 → função pura sanitizePlanSteps(): caso que REPRODUZ o bug real (write script sem
 *         exec_command) vira AgentLoop; write→exec_command→send_document(path diferente) TAMBÉM
 *         vira AgentLoop (simplificação acima — não é mais uma exceção)
 *   3   → write DIRETO pro mesmo path do send_document continua permitido —
 *         não é o caso do bug, é o caminho legítimo mais comum (ex: write de HTML direto)
 *   4   → send_document de um arquivo que JÁ EXISTE em disco (de fora do plano) é permitido
 *         mesmo sem write/exec_command anterior
 *   5   → write cujo CONTEÚDO foi classificado como stub (rebaixado por outro motivo) ainda
 *         assim "conta" seu path pretendido — não gera falso positivo pro send_document que
 *         reaproveita esse mesmo path (regressão do fix, ver comentário em sanitizePlanSteps.ts)
 *   6-7 → integração real com RiskAnalyzer.analyze(): reproduz o cenário de produção completo
 *         (write de script SEM exec_command) e confirma que o plano final não chega a tentar
 *         send_document para o arquivo inexistente
 *   8   → regressão: RiskAnalyzer.analyze() com write→exec_command→send_document (S27) continua
 *         funcionando (não é re-testado aqui, já coberto por S27 — só uma sanidade adicional)
 *   9   → inspeção de source: mutation reason 'missing_file_reference' existe e está documentada
 *
 * Execução: npx ts-node src/__tests__/regression/S157_SanitizePlanSteps_PrematureFileReference.test.ts
 */

process.env.WORKSPACE_DIR = process.env.WORKSPACE_DIR || 'D:/IA/newclaw/workspace';

import * as fs from 'fs';
import * as path from 'path';
import { sanitizePlanSteps } from '../../loop/planning/sanitizePlanSteps';
import { ToolRegistry } from '../../core/ToolRegistry';
import { WriteTool } from '../../tools/write_tool';
import { ExecCommandTool } from '../../tools/exec_command';
import { SendDocumentTool } from '../../tools/send_document';
import { RiskAnalyzer } from '../../loop/RiskAnalyzer';
import { Goal, PlanStep } from '../../loop/GoalTypes';
import type { ProviderFactory } from '../../core/ProviderFactory';
import type { ReflectionMemory } from '../../memory/ReflectionMemory';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

try { ToolRegistry.register(new WriteTool()); } catch { /* já registrado */ }
try { ToolRegistry.register(new ExecCommandTool(), { dangerous: true }); } catch { /* já registrado */ }
try { ToolRegistry.register(new SendDocumentTool({} as never)); } catch { /* já registrado */ }

const neverStub = async () => ({ isStub: false, reason: 'test: nunca stub' });
const noMissingArgs = () => null;

function makeGoal(objective: string): Goal {
    const now = Date.now();
    return {
        id: `goal_test_s157_${now}`,
        sessionKey: 'test-session',
        conversationId: 'test-conv',
        userIntent: objective,
        objective,
        status: 'active',
        currentPlan: [],
        attempts: [],
        blockers: [],
        toolsTried: [],
        strategiesTried: [],
        retryBudget: 5,
        replanBudget: 3,
        confidence: 0.85,
        requiresAuth: false,
        authorizationScope: [],
        expiresAt: now + 600_000,
        isConstruction: false,
        roadmap: [],
        currentMilestoneIndex: 0,
        allowRoadmapAdjustment: true,
        successCriteria: [],
        sentArtifacts: [],
    } as unknown as Goal;
}

async function main() {
    // Paths garantidamente inexistentes — sufixo aleatório evita colisão com execuções anteriores.
    const nonce = Date.now();
    const scriptPath = `tmp/gerar_pptx_s157_${nonce}.js`;
    const outputPath = `saida_s157_${nonce}.pptx`;
    const preExistingPath = `existe_de_verdade_s157_${nonce}.txt`;
    const workspaceDir = path.resolve(process.env.WORKSPACE_DIR!);
    const preExistingResolved = path.join(workspaceDir, preExistingPath);

    console.log('\n=== S157-1 — REPRODUÇÃO DO BUG REAL: write(script) sem exec_command → send_document vira AgentLoop ===');
    {
        const result = await sanitizePlanSteps(
            [
                { id: 'step_1', description: 'escrever script gerador', toolName: 'write', toolArgs: { path: scriptPath, content: 'gera o pptx quando executado' } },
                { id: 'step_2', description: 'enviar o pptx gerado', toolName: 'send_document', toolArgs: { file_path: outputPath } },
            ],
            ToolRegistry, '[S157]', noMissingArgs, neverStub,
        );
        assert(result.steps[1]?.toolName === undefined, 'send_document vira AgentLoop (bug real reproduzido e corrigido)', result.steps[1]);
        assert(result.mutations.some(m => m.reason === 'missing_file_reference'), 'mutation registrada com reason=missing_file_reference', result.mutations);
    }

    console.log('\n=== S157-2 — SIMPLIFICAÇÃO (27/07): write(script) → exec_command → send_document(path DIFERENTE) também vira AgentLoop ===');
    {
        // Decisão deliberada, não regressão: "rodou algum exec_command antes" foi removido como
        // "produtor plausível" — não tem relação verificável com o arquivo específico (o nome
        // final quase nunca aparece na linha de comando; o script decide internamente). Confiar
        // nisso era uma aposta não verificada, exatamente o tipo de falso-negativo que este check
        // existe para eliminar (ver comentário em sanitizePlanSteps.ts). Sem essa muleta, este
        // caso também vira AgentLoop — que resolve corretamente em runtime, depois que o
        // exec_command já rodou de verdade e o arquivo realmente existe.
        const result = await sanitizePlanSteps(
            [
                { id: 'step_1', description: 'escrever script gerador', toolName: 'write', toolArgs: { path: scriptPath, content: 'gera o pptx quando executado' } },
                { id: 'step_2', description: 'rodar o script', toolName: 'exec_command', toolArgs: { command: `node ${scriptPath}` } },
                { id: 'step_3', description: 'enviar o pptx gerado', toolName: 'send_document', toolArgs: { file_path: outputPath } },
            ],
            ToolRegistry, '[S157]', noMissingArgs, neverStub,
        );
        assert(result.steps[2]?.toolName === undefined, 'send_document vira AgentLoop mesmo com exec_command anterior — path final não é verificável estaticamente', result.steps[2]);
        assert(result.mutations.some(m => m.reason === 'missing_file_reference'), 'mutation registrada — AgentLoop vai confirmar o arquivo real após o exec_command rodar', result.mutations);
    }

    console.log('\n=== S157-3 — write DIRETO pro mesmo path (sem exec_command) continua permitido (caminho legítimo mais comum) ===');
    {
        const result = await sanitizePlanSteps(
            [
                { id: 'step_1', description: 'escrever slides html', toolName: 'write', toolArgs: { path: outputPath, content: 'conteudo real dos slides' } },
                { id: 'step_2', description: 'enviar o arquivo', toolName: 'send_document', toolArgs: { file_path: outputPath } },
            ],
            ToolRegistry, '[S157]', noMissingArgs, neverStub,
        );
        assert(result.steps[1]?.toolName === 'send_document', 'send_document permanece — write produz o MESMO path diretamente, sem precisar de exec_command', result.steps[1]);
    }

    console.log('\n=== S157-4 — send_document de arquivo JÁ EXISTENTE em disco é permitido sem write/exec_command anterior ===');
    {
        fs.writeFileSync(preExistingResolved, 'conteudo de teste');
        try {
            const result = await sanitizePlanSteps(
                [
                    { id: 'step_1', description: 'enviar arquivo que já existe', toolName: 'send_document', toolArgs: { file_path: preExistingPath } },
                ],
                ToolRegistry, '[S157]', noMissingArgs, neverStub,
            );
            assert(result.steps[0]?.toolName === 'send_document', 'send_document permanece — arquivo já existe em disco, nenhum produtor necessário', result.steps[0]);
        } finally {
            fs.unlinkSync(preExistingResolved);
        }
    }

    console.log('\n=== S157-5 — write com conteúdo classificado como stub AINDA registra seu path pretendido (sem falso positivo) ===');
    {
        const isStubClassifier = async () => ({ isStub: true, reason: 'test: forçando stub' });
        const result = await sanitizePlanSteps(
            [
                { id: 'step_1', description: 'escrever slides', toolName: 'write', toolArgs: { path: outputPath, content: 'stub qualquer' } },
                { id: 'step_2', description: 'enviar o arquivo', toolName: 'send_document', toolArgs: { file_path: outputPath } },
            ],
            ToolRegistry, '[S157]', noMissingArgs, isStubClassifier,
        );
        assert(result.steps[0]?.toolName === undefined, 'write vira AgentLoop por content_stub (comportamento já existente, não mudou)', result.steps[0]);
        assert(result.steps[1]?.toolName === 'send_document', 'send_document NÃO vira AgentLoop — path pretendido do write contou mesmo com o write rebaixado', result.steps[1]);
        assert(!result.mutations.some(m => m.reason === 'missing_file_reference'), 'nenhuma mutation de missing_file_reference nesse caso (regressão do fix)', result.mutations);
    }

    console.log('\n=== S157-6/7 — integração real com RiskAnalyzer.analyze(): cenário de produção completo ===');
    {
        // Mesmo padrão de mock de S27: RiskAnalyzer.analyze() consulta uma LLM de revisão
        // (providerFactory) que pode devolver um plano substituto — simulamos ela devolvendo
        // EXATAMENTE o plano problemático real (write do script, sem exec_command, send_document
        // direto), para confirmar que sanitizePlanSteps() (chamado internamente por analyze())
        // barra o send_document antes dele ser tentado.
        const fakeProviderFactory = {
            getProviderWithModel: () => ({
                chat: async () => ({
                    content: JSON.stringify({
                        risks: [],
                        plan: [
                            { id: 'step_1', description: `escrever script gerador ${scriptPath}`, toolName: 'write', toolArgs: { path: scriptPath, content: 'gera pptx quando executado' } },
                            { id: 'step_2', description: `enviar ${outputPath} gerado`, toolName: 'send_document', toolArgs: { file_path: outputPath } },
                        ],
                    }),
                }),
            }),
        } as unknown as ProviderFactory;
        const fakeReflectionMemory = {
            findHardConstraints: () => [],
            findToolFailures: () => '',
        } as unknown as ReflectionMemory;

        const riskAnalyzer = new RiskAnalyzer(fakeProviderFactory, ToolRegistry, fakeReflectionMemory, neverStub);
        const goal = makeGoal('gerar slides de teoria da computação em pptx editável');
        const seedPlan: PlanStep[] = [
            { id: 'step_1', description: 'ler aula.txt', toolName: 'read', toolArgs: { path: 'aula.txt' }, status: 'pending', fallbackSteps: [] },
        ];
        const report = await riskAnalyzer.analyze(goal, seedPlan, []);
        const sendStep = report.adjustedPlan.find(s => s.id === 'step_2');
        assert(
            sendStep?.toolName !== 'send_document',
            `send_document NUNCA chega a ser tentado sem exec_command no meio, mesmo vindo do plano ajustado pela LLM de revisão (obtido: ${sendStep?.toolName})`,
            report.adjustedPlan,
        );
    }

    console.log('\n=== S157-9 — inspeção de source: reason "missing_file_reference" documentada ===');
    {
        const src = fs.readFileSync(path.join(process.cwd(), 'src', 'loop', 'planning', 'sanitizePlanSteps.ts'), 'utf-8');
        assert(/'missing_file_reference'/.test(src), 'StepMutationReason inclui "missing_file_reference"');
        assert(/TOOL_DEPENDENCY_ARG/.test(src), 'TOOL_DEPENDENCY_ARG existe — tabela unificada (27/07: consolidação de CONTENT_BEARING_ARG + FILE_REFERENCE_ARG num único mapa com campo kind)');
        assert(/kind:\s*'file_reference'/.test(src), "send_document está declarado com kind: 'file_reference' na tabela unificada");
        assert(/writtenPaths/.test(src), 'writtenPaths existe para evitar falso positivo no caminho write→send_document direto');
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S157 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
    console.error('S157 erro inesperado:', err);
    process.exitCode = 1;
});
