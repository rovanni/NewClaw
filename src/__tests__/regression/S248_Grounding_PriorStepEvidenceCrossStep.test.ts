/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S248
 * ADR-010 (C1, barreira de groundedness): o juiz de groundedness recebe também evidência REAL de
 * steps ANTERIORES do MESMO goal (mesma planGeneration) — não só o ExecutionTrace do turno/ciclo
 * atual — para não bloquear afirmações que reaproveitam legitimamente um fato já obtido antes.
 *
 * INCIDENTE REAL (newclaw-audit.log, 17/08/2026, goal_1786990038154_2uh8m, sessão
 * web:conv_1786989272694, "Qual o valor do river em reais?"): o goal anterior na mesma conversa
 * (goal_1786989885813_kik5n) já tinha obtido e confirmado o preço da River ($2,69). O passo
 * seguinte instruía explicitamente "multiplicando o preço em USD (2.69) pela cotação do dólar
 * obtida no step_1" — reaproveitando o valor em vez de re-consultar a API à toa (decisão legítima
 * de custo, autoridade do Planner). O AgentLoop chamou `web_search` (só para o dólar) e produziu
 * a afirmação "Preço atual da River (RIVER): US$ 2,69" — correta, mas SEM evidência dela no
 * ExecutionTrace do ciclo atual, porque o valor vinha de um step anterior/memória, não desta
 * chamada de ferramenta. `ObserverValidator.validateGrounding()` classificou como NOT_EVALUABLE e
 * bloqueou a entrega. Resultado: 4 replans, 12 ciclos, ~280s, `success=false`, nenhuma resposta
 * útil ao usuário — apesar do valor reaproveitado ser real e correto.
 *
 * QUESTIONÁRIO (docs/ARCHITECTURE/RESPONSABILIDADE_ANTES_DO_MECANISMO.md, obrigatório para
 * qualquer mudança em avaliação/grounding): a pergunta ("esta afirmação é sustentada?") e o
 * responsável (ObserverValidator/juiz LLM) já estavam corretos — groundedness é semântica, LLM é
 * o mecanismo certo (ver a própria tabela do documento). O que faltava era EVIDÊNCIA: o
 * componente responsável não recebia o dado que responderia à pergunta. Pela "Regra de
 * evidência" do documento, a correção é no FLUXO DE INFORMAÇÃO, não um segundo avaliador nem uma
 * reformulação do prompt para "confiar sem evidência" (isso reabriria o buraco que a barreira de
 * groundedness existe para fechar).
 *
 * FIX: `ChannelContext.priorStepEvidence` (agentLoopTypes.ts) — populado por
 * `GoalExecutionLoop.dispatchAgentloopStep()` a partir de `goal.attempts` REAIS
 * (result==='success', mesma planGeneration, excluindo o próprio step atual) — nunca invenção,
 * mesma fonte de verdade que `resolveArtifactPathFromEvidence()` já usa. `AgentLoop.commitResponse()`
 * mescla isso ao `ExecutionTrace` do turno atual antes de chamar `validateGrounding()`, renumerando
 * os ids sequencialmente para não colidir com os do trace.
 *
 * REGRESSÃO SE: priorStepEvidence deixar de ser populado/mesclado, ou goal.attempts de OUTRA
 * planGeneration (estratégia abandonada) voltar a ser incluído como evidência.
 *
 * Execução: npx ts-node src/__tests__/regression/S248_Grounding_PriorStepEvidenceCrossStep.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { EvidenceItem } from '../../loop/ObserverValidator';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

interface MockAttempt {
    planStepId: string;
    toolName: string;
    args?: Record<string, unknown>;
    result: 'success' | 'partial' | 'failure';
    output?: string;
    planGeneration?: number;
}

/** Réplica exata do bloco de GoalExecutionLoop.dispatchAgentloopStep() que monta priorStepEvidence. */
function buildPriorStepEvidence(
    attempts: MockAttempt[],
    currentGeneration: number,
    currentStepId: string,
): EvidenceItem[] {
    return attempts
        .filter(a => a.result === 'success'
            && (a.planGeneration ?? 0) === currentGeneration
            && a.planStepId !== currentStepId
            && a.output)
        .map((a, i) => ({
            id: `G${i + 1}`,
            tool: a.toolName,
            input: (() => { try { return JSON.stringify(a.args ?? {}); } catch { return undefined; } })(),
            output: a.output ?? '',
        }));
}

/** Réplica exata do merge+renumeração em AgentLoop.commitResponse(). */
function mergeAndRenumber(traceEvidences: EvidenceItem[], priorStepEvidence: EvidenceItem[]): EvidenceItem[] {
    return [...traceEvidences, ...priorStepEvidence].map((e, i) => ({ ...e, id: `E${i + 1}` }));
}

console.log('\n=== S248 — Cenário 1: reproduz goal_1786990038154_2uh8m ===');
{
    // goal.attempts reais do goal anterior (kik5n) reaproveitados pelo planGeneration atual —
    // simulando o cenário em que o step que produziu o preço faz parte do MESMO goal (mesma
    // generation), não de um goal anterior na conversa (esse caso cross-goal é coberto pelo
    // SessionManager.deliveredArtifacts já existente — fora do escopo deste fix).
    const attempts: MockAttempt[] = [
        {
            planStepId: 'step_1', toolName: 'agentloop', result: 'success', planGeneration: 0,
            output: 'Aqui está o valor atual da River (RIVER) 🪙\n💰 Preço atual: $2,69\n📊 Market Cap: $52,75M',
        },
        {
            planStepId: 'step_2', toolName: 'memory_write', result: 'success', planGeneration: 0,
            args: { content: 'Preço atual da criptomoeda River obtido no step_1.' },
            output: '✅ Nó "river_preco_atual" atualizado.',
        },
    ];

    const priorEvidence = buildPriorStepEvidence(attempts, 0, 'step_3');
    assert(priorEvidence.length === 2, `2 attempts anteriores viram evidência (obtido: ${priorEvidence.length})`, priorEvidence);
    assert(
        priorEvidence.some(e => e.tool === 'agentloop' && e.output.includes('$2,69')),
        'a evidência inclui o preço real da River ($2,69) do step_1 (agentloop)',
    );

    // Evidência do ExecutionTrace do ciclo ATUAL — só a cotação do dólar, sem menção à River.
    const traceEvidence: EvidenceItem[] = [
        { id: 'E1', tool: 'web_search', input: '{"query":"cotação dólar hoje BRL"}', output: 'USD/BRL: R$ 5,09' },
    ];

    const merged = mergeAndRenumber(traceEvidence, priorEvidence);
    assert(merged.length === 3, `evidência mesclada tem 3 itens (1 do trace + 2 anteriores) (obtido: ${merged.length})`);
    assert(
        merged.some(e => e.output.includes('$2,69')),
        'SEM o fix, o juiz nunca veria o preço da River — COM o fix, a evidência mesclada o inclui',
    );

    // Sem ids duplicados após a renumeração (E1 do trace e G1/G2 do priorStepEvidence colidiriam
    // antes da renumeração — este é o motivo de renumerar).
    const ids = merged.map(e => e.id);
    assert(new Set(ids).size === ids.length, 'nenhum id duplicado após o merge+renumeração', ids);
    assert(JSON.stringify(ids) === JSON.stringify(['E1', 'E2', 'E3']), 'ids sequenciais E1..E3, sem gaps', ids);
}

console.log('\n=== S248 — Cenário 2: attempts de OUTRA planGeneration não entram (replan descarta estratégia antiga) ===');
{
    const attempts: MockAttempt[] = [
        { planStepId: 'step_1', toolName: 'agentloop', result: 'success', planGeneration: 0, output: 'Estratégia abandonada — preço antigo: $3,10' },
        { planStepId: 'step_1', toolName: 'agentloop', result: 'success', planGeneration: 1, output: 'Estratégia vigente — preço atual: $2,69' },
    ];
    const priorEvidence = buildPriorStepEvidence(attempts, 1, 'step_2');
    assert(priorEvidence.length === 1, `só o attempt da planGeneration vigente (1) entra (obtido: ${priorEvidence.length})`, priorEvidence);
    assert(priorEvidence[0].output.includes('$2,69'), 'é o valor da estratégia VIGENTE, não da abandonada');
}

console.log('\n=== S248 — Cenário 3: attempts partial/failure não entram (só fato confirmado) ===');
{
    const attempts: MockAttempt[] = [
        { planStepId: 'step_1', toolName: 'agentloop', result: 'partial', planGeneration: 0, output: 'Tentativa incompleta' },
        { planStepId: 'step_1', toolName: 'agentloop', result: 'failure', planGeneration: 0, output: 'Erro na consulta' },
    ];
    const priorEvidence = buildPriorStepEvidence(attempts, 0, 'step_2');
    assert(priorEvidence.length === 0, 'attempts partial/failure nunca viram evidência — só result==="success" (Regra de evidência: nunca invenção)', priorEvidence);
}

console.log('\n=== S248 — Cenário 4: sem prior evidence, comportamento antigo preservado (sem regressão) ===');
{
    const traceEvidence: EvidenceItem[] = [
        { id: 'E1', tool: 'weather', output: 'Cornélio Procópio: 30°C, céu limpo' },
    ];
    const merged = mergeAndRenumber(traceEvidence, []);
    assert(merged.length === 1 && merged[0].id === 'E1', 'sem priorStepEvidence, o merge é um no-op — mesmo resultado de antes', merged);
}

console.log('\n=== S248 — presença estrutural do fix no source ===');
{
    const typesSource = fs.readFileSync(path.join(process.cwd(), 'src', 'loop', 'agentLoopTypes.ts'), 'utf-8');
    const loopSource = fs.readFileSync(path.join(process.cwd(), 'src', 'loop', 'GoalExecutionLoop.ts'), 'utf-8');
    const agentSource = fs.readFileSync(path.join(process.cwd(), 'src', 'loop', 'AgentLoop.ts'), 'utf-8');

    assert(/priorStepEvidence\?: EvidenceItem\[\];/.test(typesSource), 'ChannelContext declara priorStepEvidence (agentLoopTypes.ts)');
    assert(
        /a\.result === 'success'\s*\n\s*&& \(a\.planGeneration \?\? 0\) === currentGeneration\s*\n\s*&& a\.planStepId !== step\.id/.test(loopSource),
        'GoalExecutionLoop filtra por result=success + mesma planGeneration + exclui o step atual',
    );
    assert(
        /priorStepEvidence,\s*\n\s*deliveryTracking: \{/.test(loopSource),
        'priorStepEvidence é passado no goalChannelContext ao lado de deliveryTracking',
    );
    assert(
        /const evidences = \[\.\.\.AgentLoop\.evidencesFromTrace\(trace\), \.\.\.\(channelContext\?\.priorStepEvidence \?\? \[\]\)\]/.test(agentSource),
        'AgentLoop.commitResponse mescla evidencesFromTrace + priorStepEvidence',
    );
    const callSitesComContext = (agentSource.match(/this\.commitResponse\([^)]*channelContext\)/g) ?? []).length;
    assert(callSitesComContext === 6, `os 6 call sites de commitResponse passam channelContext (encontrados: ${callSitesComContext})`);
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S248 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
console.log(`\nCOBERTURA:`);
console.log(`  Reprodução do incidente real (goal_1786990038154_2uh8m): simulado`);
console.log(`  Isolamento por planGeneration (replan não vaza estratégia abandonada): testado`);
console.log(`  Só result='success' vira evidência (nunca invenção): testado`);
console.log(`  Sem prior evidence, comportamento antigo preservado: testado`);
console.log(`  Fix presente estruturalmente nos 3 arquivos: testado`);
if (failed > 0) process.exit(1);
