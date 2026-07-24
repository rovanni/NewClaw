/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S26 (Sprint S7.5: auditoria adversarial do Operational Applicability Gate)
 *
 * NÃO é uma expansão de cobertura por cobertura. Documenta o que a auditoria S7.5 realmente
 * encontrou ao executar classifyOperation()/operationalCompatibility() contra entradas
 * adversariais (flexão, negação, multi-op, lifecycle, direção) — separando explicitamente
 * "limitação aceitável em modo sombra" (degrada para 'unknown', nunca gera falso-compatível)
 * de "falha real corrigida" (negação, único gap que produzia falso-compatível).
 *
 * Não duplica S25 (contrato positivo do gate) — este arquivo é sobre os LIMITES do sinal.
 *
 * Execução: npx ts-node src/__tests__/regression/S26_OperationalApplicability_AdversarialAudit.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { classifyOperation, operationalCompatibility, OperationalIntent } from '../../memory/CaseMemory';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`); failed++; }
}
function readSource(relPath: string): string {
    return fs.readFileSync(path.join(process.cwd(), 'src', relPath), 'utf-8');
}

async function main() {
    const caseMemorySrc = readSource('memory/CaseMemory.ts');
    const plannerSrc = readSource('loop/GoalPlanner.ts');
    const riskSrc = readSource('loop/RiskAnalyzer.ts');
    const orchestratorSrc = readSource('loop/GoalOrchestrator.ts');

    // ══════════ Fase 2 — Matriz 5×5: compatibilidade é IGUALDADE DE CLASSE, não redução booleana ══════════
    console.log('\n=== S26.1 — Matriz completa: diagonal true, resto false, unknown sempre propaga ===');
    const classes: OperationalIntent[] = ['create', 'modify', 'remove', 'inspect'];
    for (const a of classes) {
        for (const b of classes) {
            const expected = a === b;
            assert(operationalCompatibility(a, b) === expected, `${a}×${b} → ${expected}`);
        }
        assert(operationalCompatibility(a, 'unknown') === 'unknown', `${a}×unknown → unknown (não vira false)`);
        assert(operationalCompatibility('unknown', a) === 'unknown', `unknown×${a} → unknown (simétrico)`);
    }
    assert(operationalCompatibility('unknown', 'unknown') === 'unknown', 'unknown×unknown → unknown');

    // ══════════ Fase 4 — FLEXÃO: gerúndio/particípio são um gap real (degrada para unknown, não para erro) ══════════
    console.log('\n=== S26.2 — Flexão verbal: infinitivo/imperativo cobertos; gerúndio/particípio majoritariamente NÃO (limitação documentada, não corrigida nesta Sprint) ===');
    assert(classifyOperation('remover o arquivo') === 'remove', 'infinitivo funciona');
    assert(classifyOperation('remova o arquivo') === 'remove', 'imperativo funciona');
    assert(classifyOperation('removendo o arquivo') === 'unknown', 'GAP CONHECIDO: gerúndio não reconhecido → unknown (seguro: não vira classe errada, só não classifica)');
    assert(classifyOperation('removido o arquivo') === 'unknown', 'GAP CONHECIDO: particípio não reconhecido → unknown');
    assert(classifyOperation('criando uma apresentação') === 'create', 'exceção assimétrica encontrada na auditoria: "criando" foi incluído no léxico de create, mas o padrão gerúndio NÃO foi aplicado sistematicamente às outras 3 famílias (documentado como inconsistência, não como bug de comportamento incorreto — resultado ainda é seguro)');

    // ══════════ Fase 5 — NEGAÇÃO: era o único gap com risco de falso-compatível; CORRIGIDO nesta Sprint ══════════
    console.log('\n=== S26.3 — Negação: "remover" × "não remover" NÃO podem colidir na mesma classe (fix da S7.5) ===');
    const negationPairs: Array<[string, OperationalIntent]> = [
        ['não remover o arquivo', 'unknown'],
        ['não excluir o banco', 'unknown'],
        ['sem apagar os dados', 'unknown'],
        ['evite remover o serviço', 'unknown'],
        ['não crie outro arquivo', 'unknown'],
        ['não gere nova apresentação', 'unknown'],
        ['não altere a configuração', 'unknown'],
        ['não analise novamente', 'unknown'],
    ];
    for (const [text, expected] of negationPairs) {
        assert(classifyOperation(text) === expected, `"${text}" → ${expected} (antes do fix: classificava como se a operação fosse desejada)`);
    }
    assert(
        operationalCompatibility(classifyOperation('remover o arquivo'), classifyOperation('não remover o arquivo')) === 'unknown',
        'PROVA DIRETA do bug corrigido: "remover" × "não remover" agora produz unknown, não mais compatible=true'
    );
    // Negação distante não deve apagar classificação legítima (evitar over-triggering)
    assert(classifyOperation('não sei, mas quero criar uma apresentação') === 'create', 'negação FORA da janela de 3 tokens antes do verbo não deve invalidar a classificação (evita falso-negativo por over-triggering)');

    // ══════════ Fase 6 — Auxiliares: robusto, verbo é achado por posição em qualquer lugar da frase ══════════
    console.log('\n=== S26.4 — Formas auxiliares/naturais: robustas (verbo encontrado independente de "quero/preciso/gostaria") ===');
    assert(classifyOperation('quero criar uma apresentação') === 'create', 'auxiliar "quero" não atrapalha');
    assert(classifyOperation('gostaria de remover o serviço') === 'remove', 'auxiliar "gostaria de" não atrapalha');
    assert(classifyOperation('preciso que você valide o relatório') === 'inspect', 'auxiliar "preciso que você" não atrapalha');

    // ══════════ Fase 7 — MULTI-OP: primeiro verbo por posição vence; segundo é descartado (limitação aceitável em sombra) ══════════
    console.log('\n=== S26.5 — Multi-op: primeiro verbo vence, informação do segundo verbo É PERDIDA (limitação documentada) ===');
    assert(classifyOperation('analise e corrija a configuração') === 'inspect', 'primeiro verbo (analise) vence sobre o segundo (corrija/modify) — modify fica invisível');
    assert(classifyOperation('diagnostique e corrija o serviço') === 'inspect', 'mesma limitação: "corrija" (modify) é descartado silenciosamente');
    assert(classifyOperation('migre e remova o banco antigo') === 'modify', 'mesma limitação: "remova" (remove, potencialmente mais consequente) é descartado silenciosamente');
    console.log('  ℹ️  RISCO: um Caso multi-op e uma query multi-op que compartilham o segundo verbo mas não o primeiro nunca serão marcados compatíveis por esta classificação — aceitável em modo sombra (só reduz recall, não produz falso-compatível), mas deve ser revisitado antes de qualquer influência real no Planner.');

    // ══════════ Fase 8/10 — Cobertura de lifecycle/transformação: gaps seguros (unknown), não corrigidos ══════════
    console.log('\n=== S26.6 — Lifecycle/transformação: muitos verbos comuns ainda não estão em nenhum léxico → unknown (gap de cobertura, não de correção) ===');
    for (const v of ['configurar serviço', 'iniciar serviço', 'parar serviço', 'reiniciar serviço', 'exportar dados', 'importar dados', 'copiar arquivo', 'mover arquivo', 'renomear arquivo', 'compactar arquivo']) {
        assert(classifyOperation(v) === 'unknown', `GAP DE COBERTURA (não corrigido nesta Sprint, é seguro): "${v}" → unknown`);
    }

    // ══════════ Fase 11 — DIREÇÃO: só create×remove foi resolvido; outras polaridades ainda não generalizam ══════════
    console.log('\n=== S26.7 — Direção/inversão: a S7 resolveu especificamente create×remove; NÃO generaliza para outras polaridades (achado central da S7.5) ===');
    assert(operationalCompatibility(classifyOperation('instalar serviço'), classifyOperation('desinstalar serviço')) === false, 'instalar×desinstalar → create×remove, resolvido');
    assert(operationalCompatibility(classifyOperation('adicionar item'), classifyOperation('remover item')) === false, 'adicionar×remover → create×remove, resolvido');
    const unresolvedDirectionPairs: Array<[string, string]> = [
        ['importar dados', 'exportar dados'],
        ['compactar arquivo', 'descompactar arquivo'],
        ['iniciar serviço', 'parar serviço'],
        ['habilitar recurso', 'desabilitar recurso'],
        ['conectar dispositivo', 'desconectar dispositivo'],
        ['bloquear usuário', 'desbloquear usuário'],
    ];
    for (const [a, b] of unresolvedDirectionPairs) {
        const compat = operationalCompatibility(classifyOperation(a), classifyOperation(b));
        assert(compat === 'unknown', `NÃO GENERALIZADO (achado central, não corrigido): "${a}" × "${b}" → ${compat} (seguro — não vira compatible=true por engano — mas não modela a direção real)`);
    }

    // ══════════ Fase 1 — Overfitting: maioria do léxico NUNCA aparece em nenhum fixture ══════════
    console.log('\n=== S26.8 — Overfitting: verbos fora de qualquer fixture ainda classificam corretamente (evidência CONTRA fixture encoding) ===');
    assert(classifyOperation('inspecionar o servidor') === 'inspect', '"inspecionar" nunca aparece em nenhum teste/fixture existente — classifica corretamente pela família, não por memorização de string');
    assert(classifyOperation('checar a configuração') === 'inspect', '"checar" idem — zero cobertura em fixture, classificação correta');
    assert(classifyOperation('desenvolver um script') === 'create', '"desenvolver" idem — zero cobertura em fixture, classificação correta');

    // ══════════ Fase 12 — Ordem dos sinais: gate operacional nunca promove candidato sozinho ══════════
    console.log('\n=== S26.9 — Ordem dos sinais: candidate generation semântica ANTES do gate operacional (não o contrário) ===');
    assert(
        /findApplicableCasesShadow[\s\S]{0,200}await this\.findRelevantCasesShadow/.test(caseMemorySrc),
        'findApplicableCasesShadow() chama findRelevantCasesShadow() PRIMEIRO — o gate operacional só anota candidatos que a busca SEMÂNTICA já selecionou, nunca gera candidatos por conta própria'
    );
    assert(!caseMemorySrc.includes('finalScore'), 'nenhum score final combinado foi introduzido — semanticScore e operationalCompatibility continuam campos separados no retorno');
    console.log('  ℹ️  RISCO ARQUITETURAL PARA O FUTURO (não é bug hoje): como não há threshold de produção, um candidato com semanticScore BAIXO ainda pode ter operationalCompatibility=true (mesma classe, tema totalmente diferente — ver Grupo M). Nenhum consumidor hoje usa isso sozinho (shadow mode), mas qualquer Sprint futura de "Controlled Case Influence" DEVE exigir score semântico suficiente E compatibility===true — nunca compatibility sozinho.');

    // ══════════ Fase 13 — Ativação (RFC-002, 24/07): reconfirmado por inspeção direta ══════════
    // Este bloco originalmente reconfirmava modo sombra (não confiar no relatório da S7). RFC-002
    // ativou de propósito o Applicability Gate como consumidor real em GoalPlanner.plan() — e é
    // exatamente por causa do risco que ESTE arquivo (S26) nomeou ("compatibility sozinho não
    // basta") que buildCaseEvidenceHint() exige também MIN_SEMANTIC_SCORE_FOR_EVIDENCE — ver S144.
    console.log('\n=== S26.10 — GoalPlanner ativado via buildCaseEvidenceHint(); RiskAnalyzer permanece sem CaseMemory; gate de score do achado S26 aplicado ===');
    assert(plannerSrc.includes('CaseMemory') && plannerSrc.includes('buildCaseEvidenceHint'), 'GoalPlanner.ts referencia CaseMemory via buildCaseEvidenceHint (RFC-002 — antes desta RFC, zero referência)');
    assert(!riskSrc.includes('CaseMemory'), 'RiskAnalyzer.ts: zero referência a CaseMemory — RFC-002 não estendeu a ativação até ali');
    assert(caseMemorySrc.includes('MIN_SEMANTIC_SCORE_FOR_EVIDENCE'), 'CaseMemory.ts aplica o gate de score semântico que este arquivo (S26) exigiu antes de qualquer consumidor real existir — compatibility===true sozinho não basta');
    assert(
        orchestratorSrc.includes("import { CaseMemory } from '../memory/CaseMemory'") &&
        /const caseMemory = new CaseMemory\(memory\)/.test(orchestratorSrc),
        'GoalOrchestrator.ts referencia CaseMemory APENAS como composition root (instancia e injeta) — não é decisão comportamental, é wiring de dependência'
    );

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S26 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    if (failed > 0) process.exit(1);
}

main().catch(err => { console.error('ERRO NÃO TRATADO:', err); process.exit(1); });
