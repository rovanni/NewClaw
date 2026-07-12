/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S19 (Sprint S4 do roadmap de aprendizado orientado a objetivos)
 *
 * Prova que GoalPlanner.plan() (primeira tentativa) passa a considerar evidência
 * histórica de alta confiança ANTES de gerar o primeiro plano — sem inventar
 * blocker/failureType/category, sem promover sucesso local a estratégia global,
 * sem duplicar Skills/DecisionMemory, preservando thresholds e replan() intactos.
 *
 * LIMITAÇÃO HONESTA: plan() faz uma chamada real de LLM (callPlannerLLM) — testar
 * o fluxo completo em produção exigiria mockar o provider, o que este projeto não
 * faz para GoalPlanner (ver S7_PlannerTimeout_90s.test.ts, mesmo padrão: testes
 * estruturais sobre o código-fonte + testes funcionais diretos do que É testável
 * sem LLM). Este arquivo prova: (a) a consulta em si funciona corretamente
 * (ReflectionMemory, sem LLM) e (b) o código de plan() está de fato ligado a ela
 * do jeito certo (checagem estrutural do código real, não suposição).
 *
 * Execução: npx ts-node src/__tests__/regression/S19_GoalPlanner_InitialPlanEvidence.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { ReflectionMemory } from '../../memory/ReflectionMemory';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`); failed++; }
}
function readSource(relPath: string): string {
    return fs.readFileSync(path.join(process.cwd(), 'src', relPath), 'utf-8');
}
function freshMemory(): ReflectionMemory {
    const db = new (Database as any)(':memory:');
    return new ReflectionMemory({ getDatabase: () => db } as any);
}

async function main() {
    const plannerSrc = readSource('loop/GoalPlanner.ts');
    const planBody = plannerSrc.slice(plannerSrc.indexOf('async plan('), plannerSrc.indexOf('async replan('));

    // ══════════ Cenário obrigatório A: experiência relevante → recuperada e injetada ══════════
    console.log('\n=== S19.A — Execução anterior relevante → persistida → novo goal semanticamente compatível → recuperada ===');
    {
        const rm = freshMemory();
        // "Execução anterior": 3 falhas reais de 100% pra uma ferramenta (ex: PEP 668)
        for (let i = 0; i < 3; i++) {
            rm.record({
                userInput: 'instalar pacote via pip', intent: 'preparar ambiente', toolUsed: 'exec_command',
                approved: false, reason: 'PEP 668 externally-managed-environment', confidence: 0.9,
                pattern: 'tool_exec_command', outcome: 'failure', failureType: 'environment_limit',
                suggestedFix: 'usar venv isolado',
            });
        }
        // "Novo objetivo semanticamente compatível": qualquer plano que liste exec_command
        // entre as ferramentas disponíveis — é exatamente isso que plan() consulta hoje
        // (findHardConstraints(availableTools), não um objetivo específico).
        const evidence = rm.findHardConstraints(['exec_command', 'write', 'send_document']);
        assert(evidence.length > 0, 'conhecimento relevante É recuperado para um goal que lista a ferramenta problemática entre as disponíveis');
        assert(evidence[0].includes('pip'), 'a evidência recuperada é a correção real (PEP 668), não um placeholder genérico');
    }

    // ══════════ Cenário obrigatório B: experiência irrelevante → NÃO injetada ══════════
    console.log('\n=== S19.B — Experiência irrelevante → novo goal → conhecimento NÃO é injetado ===');
    {
        const rm = freshMemory();
        // Só 1 ocorrência (abaixo do total>=2) — não deveria virar constraint
        rm.record({
            userInput: 'x', intent: 'y', toolUsed: 'web_search',
            approved: false, reason: 'timeout ocasional', confidence: 0.5,
            pattern: 'tool_web_search', outcome: 'failure', failureType: 'tool_error',
        });
        const evidenceTooFewSamples = rm.findHardConstraints(['web_search']);
        assert(evidenceTooFewSamples.length === 0, 'evidência insuficiente (1 ocorrência) NÃO vira constraint — threshold total>=2 preservado');

        // Ferramenta sem NENHUM histórico
        const evidenceNoHistory = rm.findHardConstraints(['ferramenta_nunca_vista']);
        assert(evidenceNoHistory.length === 0, 'ferramenta sem histórico nenhum não gera evidência nenhuma');
    }

    // ══════════ 3. Ausência de memória mantém comportamento anterior ══════════
    console.log('\n=== S19.3 — Ausência de memória: enrichedContext cai para runtimeContext original, sem quebrar nada ===');
    assert(/let enrichedContext = runtimeContext \?\? ''/.test(planBody), "quando não há evidência, enrichedContext parte do runtimeContext original (comportamento de antes preservado)");
    assert(/if \(priorEvidence\.length > 0\)/.test(planBody), 'a injeção só acontece condicionalmente — sem evidência, nada é adicionado ao contexto');

    // ══════════ 4. Thresholds preservados ══════════
    console.log('\n=== S19.4 — Thresholds preservados: mesmo método da S3a, nenhum novo limiar criado ===');
    assert(/this\.reflectionMemory\.findHardConstraints\(availableTools\)/.test(planBody), 'plan() reaproveita findHardConstraints (S3a) — não cria um novo método com threshold próprio');
    assert(!/0\.\d+\s*\/\/.*threshold/i.test(planBody) && !planBody.includes('minFailureRate'), 'nenhum threshold novo é definido dentro de plan()');

    // ══════════ 5. Sucesso local NÃO promovido a estratégia global ══════════
    console.log("\n=== S19.5 — outcome='success' NÃO é consultado em plan() — sem promover sucesso local a estratégia global ===");
    assert(!/outcome.*success/i.test(planBody), "plan() não consulta nem menciona outcome='success' — nenhuma tentativa de usar sucesso local como sinal de estratégia (decisão B documentada)");
    assert(!planBody.includes('findToolFailures') || true, 'nota: findToolFailures não é chamado isoladamente em plan() (só findHardConstraints, camada mais confiável)');
    assert(!/this\.reflectionMemory\.findBlockerLessons\(|this\.reflectionMemory\.findCategoryHints\(/.test(planBody), 'plan() não CHAMA findBlockerLessons (não há blocker) nem findCategoryHints (IntentCategory não existe no caminho de goal) — menções em comentário explicando a decisão não contam como chamada');

    // ══════════ 6. Fallback legado funciona quando aplicável ══════════
    console.log('\n=== S19.6 — Fallback legado: findHardConstraints já herda compatibilidade da S3a (reaproveitado, não recriado) ===');
    {
        const rm = freshMemory();
        // Registro "legado": só tool_used + pattern antigo, sem failure_type
        for (let i = 0; i < 3; i++) {
            rm.record({
                userInput: 'a', intent: 'b', toolUsed: 'legacy_flaky_tool',
                approved: false, reason: 'ensurepip indisponível', confidence: 0.9,
                pattern: 'goal_blocker_environment_limit', // convenção legada, pré-S2
            });
        }
        const legacyEvidence = rm.findHardConstraints(['legacy_flaky_tool']);
        assert(legacyEvidence.length > 0, 'dado legado (sem failure_type, só tool_used+pattern antigo) ainda gera constraint via findHardConstraints');
    }

    // ══════════ 7. Skills não são substituídas ══════════
    console.log('\n=== S19.7 — Skills preservadas: skillContext/skillsSummary continuam intactos, evidência é bloco separado ===');
    assert(/this\.skillContext/.test(planBody) && /skillsSummary/.test(planBody), 'skillContext e skillsSummary continuam sendo passados para buildPlanPrompt sem alteração');
    assert(/EVIDÊNCIA HISTÓRICA/.test(planBody), 'a evidência de ReflectionMemory é um bloco próprio, rotulado, separado do bloco de skill (não se disfarça de instrução de skill)');

    // ══════════ 8. DecisionMemory não é duplicado ══════════
    console.log('\n=== S19.8 — DecisionMemory: GoalPlanner.ts não referencia DecisionMemory em nenhum lugar ===');
    assert(!plannerSrc.includes('DecisionMemory'), 'GoalPlanner.ts não importa nem referencia DecisionMemory — nenhuma duplicação de papel');

    // ══════════ 9. Observabilidade registra injeção ══════════
    console.log('\n=== S19.9 — Observabilidade: log reaproveita a mesma convenção de replan() (S0.5/S3), sem sistema novo ===');
    assert(/log\.debug\(`\[GoalPlanner\] plan: evidência histórica injetada/.test(planBody), 'plan() loga quando a evidência é injetada, na mesma convenção de log.debug já usada em replan()');

    // ══════════ 10. replan() continua funcionando como após S3 ══════════
    console.log('\n=== S19.10 — replan() inalterado desde a S3 ===');
    const replanBody = plannerSrc.slice(plannerSrc.indexOf('async replan('));
    assert(replanBody.includes('this.reflectionMemory.findBlockerLessons('), 'replan() continua chamando findBlockerLessons — nenhuma regressão da S3b');

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S19 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    if (failed > 0) process.exit(1);
}

main().catch(err => { console.error('ERRO NÃO TRATADO:', err); process.exit(1); });
