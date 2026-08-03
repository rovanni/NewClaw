/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S186 (Sprint 7)
 * O orçamento de chamadas LLM auxiliares vem da latência observada do provedor, não de um
 * número fixo em milissegundos.
 *
 * CONTEXTO (relato do operador — "o tempo de resposta para o modelo local está muito pequeno" —
 * confirmado em logs/newclaw-audit.log, 03/08/2026):
 *
 *     05:03:06  FAILED This operation was aborted duration=6010ms    ← classificador de domínio
 *     05:03:23  FAILED This operation was aborted duration=17722ms   ← extrator de goal
 *     05:05:30  FAILED This operation was aborted duration=6009ms
 *     05:05:48  FAILED This operation was aborted duration=18226ms
 *
 * Dois abortos por turno, em TODOS os turnos. E a medida que fecha o caso:
 *
 *     [GOAL-EXTRACTOR] model=glm-5.2:cloud  latencyMs=1329
 *     [GOAL-EXTRACTOR] model=default        latencyMs=18030     (.gguf local, mesma máquina)
 *
 * 14× de diferença para a MESMA chamada. Os tetos eram 6s e 15s — calibrados observando
 * modelos de nuvem. Nada quebrava de forma visível (esses caminhos falham abertos e caem em
 * heurística); o custo era ~21s por turno gastos em chamadas destinadas a falhar, classificação
 * degradada e log poluído.
 *
 * POR QUE NÃO SÓ AUMENTAR OS NÚMEROS: `shared/dynamicTimeout.ts` documenta essa mesma lição,
 * aprendida antes com o GoalPlanner — valores fixos foram trocados por uma função de escala
 * porque "a mesma classe de bug reapareceria assim que o contexto crescesse de novo". Aqui o
 * eixo é outro (velocidade do provedor, não tamanho do prompt), mas a lição é a mesma.
 *
 * ESCOPO DELIBERADO: só os DOIS pontos com evidência de abort no log. Os outros cinco tetos
 * fixos (8s, 12s, 30s, 45s, e o 6s do contentStubClassifier) não aparecem falhando e não foram
 * tocados — mexer neles seria alterar cinco comportamentos sem evidência.
 *
 * REGRESSÃO SE: um dos dois pontos voltar a usar número fixo; se a latência medida deixar de
 * alimentar o cálculo; ou se um provedor sem histórico passar a receber um número inventado em
 * vez do padrão do perfil.
 *
 * Execução: npx ts-node src/__tests__/regression/S186_AuxTimeout_ScalesWithProviderLatency.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { getBudgetAuxiliar } from '../../shared/auxTimeout';
import { CircuitBreaker } from '../../core/CircuitBreaker';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

const fonteFixa = (ms: number | null) => ({ getLatenciaTipicaMs: () => ms });

console.log('\n=== S186-1 — reproduz o incidente: modelo local deixa de abortar ===');
{
    // Latência típica medida no incidente: ~18s por classificação.
    const orc = getBudgetAuxiliar('classificacao', 'Modelo local', fonteFixa(18_030));
    assert(orc.origem === 'medido', 'o orçamento vem de medição, não do padrão');
    assert(
        orc.timeoutMs > 18_030,
        `o orçamento (${orc.timeoutMs}ms) supera a latência típica (18030ms) — antes eram 15000ms e abortava`,
        orc.timeoutMs,
    );
    assert(orc.timeoutMs <= 60_000, 'e continua com teto — não espera indefinidamente', orc.timeoutMs);
}

console.log('\n=== S186-2 — modelo de nuvem não fica mais lento por causa disso ===');
{
    // 1329ms foi a latência medida com glm-5.2:cloud.
    const orc = getBudgetAuxiliar('classificacao', 'ollama', fonteFixa(1_329));
    assert(
        orc.timeoutMs <= 15_000,
        `provedor rápido recebe orçamento pequeno (${orc.timeoutMs}ms) — desiste cedo quando algo trava`,
        orc.timeoutMs,
    );
    assert(orc.timeoutMs >= 6_000, 'mas nunca abaixo do piso do perfil', orc.timeoutMs);
}

console.log('\n=== S186-3 — sem medição, devolve o PADRÃO e diz que é padrão ===');
{
    // "Nunca Adivinhar": sem histórico não se inventa um número a partir de nada.
    const semHistorico = getBudgetAuxiliar('classificacao', 'provedor-novo', fonteFixa(null));
    assert(semHistorico.origem === 'padrao', 'a origem é reportada como padrão');
    assert(semHistorico.latenciaTipicaMs === null, 'e a latência é explicitamente nula');
    assert(semHistorico.timeoutMs === 15_000, 'padrão do perfil de classificação', semHistorico.timeoutMs);

    const semFonte = getBudgetAuxiliar('classificacao', 'x', null);
    assert(semFonte.origem === 'padrao', 'sem fonte de latência, idem');

    const semProvedor = getBudgetAuxiliar('classificacao', null, fonteFixa(9999));
    assert(semProvedor.origem === 'padrao', 'sem provedor identificado, idem');
}

console.log('\n=== S186-4 — valores absurdos não viram orçamento absurdo ===');
{
    const lento = getBudgetAuxiliar('classificacao', 'p', fonteFixa(10 * 60_000));
    assert(lento.timeoutMs === 60_000, 'provedor patologicamente lento bate no teto', lento.timeoutMs);

    for (const invalido of [0, -1, NaN, Infinity]) {
        const r = getBudgetAuxiliar('classificacao', 'p', fonteFixa(invalido));
        assert(r.origem === 'padrao', `latência inválida (${invalido}) cai no padrão`, r);
    }
}

console.log('\n=== S186-5 — o perfil de validação é mais tolerante que o de classificação ===');
{
    const c = getBudgetAuxiliar('classificacao', 'p', fonteFixa(10_000));
    const v = getBudgetAuxiliar('validacao', 'p', fonteFixa(10_000));
    assert(v.timeoutMs > c.timeoutMs, 'validação tolera mais que classificação para a mesma latência', { c: c.timeoutMs, v: v.timeoutMs });
    assert(
        getBudgetAuxiliar('validacao', 'p', fonteFixa(null)).timeoutMs === 45_000,
        'e seu padrão preserva o valor que já era usado nas validações',
    );
}

console.log('\n=== S186-6 — a latência é de fato medida, com média móvel ===');
{
    const cb = new CircuitBreaker({ name: 's186' });
    assert(cb.getLatenciaTipicaMs() === null, 'começa sem medição');

    cb.recordSuccess(1_000);
    assert(cb.getLatenciaTipicaMs() === 1_000, 'a primeira amostra vira a média', cb.getLatenciaTipicaMs());

    cb.recordSuccess(2_000);
    const depois = cb.getLatenciaTipicaMs()!;
    assert(depois > 1_000 && depois < 2_000, 'média móvel: nem ignora a nova amostra, nem é dominada por ela', depois);

    // Um pico isolado não pode explodir o orçamento de todo mundo.
    const antesDoPico = cb.getLatenciaTipicaMs()!;
    cb.recordSuccess(120_000);
    assert(cb.getLatenciaTipicaMs()! < antesDoPico + 40_000, 'um pico é amortecido pelo peso da amostra', cb.getLatenciaTipicaMs());

    // Chamador que não informa duração não corrompe a média.
    const estavel = cb.getLatenciaTipicaMs();
    cb.recordSuccess();
    assert(cb.getLatenciaTipicaMs() === estavel, 'recordSuccess() sem duração não altera a média');
}

console.log('\n=== S186-7 — os dois pontos com evidência usam o orçamento medido ===');
{
    const extractor = fs.readFileSync(path.join(process.cwd(), 'src', 'loop', 'GoalExtractor.ts'), 'utf-8');
    const domain = fs.readFileSync(path.join(process.cwd(), 'src', 'memory', 'DomainRegistry.ts'), 'utf-8');
    const factory = fs.readFileSync(path.join(process.cwd(), 'src', 'core', 'ProviderFactory.ts'), 'utf-8');

    assert(
        /const orcamento = this\.providerFactory\.getBudgetAuxiliar\('classificacao'\);/.test(extractor),
        'GoalExtractor pede o orçamento em vez de usar constante',
    );
    assert(!/GOAL_EXTRACTOR_TIMEOUT_MS/.test(extractor), 'a constante fixa de 15s não existe mais');

    assert(
        /const orcamento = providerFactory\.getBudgetAuxiliar\('classificacao'\);/.test(domain),
        'DomainRegistry idem',
    );
    assert(!/DOMAIN_CLASSIFIER_TIMEOUT_MS/.test(domain), 'a constante fixa de 6s não existe mais');

    assert(
        /\.recordSuccess\(duration\);/.test(factory),
        'a duração já calculada passa a alimentar a medição, em vez de só ir para o log',
    );
}

console.log('\n=== S186-8 — os cinco tetos SEM evidência não foram tocados ===');
{
    // Regra 6 do operador: só corrigir com evidência concreta. Nenhum destes aparece abortando
    // no log, então continuam como estavam — e este teste trava isso para não virar
    // refatoração oportunista numa próxima passagem.
    const intactos: Array<[string, string, RegExp]> = [
        ['StepSemanticValidator', 'src/loop/StepSemanticValidator.ts', /const TIMEOUT_MS = 8_000;/],
        ['AgentLoop (commit)', 'src/loop/AgentLoop.ts', /const COMMIT_TIMEOUT_MS = 12_000;/],
        ['contentStubClassifier', 'src/shared/contentStubClassifier.ts', /const TIMEOUT_MS = 6_000;/],
    ];
    for (const [nome, arquivo, padrao] of intactos) {
        const src = fs.readFileSync(path.join(process.cwd(), arquivo), 'utf-8');
        assert(padrao.test(src), `${nome} permanece com seu teto fixo — sem evidência, sem mudança`);
    }
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S186 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
console.log(`\nCOBERTURA:`);
console.log(`  Incidente do modelo local resolvido: testado`);
console.log(`  Provedor rápido não fica mais lento: testado`);
console.log(`  Sem medição, padrão explícito: testado`);
console.log(`  Tetos e pisos respeitados: testado`);
console.log(`  Média móvel amortecendo picos: testado`);
console.log(`  Escopo limitado aos 2 pontos com evidência: testado`);
if (failed > 0) process.exit(1);
