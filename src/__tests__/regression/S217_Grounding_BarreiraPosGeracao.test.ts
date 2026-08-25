/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S217
 * Barreira pós-geração de C1 (ADR-010, commit b88af4a).
 *
 * O caminho que este teste existe para eliminar, observado em execução real:
 *
 *     tool_result:  Nublado | 24.9°C | Umidade: 74%
 *     resposta:     Sol com algumas nuvens | 24–31°C | 70% | sem chuva
 *     → entregue ao usuário
 *
 * Quatro números alterados ou inventados, com o dado real no contexto. E o incidente anterior
 * (River, 08/08/2026): crypto_analysis devolveu $2,80, o usuário recebeu $0,7834.
 *
 * Por que nada barrava: `KNOWN_GOOD_TOOLS` aprova por FORMA — verifica que o output tem o
 * aspecto esperado e que a resposta tem comprimento mínimo, nunca compara os dois. Aplicada aos
 * casos de falsificação, aprovou 7 de 7.
 *
 * O que a ADR-010 decidiu e este teste trava:
 *   - validação semântica por LLM Judge, NUNCA regex/regra por ferramenta;
 *   - SUPPORTED só por determinação positiva — ausência de contradição não é suporte;
 *   - NOT_SUPPORTED quando a evidência determina falsidade; NOT_EVALUABLE quando não determina;
 *   - timeout/erro/saída inválida → UNVALIDATED, jamais aprovação;
 *   - fail-closed: só VALIDATED e NOT_APPLICABLE autorizam entrega.
 *
 * Os vereditos do juiz são MOCKADOS aqui. O teste cobre o contrato determinístico — agregação,
 * validação estrutural, política de entrega — não a qualidade semântica do modelo, que depende
 * de LLM real e está registrada na ADR como resultado experimental (3 falsos VALIDATED
 * observados em 136 julgamentos, E6+E8). Testar semântica com LLM real aqui produziria um teste
 * dependente de latência e de modelo, exatamente o que a orientação da Sprint proíbe.
 *
 * Escopo tocado: loop/ObserverValidator.ts (tipos + validateGrounding + agregação + parse),
 * loop/AgentLoop.ts (evidencesFromTrace + gate em commitResponse + propagação do trace).
 * `ResponseCommit` NÃO foi alterado — o contrato de alucinação de ação segue intacto.
 *
 * Execução: npx ts-node src/__tests__/regression/S217_Grounding_BarreiraPosGeracao.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { ObserverValidator, GroundedClaim, EvidenceItem } from '../../loop/ObserverValidator';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

const EVID: EvidenceItem[] = [
    { id: 'E1', tool: 'x', output: 'Nublado | 24.9°C | Umidade: 74%' },
    { id: 'E2', tool: 'y', output: 'A = 10\nB = 20' },
];

/**
 * ProviderFactory falso: devolve o conteúdo pedido e um orçamento real do mecanismo existente.
 *
 * Mocka chatWithFallback (não mais getProviderWithModel().chat() direto) — achado ao vivo
 * (2026-08-24) trocou o mecanismo de validateGrounding()/validate() pelo mesmo usado por
 * GoalPlanner.callPlannerLLM() desde S222 (chatWithFallback, com resiliência multi-provider), então
 * o fake precisa responder pela mesma interface real que o código agora chama.
 */
function fakeFactory(conteudo: string | (() => never)) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getBudgetAuxiliar } = require('../../shared/auxTimeout');
    return {
        chatWithFallback: async () => {
            if (typeof conteudo === 'function') conteudo();
            return { status: 'success', content: conteudo as string, attempts: [] };
        },
        getBudgetAuxiliar: (perfil: 'classificacao' | 'validacao') => getBudgetAuxiliar(perfil, null, null),
    } as unknown as import('../../core/ProviderFactory').ProviderFactory;
}

const judge = (conteudo: string | (() => never)) => new ObserverValidator(fakeFactory(conteudo), 'modelo-de-teste');

/**
 * Variante que REGISTRA o prompt entregue ao juiz. Necessária para provar duas coisas que não
 * aparecem no veredito: que a resposta chegou inteira, e que a evidência chegou literal.
 */
function capturador(conteudo: string) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getBudgetAuxiliar } = require('../../shared/auxTimeout');
    const prompts: string[] = [];
    const factory = {
        chatWithFallback: async (msgs: Array<{ content: string }>) => {
            prompts.push(msgs[0].content);
            return { status: 'success', content: conteudo, attempts: [] };
        },
        getBudgetAuxiliar: (perfil: 'classificacao' | 'validacao') => getBudgetAuxiliar(perfil, null, null),
    } as unknown as import('../../core/ProviderFactory').ProviderFactory;
    return { factory, prompts };
}

const claims = (...cs: Array<[string, GroundedClaim['verdict']]>) =>
    JSON.stringify({ claims: cs.map(([c, v]) => ({ claim: c, evidence: ['E1'], verdict: v })) });

async function main(): Promise<void> {

console.log('\n=== S217-1 — agregação: precedência REJECTED > NOT_EVALUABLE > VALIDATED ===');
{
    const A = ObserverValidator.aggregateGrounding;
    assert(A([]) === 'NOT_APPLICABLE', 'lista vazia → NOT_APPLICABLE (não há afirmação a verificar)', A([]));
    assert(A([{ claim: 'a', evidence: ['E1'], verdict: 'SUPPORTED' }]) === 'VALIDATED', 'todas sustentadas → VALIDATED');
    assert(
        A([{ claim: 'a', evidence: ['E1'], verdict: 'SUPPORTED' }, { claim: 'b', evidence: [], verdict: 'NOT_EVALUABLE' }]) === 'NOT_EVALUABLE',
        'uma indeterminada contamina o conjunto → NOT_EVALUABLE',
    );
    assert(
        A([{ claim: 'a', evidence: [], verdict: 'NOT_EVALUABLE' }, { claim: 'b', evidence: ['E1'], verdict: 'NOT_SUPPORTED' }]) === 'REJECTED',
        'violação demonstrada tem precedência sobre indeterminação → REJECTED',
    );
}

console.log('\n=== S217-2 — o incidente Weather não pode mais ser entregue ===');
{
    // Evidência diz Nublado/24.9°C/74%; a resposta dizia Sol/24–31°C/70%.
    const v = await judge(claims(
        ['O céu está ensolarado', 'NOT_SUPPORTED'],
        ['A umidade é de 70%', 'NOT_SUPPORTED'],
    )).validateGrounding('Sol com algumas nuvens, entre 24 e 31 graus, umidade de 70%.', EVID);
    assert(v.state === 'REJECTED', 'estado é REJECTED', v.state);
    assert(v.state !== 'VALIDATED', 'NÃO autoriza entrega — o caminho do incidente deixa de existir', v.state);
}

console.log('\n=== S217-3 — valor presente com papel errado também bloqueia ===');
{
    // Caso real de 03/08/2026: os valores existem na evidência, o papel atribuído não.
    const v = await judge(claims(['Hoje: mínima 16°C e máxima 25°C', 'NOT_SUPPORTED']))
        .validateGrounding('Hoje: mínima de 16°C e máxima de 25°C.', EVID);
    assert(v.state === 'REJECTED', 'papel errado → REJECTED, ainda que os valores existam', v.state);
}

console.log('\n=== S217-4 — ambiguidade não vira suporte (ausência de contradição ≠ suporte) ===');
{
    const v = await judge(claims(['X está a 25°C', 'NOT_EVALUABLE']))
        .validateGrounding('X está a 25°C.', [{ id: 'E1', tool: 'x', output: 'X: 25' }]);
    assert(v.state === 'NOT_EVALUABLE', 'evidência que não determina → NOT_EVALUABLE', v.state);
    assert(v.state !== 'VALIDATED', 'não autoriza entrega', v.state);
}

console.log('\n=== S217-5 — fato adicional sobre evidência enumerativa bloqueia ===');
{
    const v = await judge(claims(['A = 10', 'SUPPORTED'], ['C = 30', 'NOT_SUPPORTED']))
        .validateGrounding('A = 10 e C = 30.', EVID);
    assert(v.state === 'REJECTED', 'uma afirmação não sustentada basta para bloquear o conjunto', v.state);
}

console.log('\n=== S217-6 — suporte real continua sendo entregue ===');
{
    const v = await judge(claims(['A = 10', 'SUPPORTED'], ['B = 20', 'SUPPORTED']))
        .validateGrounding('A = 10. B = 20.', EVID);
    assert(v.state === 'VALIDATED', 'todas sustentadas → VALIDATED', v.state);
    assert(v.claims.length === 2, 'veredito por afirmação preservado', v.claims);
}

console.log('\n=== S217-7 — sem evidência, C1 não se aplica (≠ aprovado) ===');
{
    const v = await judge(claims(['qualquer', 'SUPPORTED'])).validateGrounding('Olá! Como posso ajudar?', []);
    assert(v.state === 'NOT_APPLICABLE', 'nenhuma ferramenta no turno → NOT_APPLICABLE', v.state);
    assert(v.state !== 'VALIDATED', 'NOT_APPLICABLE é distinto de VALIDATED — não afirma verificação', v.state);
}

console.log('\n=== S217-8 — juiz que não conclui → UNVALIDATED, nunca aprovação ===');
{
    const v = await judge(() => { throw new Error('timeout simulado'); })
        .validateGrounding('A = 10.', EVID);
    assert(v.state === 'UNVALIDATED', 'falha do juiz → UNVALIDATED', v.state);
    assert(v.state !== 'VALIDATED', 'NUNCA aprova por falha — era o comportamento anterior', v.state);
    assert(v.state !== 'REJECTED' && v.state !== 'NOT_EVALUABLE',
        'não vira REJECTED nem NOT_EVALUABLE — não houve conclusão epistemológica', v.state);
}

console.log('\n=== S217-9 — saída estruturalmente inválida → UNVALIDATED ===');
{
    for (const [rotulo, saida] of [
        ['sem JSON',            'não sei responder isso'],
        ['sem campo claims',    '{"resultado":"ok"}'],
        ['claims não é array',  '{"claims":"nenhuma"}'],
        ['verdict inválido',    '{"claims":[{"claim":"a","evidence":["E1"],"verdict":"TALVEZ"}]}'],
        ['claim vazio',         '{"claims":[{"claim":"","evidence":["E1"],"verdict":"SUPPORTED"}]}'],
    ] as Array<[string, string]>) {
        const v = await judge(saida).validateGrounding('A = 10.', EVID);
        assert(v.state === 'UNVALIDATED', `${rotulo} → UNVALIDATED (não se "conserta" saída malformada)`, v.state);
    }
}

console.log('\n=== S217-10 — evidence_id inventado não sustenta SUPPORTED ===');
{
    // O juiz declarar proveniência não prova grounding (ADR-010 §2). Um id inexistente é
    // invenção sobre a própria proveniência — não pode autorizar entrega.
    const v = await judge('{"claims":[{"claim":"A = 10","evidence":["E99"],"verdict":"SUPPORTED"}]}')
        .validateGrounding('A = 10.', EVID);
    assert(v.state !== 'VALIDATED', 'id inexistente não autoriza entrega', v.state);
    assert(v.claims[0]?.verdict === 'NOT_EVALUABLE', 'rebaixado para NOT_EVALUABLE', v.claims);
    assert(v.claims[0]?.evidence.length === 0, 'o id inválido é descartado, não propagado', v.claims);
}

console.log('\n=== S217-11 — orçamento vem de getBudgetAuxiliar, não de constante nova ===');
{
    const v = await judge(claims(['A = 10', 'SUPPORTED'])).validateGrounding('A = 10.', EVID);
    assert(v.budgetMs === 45_000, 'perfil validacao, padrão do mecanismo existente (45s)', v.budgetMs);
    assert(v.budgetOrigin === 'padrao', 'sem medição, declara que é padrão — não inventa número', v.budgetOrigin);

    const src = fs.readFileSync(path.join(__dirname, '../../loop/ObserverValidator.ts'), 'utf-8');
    assert(/getBudgetAuxiliar\('validacao'\)/.test(src), 'usa o perfil decidido na ADR-010 §8');
    assert(!/JUDGE_TIMEOUT_MS|CLAIM_TIMEOUT_MS/.test(src), 'nenhuma constante de timeout nova foi criada');
}

console.log('\n=== S217-12 — a barreira é LLM, não regex; e é fail-closed ===');
{
    const obs = fs.readFileSync(path.join(__dirname, '../../loop/ObserverValidator.ts'), 'utf-8');
    const agent = fs.readFileSync(path.join(__dirname, '../../loop/AgentLoop.ts'), 'utf-8');

    // O corpo de validateGrounding não pode conter heurística sobre o conteúdo. A comparação
    // semântica é do juiz; aqui só há estrutura, agregação e controle (ADR-010 §3).
    const corpo = obs.slice(obs.indexOf('async validateGrounding('), obs.indexOf('private parseGroundingOutput('));
    assert(!/\.includes\(|\.match\(\/|test\(response\)/.test(corpo),
        'validateGrounding não inspeciona o texto da resposta por conta própria');

    assert(/KNOWN_GOOD_TOOLS/.test(obs), 'pré-condição: KNOWN_GOOD_TOOLS ainda existe (contrato de ação, não tocado)');
    const listaKGT = obs.slice(obs.indexOf('const KNOWN_GOOD_TOOLS'), obs.indexOf('export class ObserverValidator'));
    assert(!/GroundingState|validateGrounding/.test(listaKGT),
        'KNOWN_GOOD_TOOLS não participa da decisão de groundedness');

    // Fail-closed no ponto de entrega: só VALIDATED e NOT_APPLICABLE passam.
    assert(/g\.state !== 'VALIDATED' && g\.state !== 'NOT_APPLICABLE'/.test(agent),
        'commitResponse bloqueia todo estado que não seja VALIDATED ou NOT_APPLICABLE');
    assert(/groundingBlockedMessage/.test(agent), 'bloqueio devolve mensagem própria, não a resposta original');
}

console.log('\n=== S217-13 — a resposta chega INTEIRA ao juiz (sem truncamento) ===');
{
    // Preferência 1 da orientação de 09/08/2026: avaliar a resposta completa, mantendo
    // 1 resposta → 1 julgamento → N afirmações. O corte em 4000 chars era decisão de
    // implementação, não da ADR-010 — e produzia veredito sobre prefixo.
    const cap = capturador(claims(['A = 10', 'SUPPORTED']));
    const corpo = 'A = 10. ' + 'texto de enchimento. '.repeat(400);   // ~8k chars, > o antigo teto
    const resposta = `${corpo}FIM_DA_RESPOSTA_MARCA`;
    const v = await new ObserverValidator(cap.factory, 'modelo-de-teste').validateGrounding(resposta, EVID);

    assert(v.state === 'VALIDATED', 'resposta longa e sustentada continua sendo entregue', v.state);
    assert(cap.prompts.length === 1, 'um único julgamento — a granularidade da ADR-010 §6 não mudou', cap.prompts.length);
    assert(cap.prompts[0].includes(resposta), 'o juiz recebeu a resposta inteira, caractere por caractere');
    assert(cap.prompts[0].includes('FIM_DA_RESPOSTA_MARCA'), 'inclusive o trecho que o antigo corte de 4000 descartava');
}

console.log('\n=== S217-14 — resposta que não cabe NÃO é truncada: é UNVALIDATED ===');
{
    // Preferência 2: havendo limite real de contexto, o comportamento seguro é não concluir.
    // Nunca truncar-e-aprovar, nunca NOT_SUPPORTED, nunca NOT_EVALUABLE — o juiz não recebeu
    // a resposta, então não concluiu sobre ela.
    const cap = capturador(claims(['A = 10', 'SUPPORTED']));
    const excedente = 'TRECHO_ALEM_DO_TETO';
    const resposta = 'A = 10. ' + 'x'.repeat(61_000) + excedente;
    const v = await new ObserverValidator(cap.factory, 'modelo-de-teste').validateGrounding(resposta, EVID);

    assert(v.state === 'UNVALIDATED', 'acima do teto → UNVALIDATED', v.state);
    assert(v.state !== 'VALIDATED', 'não autoriza entrega — este é o vazamento fail-open que se fecha aqui', v.state);
    assert(v.state !== 'NOT_SUPPORTED' as never && v.state !== 'NOT_EVALUABLE',
        'não vira veredito epistemológico: não houve julgamento', v.state);
    assert(cap.prompts.length === 0, 'o juiz sequer foi chamado — nenhum prefixo foi avaliado', cap.prompts.length);
    assert(/excede o teto/.test(v.reason), 'o motivo registrado nomeia a causa', v.reason);

    // A propriedade que a orientação pede explicitamente: o texto além do teto nunca chega ao
    // COMMIT tendo sido dado como avaliado.
    assert(!cap.prompts.some(p => p.includes(excedente)), 'o excedente nunca foi julgado');
    const src = fs.readFileSync(path.join(__dirname, '../../loop/ObserverValidator.ts'), 'utf-8');
    assert(!/response\.slice\(/.test(src), 'não existe mais truncamento da resposta no código');
    assert(/GROUNDING_MAX_PROMPT_CHARS/.test(src), 'o teto é uma fronteira nomeada, não um número solto');
}

console.log('\n=== S217-15 — cifrão na evidência chega literal ao juiz ===');
{
    // O caso de origem é monetário: crypto_analysis devolveu `Preço: $2,80`. Numa substituição
    // por string, `$&`, `` $` ``, `$'` e `$$` são padrões — um output de ferramenta contendo
    // `$&` reescreveria o prompt do juiz com o texto casado.
    const especiais = "Preço: $2,80 | $& | $` | $' | $$ | var=$USER";
    const cap = capturador(claims(['O preço é $2,80', 'SUPPORTED']));
    await new ObserverValidator(cap.factory, 'modelo-de-teste')
        .validateGrounding('O preço é $2,80.', [{ id: 'E1', tool: 'crypto_analysis', input: '{"symbol":"$RIVER"}', output: especiais }]);

    assert(cap.prompts.length === 1, 'o juiz foi chamado', cap.prompts.length);
    assert(cap.prompts[0].includes(especiais), 'a evidência aparece literalmente, sem interpretação de $&, $`, $\' ou $$');
    assert(cap.prompts[0].includes('{"symbol":"$RIVER"}'), 'os args também chegam literais');
    assert(!cap.prompts[0].includes('{evidences}') && !cap.prompts[0].includes('{response}'),
        'os dois marcadores foram substituídos — nenhum sobrou por engano');
}

console.log('\n=== S217-16 — exceção do próprio gate → UNVALIDATED → bloqueio (nunca fail-open) ===');
{
    // Propriedade de SEGURANÇA: não pode existir `erro do validador → catch externo → entrega`.
    // `validateGrounding` já converte falha do juiz em UNVALIDATED, mas o que roda ANTES do try
    // dela (getBudgetAuxiliar, resolução de provedor) escapava para o catch de commitResponse,
    // que é fail-open por contrato.
    const factoryQuebrada = {
        getProviderWithModel: () => ({ chat: async () => ({ content: '{"claims":[]}' }) }),
        getBudgetAuxiliar: () => { throw new Error('orçamento indisponível'); },
    } as unknown as import('../../core/ProviderFactory').ProviderFactory;

    let lancou = false;
    try {
        await new ObserverValidator(factoryQuebrada, 'modelo-de-teste').validateGrounding('A = 10.', EVID);
    } catch { lancou = true; }
    assert(lancou, 'falha antes do try interno realmente escapa de validateGrounding — o risco é real, não hipotético');

    // A metade comportamental do contrato vive em commitResponse, que exige um AgentLoop inteiro
    // (provedores, sessão, trace, canal) para ser instanciado. Aqui se trava a forma do código —
    // mesma técnica de S217-12.
    const agent = fs.readFileSync(path.join(__dirname, '../../loop/AgentLoop.ts'), 'utf-8');
    // 17/08/2026: evidences passou a mesclar priorStepEvidence (evidência de steps anteriores do
    // mesmo goal — ver S248) antes de chamar o juiz; o texto exato mudou, mas o locator continua
    // ancorado na mesma declaração (agora multi-linha), não em heurística de proximidade.
    const ini = agent.indexOf('const evidences = [...AgentLoop.evidencesFromTrace(trace)');
    const gate = agent.slice(ini, agent.indexOf('return response;', ini));
    assert(ini > 0 && gate.length > 0, 'o gate foi localizado no fonte', { ini, len: gate.length });
    assert(/try\s*\{[\s\S]*validateGrounding\(/.test(gate), 'a chamada ao juiz está dentro de um try próprio', gate.slice(0, 200));
    assert(/catch[\s\S]*groundingBlockedMessage\('UNVALIDATED'\)/.test(gate),
        'e o catch desse try BLOQUEIA com UNVALIDATED, em vez de deixar subir para o catch fail-open');
}

console.log('\n=== S217-17 — args só da invocação adjacente da mesma ferramenta ===');
{
    // Pareamento estrito: com dispatch nativo de várias tools no mesmo passo, o tool_call
    // imediatamente anterior pode ser de outra ferramenta. Reaproveitar args de uma invocação
    // ANTERIOR da mesma ferramenta é o risco do incidente River → Reality VR: args de outra
    // consulta descreveriam uma evidência que não é aquela.
    const agent = fs.readFileSync(path.join(__dirname, '../../loop/AgentLoop.ts'), 'utf-8');
    const fn = agent.slice(agent.indexOf('private static evidencesFromTrace('), agent.indexOf('private async commitResponse('));
    assert(/if \(pd\.tool === d\.tool\) \{[\s\S]*\}\s*\n\s*break;/.test(fn),
        'o break é incondicional: para no tool_call adjacente, não procura mais atrás');
    assert(/try \{ input = JSON\.stringify/.test(fn),
        'JSON.stringify protegido — evidencesFromTrace roda fora do try do gate e não pode lançar');
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S217 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;

}

main().catch((err) => { console.error('S217 erro inesperado:', err); process.exitCode = 1; });
