/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S394: o que o juiz de grounding encontrou chega a quem corrige (correção dirigida).
 *
 * Produção, Windows, 12/10/2026 (goal "E meus e-mails alguma novidade?", 34 min, abandonado): o agente achou a resposta em 1 min 44 s,
 * mas converteu de cabeça os horários dos cabeçalhos Date (01:55 +0000 virou "12/10 às 3h55"; o certo é 22:55 de 11/10 no fuso do
 * usuário). O juiz contradisse com o trecho literal da fonte — e esse trecho se perdia no caminho: o retry e a reescrita parcial só
 * recebiam a frase errada, refaziam a conta e erravam de novo, até o replanejamento. Reprodução (7 execuções do mesmo julgamento):
 * o juiz gasta o raciocínio refazendo cada conversão de fuso; dividir a conferência em partes NÃO reduziu o tempo (6 de 6 travaram).
 * Nas reprovações gravadas no Windows, 77% eram relatos do agente que a saída da ferramenta não mostrava e 13% datas/horários.
 *
 * REGRESSÃO SE: o trecho citado pelo juiz deixar de chegar ao aviso do retry ou à reescrita parcial; a reescrita deixar de poder copiar
 * o valor literal da fonte; ou o prompt do agente perder a orientação de apresentar os dados como as ferramentas mostraram.
 *
 * Execução: npx ts-node src/__tests__/regression/S394_Grounding_CorrecaoDirigidaPeloTrecho.test.ts
 */
import { adaptarGrounding } from '../../validation/tipos/saidaContraEvidencia';
import { GoalExecutionLoop } from '../../loop/GoalExecutionLoop';
import { AgentLoop } from '../../loop/AgentLoop';
import { buildSystemPrompt } from '../../core/agentControllerSetup';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

const TRECHO = 'Date: Mon, 12 Oct 2026 01:55:43 +0000';
const ERRADA = 'Horário do convite do LinkedIn: 12/10 às 3h55';

async function main(): Promise<void> {

console.log('\n=== S394-1 — o adaptador do juiz preserva o trecho citado ===');
{
    const d = adaptarGrounding({
        estado: 'reprovado', itens: [
            { item: ERRADA, confere: 'nao', evidencia: 'E3', trecho: TRECHO },
            { item: 'Assunto do e-mail do GitHub', confere: 'sim', evidencia: 'E3', trecho: 'Run failed: regressao - main' },
            { item: 'sem trecho', confere: 'sem_evidencia', evidencia: '' },
        ], confianca: 0.9, motivo: '',
    } as never);
    assert(d.claims[0].trecho === TRECHO && d.claims[0].verdict === 'NOT_SUPPORTED', 'afirmação contradita leva o trecho da fonte', d.claims[0]);
    assert(d.claims[2].trecho === undefined, 'sem trecho, nada é inventado');
}

console.log('\n=== S394-2 — o aviso do retry do passo traz o valor da fonte e a orientação de não converter ===');
{
    let plano: Array<{ id: string; description: string }> | null = null;
    const falso = {
        recordFailedAttempt: () => undefined,
        goalStore: { update: (_id: string, patch: { currentPlan: Array<{ id: string; description: string }> }) => { plano = patch.currentPlan; } },
    };
    const goal = { id: 'g394', retryBudget: 2, replanBudget: 2, expiresAt: Date.now() + 60_000, currentPlan: [{ id: 's1', description: 'Listar e-mails e resumir' }] };
    const r = (GoalExecutionLoop.prototype as unknown as { handleGroundingBlock: (...a: unknown[]) => { outcome: string; blocker: { description: string } } })
        .handleGroundingBlock.call(falso, goal, goal.currentPlan[0], 1, Date.now(), {
            state: 'REJECTED', unconfirmedClaims: [{ claim: ERRADA, verdict: 'NOT_SUPPORTED', trecho: TRECHO }],
        });
    const desc = (plano as Array<{ id: string; description: string }> | null)?.[0]?.description ?? '';
    assert(r.outcome === 'partial', 'primeira recusa: o passo é repetido (não vai direto ao replanejamento)', r.outcome);
    assert(desc.includes(`na fonte: "${TRECHO}"`), 'o aviso do retry cita o trecho literal da fonte', desc.slice(0, 300));
    assert(/conversão de fuso, unidade, conta ou contagem só com uma ferramenta/.test(desc), 'o aviso orienta a não converter de cabeça', desc.slice(-250));
    assert(r.blocker.description.includes(TRECHO), 'o bloqueio registrado (que vai ao replanejamento) também leva o trecho');
}

console.log('\n=== S394-3 — a reescrita parcial recebe o trecho e pode copiar o valor literal ===');
{
    let pedido = '';
    const falso = {
        profileRegistry: { getProfileByCategory: () => ({ id: 'execution' }) },
        callLLMWithFallback: async (msgs: Array<{ content: string }>) => { pedido = msgs[0].content; return { status: 'success', content: 'INSUFICIENTE' }; },
        observer: { validateGrounding: async () => ({ state: 'VALIDATED' }) },
        ts: () => '00:00:00',
    };
    const r = await (AgentLoop.prototype as unknown as { trySynthesizePartialResponse: (...a: unknown[]) => Promise<string | null> })
        .trySynthesizePartialResponse.call(falso, 'E meus e-mails?', [{ claim: 'Há um e-mail do GitHub', verdict: 'SUPPORTED', evidence: ['E3'] }], [], undefined, undefined,
            [{ claim: ERRADA, verdict: 'NOT_SUPPORTED', trecho: TRECHO }]);
    assert(r === null, 'o modelo simulado respondeu INSUFICIENTE → nada entregue (comportamento preservado)');
    assert(pedido.includes(`na fonte: "${TRECHO}"`), 'a reescrita recebe o trecho da fonte para o ponto contradito', pedido.slice(0, 200));
    assert(/exatamente como aparece nesse trecho — copiado, sem converter fuso/.test(pedido), 'pode informar o valor copiado da fonte, sem converter nem deduzir');
}

console.log('\n=== S394-4 — o prompt do agente orienta a apresentar os dados como as ferramentas mostraram ===');
{
    const p = buildSystemPrompt({ getSkillSummaries: () => '' } as never);
    assert(p.includes('DADOS DAS FERRAMENTAS — COMO APRESENTAR'), 'seção presente');
    assert(/só quando a saída da ferramenta mostrar isso/.test(p), '"deu certo" só quando a saída mostra (77% das reprovações)');
    assert(/Conversão de fuso horário, moeda ou unidade, conta e contagem: calcule com uma ferramenta/.test(p) && /mostre o valor original/.test(p), 'conversões e contas com ferramenta, mostrando o original (13%)');
    assert(/só com fonte que o defina/.test(p), 'interpretação de símbolo/campo só com fonte');
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S394 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;
}

main().catch(e => { console.error(e); process.exit(1); });
