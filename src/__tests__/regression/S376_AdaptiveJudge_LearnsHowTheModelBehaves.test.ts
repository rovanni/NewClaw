/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S376 (ADR-016, campanha 10/10/2026: "tem que ser genérico, que se adapte aos tipos de modelos")
 *
 * Em produção, o glm-5.3 como juiz raciocinava 178–240 s sem entregar JSON; com o raciocínio desligado escrevia a análise no
 * conteúdo; modelos "flash" respondem direto. O motor não pode saber quem é quem pelo nome. Ele DESCOBRE (capacidade que o
 * provedor declara) e APRENDE (o que funcionou para aquele modelo) — um padrão só, para todos os tipos de validação:
 *
 * S376-1 — perfil: o modo que funciona vira o primeiro; um azar não enterra um modo; persiste em disco; disjuntor abre/fecha.
 * S376-2 — motor com modelo "direto": uma chamada só, no modo preferido do tipo.
 * S376-3 — motor com modelo "espiral" (não conclui raciocinando): a 1ª chamada tem fatia do orçamento (não o orçamento
 *          inteiro), a 2ª usa o outro modo e dá veredito; a validação seguinte já começa pelo modo que funciona.
 * S376-4 — modelo que declara NÃO ter raciocínio: um modo só, sem segunda chamada igual à primeira.
 * S376-5 — modelo que não dá veredito em nenhum modo: sem veredito dentro do orçamento; depois o disjuntor evita gastar o tempo
 *          do usuário; passado o prazo, deixa uma sondagem passar.
 * S376-6 — falha do provedor (erro) não pune o perfil nem gasta o outro modo; cancelamento do usuário não é culpa do modelo.
 * S376-7 — fiação: o perfil do processo é persistido e o catálogo de modelos alimenta as capacidades no boot.
 *
 * Execução: npx ts-node src/__tests__/regression/S376_AdaptiveJudge_LearnsHowTheModelBehaves.test.ts
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PerfilDoJuiz, DISJUNTOR_MS, FALHAS_PARA_DISJUNTOR } from '../../validation/perfilDoJuiz';
import { ValidationEngine } from '../../validation/ValidationEngine';
import { criarRegistroPadrao } from '../../validation/motorPadrao';
import { getBudgetAuxiliar } from '../../shared/auxTimeout';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

const VEREDITO = JSON.stringify({ estado: 'aprovado', itens: [{ item: 'x', confere: 'sim' }], tipo_de_falha: 'none' });

type Comportamento = 'direto' | 'espiral' | 'nunca' | 'erro';
interface Chamada { modo: string; fatiaMs: number; reasoningIntensive: boolean }

/** Provedor simulado: o comportamento é do MODELO (por modo), não do código. 'travar' espera o prazo/sinal, como um modelo que não para. */
function fabrica(comportamento: Comportamento, chamadas: Chamada[], orcamentoMs = 600) {
    return {
        getBudgetAuxiliar: () => ({ timeoutMs: orcamentoMs, origem: 'padrao', latenciaTipicaMs: null }),
        chatWithFallback: async (_m: unknown, _t: unknown, _p: unknown, timeoutMs: number, sinal: AbortSignal | undefined, _modelo: unknown, opts: any) => {
            chamadas.push({ modo: opts.raciocinio, fatiaMs: timeoutMs, reasoningIntensive: !!opts.reasoningIntensive });
            const travar = (): Promise<any> => new Promise(res => {
                const t = setTimeout(() => res({ status: 'timeout', content: '', attempts: [] }), timeoutMs);
                sinal?.addEventListener('abort', () => { clearTimeout(t); res({ status: 'cancelled', content: '', attempts: [] }); });
            });
            if (comportamento === 'direto') return { status: 'success', content: VEREDITO, attempts: [] };
            if (comportamento === 'erro') return { status: 'error', content: '', attempts: [] };
            if (comportamento === 'espiral') return opts.raciocinio === 'livre' ? travar() : { status: 'success', content: VEREDITO, attempts: [] };
            return travar();
        },
    } as any;
}

const ENTRADAS = { pedido: 'p', resposta: 'r' };
const motorCom = (pf: any, perfil: PerfilDoJuiz) => new ValidationEngine(pf, criarRegistroPadrao(), () => 'modelo-teste', perfil);

async function main(): Promise<void> {

console.log('\n=== S376-1 — o perfil aprende o modo que funciona ===');
{
    const p = new PerfilDoJuiz();
    assert(p.ordemDosModos('m', 'livre')[0] === 'livre', 'sem histórico: vale o modo preferido do tipo');
    assert(p.ordemDosModos('m', 'desligado')[0] === 'desligado', '…seja qual for o preferido');
    p.registrar('m', 'livre', false, 9000);
    assert(p.ordemDosModos('m', 'livre')[0] === 'desligado', 'o modo que falhou cede o primeiro lugar');
    p.registrar('m', 'desligado', true, 4000);
    for (let i = 0; i < 4; i++) p.registrar('m', 'livre', true, 3000);
    assert(p.ordemDosModos('m', 'desligado')[0] === 'livre', 'um azar isolado não enterra um modo (taxa suavizada)', p.resumo('m'));
    assert(p.ordemDosModos('outro', 'livre')[0] === 'livre', 'o aprendizado é por modelo — outro modelo começa do zero');

    const arq = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 's376-')), 'sub', 'perfil.json');
    const gravado = new PerfilDoJuiz(); gravado.persistirEm(arq);
    assert(gravado.persistente && !new PerfilDoJuiz().persistente, 'só o perfil com arquivo é "persistente"');
    gravado.registrar('m', 'desligado', true, 1200);
    const relido = new PerfilDoJuiz(arq);
    assert(relido.resumo('m').desligado.ok === 1, 'o aprendizado sobrevive ao reinício', relido.resumo('m'));
    fs.writeFileSync(arq, '{ lixo');
    assert(new PerfilDoJuiz(arq).ordemDosModos('m', 'livre')[0] === 'livre', 'arquivo ilegível: recomeça do zero, sem lançar');

    let agora = 1_000_000;
    const d = new PerfilDoJuiz(undefined, () => agora);
    for (let i = 0; i < FALHAS_PARA_DISJUNTOR; i++) d.registrar('m', 'livre', false, 1);
    assert(!d.estadoDoDisjuntor('m').aberto, 'falhar num modo só não abre o disjuntor (o outro modo pode funcionar)');
    for (let i = 0; i < FALHAS_PARA_DISJUNTOR; i++) d.registrar('m', 'desligado', false, 1);
    assert(d.estadoDoDisjuntor('m').aberto, 'falhando em TODOS os modos, o disjuntor abre');
    agora += DISJUNTOR_MS + 1;
    assert(!d.estadoDoDisjuntor('m').aberto, 'passado o prazo, deixa passar uma sondagem');
    d.registrar('m', 'desligado', true, 1);
    assert(!d.estadoDoDisjuntor('m').aberto, 'um sucesso fecha de vez');
}

console.log('\n=== S376-2 — modelo que responde direto: uma chamada ===');
{
    const chamadas: Chamada[] = [];
    const r = await motorCom(fabrica('direto', chamadas), new PerfilDoJuiz()).validar('qualidade_da_resposta', ENTRADAS);
    assert(chamadas.length === 1 && r.semVeredito === false, 'uma chamada, com veredito', { chamadas, desfecho: r.desfecho });
    assert(chamadas[0].modo === 'livre' && chamadas[0].reasoningIntensive, 'no modo preferido do tipo (raciocínio livre)');
}

console.log('\n=== S376-3 — modelo que se perde raciocinando: fatia, outro modo, e aprende ===');
{
    const chamadas: Chamada[] = [];
    const perfil = new PerfilDoJuiz();
    const motor = motorCom(fabrica('espiral', chamadas, 600), perfil);
    const t0 = Date.now();
    const r = await motor.validar('qualidade_da_resposta', ENTRADAS);
    const ms = Date.now() - t0;
    assert(chamadas.length === 2 && chamadas[0].modo === 'livre' && chamadas[1].modo === 'desligado', 'tentou o outro modo depois do primeiro não concluir', chamadas);
    assert(chamadas[0].fatiaMs < 600 * 0.7, 'a 1ª chamada recebeu uma FATIA do orçamento, não o orçamento inteiro', chamadas[0]);
    assert(!chamadas[1].reasoningIntensive, 'o 2º modo é sem raciocínio intensivo');
    assert(r.semVeredito === false && r.veredito !== undefined, 'e o 2º modo deu o veredito', r.desfecho);
    assert(ms < 700, `tudo dentro do orçamento do juiz (${ms} ms ≤ ~600 ms)`);
    assert(perfil.resumo('modelo-teste').desligado.ok === 1 && perfil.resumo('modelo-teste').livre.ok === 0, 'o perfil registrou o que funcionou', perfil.resumo('modelo-teste'));

    chamadas.length = 0;
    await motor.validar('qualidade_da_resposta', ENTRADAS);
    assert(chamadas.length === 1 && chamadas[0].modo === 'desligado', 'a validação seguinte JÁ começa pelo modo que funciona (uma chamada só)', chamadas);
}

console.log('\n=== S376-4 — modelo que declara não ter raciocínio: um modo só ===');
{
    const chamadas: Chamada[] = [];
    const perfil = new PerfilDoJuiz();
    perfil.definirResolvedorDeCapacidades(async (m) => m === 'modelo-teste' ? { raciocinio: false } : undefined);
    const r = await motorCom(fabrica('nunca', chamadas, 400), perfil).validar('qualidade_da_resposta', ENTRADAS);
    assert(chamadas.length === 1, 'sem raciocínio para alternar: uma chamada só, com o orçamento inteiro', chamadas);
    assert(chamadas[0].fatiaMs > 300, 'e ela recebe (quase) todo o orçamento', chamadas[0]);
    assert(r.semVeredito === true, 'sem veredito, declarado');

    const comResolvedorQuebrado = new PerfilDoJuiz();
    comResolvedorQuebrado.definirResolvedorDeCapacidades(async () => { throw new Error('catálogo fora do ar'); });
    assert((await comResolvedorQuebrado.modosParaTentar('m', 'livre')).length === 2, 'catálogo indisponível: segue só pelo observado (não derruba o julgamento)');
}

console.log('\n=== S376-5 — modelo que não dá veredito em modo nenhum: orçamento respeitado e disjuntor ===');
{
    const chamadas: Chamada[] = [];
    let agora = 5_000_000;
    const perfil = new PerfilDoJuiz(undefined, () => agora);
    const motor = motorCom(fabrica('nunca', chamadas, 400), perfil);
    const t0 = Date.now();
    const r1 = await motor.validar('qualidade_da_resposta', ENTRADAS);
    const ms = Date.now() - t0;
    assert(r1.semVeredito === true && r1.desfecho === 'llm_timeout', 'sem veredito, com o desfecho "timeout"', r1.desfecho);
    assert(ms < 550, `não passou do orçamento do juiz (${ms} ms ≤ ~400 ms)`);
    await motor.validar('qualidade_da_resposta', ENTRADAS);
    const antes = chamadas.length;
    const r3 = await motor.validar('qualidade_da_resposta', ENTRADAS);
    assert(chamadas.length === antes && r3.desfecho === 'juiz_indisponivel', 'com o disjuntor aberto o motor nem chama o modelo (o usuário não espera minutos)', { desfecho: r3.desfecho });
    assert(r3.semVeredito === true, 'e continua "sem veredito" — a política declarada do tipo não muda');
    agora += DISJUNTOR_MS + 1;
    await motor.validar('qualidade_da_resposta', ENTRADAS);
    assert(chamadas.length > antes, 'passado o prazo, uma sondagem passa');
}

console.log('\n=== S376-6 — falha do provedor e cancelamento não são "comportamento do modelo" ===');
{
    const chamadas: Chamada[] = [];
    const perfil = new PerfilDoJuiz();
    const r = await motorCom(fabrica('erro', chamadas), perfil).validar('qualidade_da_resposta', ENTRADAS);
    assert(chamadas.length === 1 && r.semVeredito === true, 'erro do provedor: não gasta o outro modo');
    assert(perfil.resumo('modelo-teste').livre.n === 0, 'e não pune o perfil do modelo', perfil.resumo('modelo-teste'));

    const ctrl = new AbortController();
    const motor = motorCom(fabrica('nunca', [], 2000), new PerfilDoJuiz());
    const p = motor.validar('qualidade_da_resposta', ENTRADAS, { signal: ctrl.signal });
    setTimeout(() => ctrl.abort(), 50);
    const rc = await p;
    assert(rc.desfecho === 'llm_cancelled', 'cancelamento do usuário encerra o julgamento na hora', rc.desfecho);
}

console.log('\n=== S376-7 — fiação de produção ===');
{
    const lerFonte = (rel: string): string => fs.readFileSync(path.join(process.cwd(), rel), 'utf-8');
    const ctl = lerFonte('src/core/AgentController.ts');
    assert(/perfilDoJuizDoProcesso\.persistirEm\(/.test(ctl) && /definirResolvedorDeCapacidades\(/.test(ctl), 'o boot liga a persistência e a descoberta de capacidades');
    assert(/includes\('reasoning'\)/.test(ctl), 'as capacidades vêm do catálogo de modelos (o que o provedor declara)');
    const motorSrc = lerFonte('src/validation/ValidationEngine.ts');
    assert(!/perfilDoJuizDoProcesso/.test(motorSrc), 'o motor não conhece o perfil global — recebe o perfil por injeção');
    const padrao = lerFonte('src/validation/motorPadrao.ts');
    assert(/perfilDoJuizDoProcesso\.persistente/.test(padrao), 'o motor padrão só compartilha o perfil do processo quando ele está persistido (testes isolados)');
    assert(!/glm|qwen|gemma|llama/i.test(lerFonte('src/validation/perfilDoJuiz.ts').replace(/\/\*[\s\S]*?\*\//g, '')), 'nenhum nome de modelo no código do perfil — comportamento observado, não escrito à mão');
}

console.log('\n=== S376-8 — o orçamento do juiz acompanha o TAMANHO do trabalho (produção 10/10: 12,6 mil chars levaram 71–84 s; o piso de 30 s bloqueou uma resposta verdadeira) ===');
{
    const rapido = { getLatenciaTipicaMs: () => 2000 };
    const pequeno = getBudgetAuxiliar('validacao', 'ollama', rapido, 3000);
    assert(pequeno.timeoutMs === 30_000 && !pequeno.escaladoPeloTrabalho, 'trabalho pequeno: continua o piso do perfil (30 s)', pequeno);
    const grande = getBudgetAuxiliar('validacao', 'ollama', rapido, 12_634);
    assert(grande.timeoutMs >= 84_000 && grande.escaladoPeloTrabalho === true, 'o caso real (12.634 chars) ganha mais que os 84 s medidos', grande);
    assert(getBudgetAuxiliar('validacao', 'ollama', rapido, 5_000_000).timeoutMs === 300_000, 'e nunca passa do teto do perfil (300 s)');
    assert(getBudgetAuxiliar('validacao', 'ollama', rapido).timeoutMs === 30_000, 'sem informar o tamanho: o comportamento anterior, intacto');
    assert(getBudgetAuxiliar('validacao', null, null, 12_634).timeoutMs >= 84_000, 'também sem nenhuma medição de latência (partida a frio)');
    const lento = getBudgetAuxiliar('validacao', 'ollama', { getLatenciaTipicaMs: () => 40_000 }, 3000);
    assert(lento.timeoutMs === 160_000 && !lento.escaladoPeloTrabalho, 'provedor lento: a latência medida continua valendo quando é maior que a estimativa pelo tamanho', lento);
    assert(getBudgetAuxiliar('classificacao', 'ollama', rapido, 50_000).timeoutMs === 6_000, 'perfil de classificação não escala pelo tamanho');

    let pedido: number | undefined;
    const pf = { getBudgetAuxiliar: (_p: string, tamanho?: number) => { pedido = tamanho; return { timeoutMs: 30_000, origem: 'padrao', latenciaTipicaMs: null }; }, chatWithFallback: async () => ({ status: 'success', content: VEREDITO, attempts: [] }) } as any;
    const r = await motorCom(pf, new PerfilDoJuiz()).validar('qualidade_da_resposta', { pedido: 'p'.repeat(5000), resposta: 'r' });
    assert(typeof pedido === 'number' && pedido > 5000, 'o motor informa o tamanho do prompt montado ao pedir o orçamento', pedido);
    assert(r.orcamentoMs === 30_000, 'e o resultado expõe o orçamento usado (para o log e o trace)', r.orcamentoMs);
}

console.log('\n=== S376-9 — o modo que já provou funcionar recebe o tempo todo ===');
{
    const p = new PerfilDoJuiz();
    assert(!p.confiavel('m', 'livre'), 'sem histórico: sem confiança');
    p.registrar('m', 'livre', true, 5000);
    assert(!p.confiavel('m', 'livre'), 'uma amostra só não basta');
    p.registrar('m', 'livre', true, 5000); p.registrar('m', 'livre', false, 30000);
    assert(p.confiavel('m', 'livre'), '2 sucessos em 3: confiável', p.resumo('m'));
    p.registrar('m', 'livre', false, 30000); p.registrar('m', 'livre', false, 30000);
    assert(!p.confiavel('m', 'livre'), 'falhas seguidas tiram a confiança');

    const confiante = new PerfilDoJuiz();
    for (let i = 0; i < 3; i++) confiante.registrar('modelo-teste', 'livre', true, 5000);
    const chamadas: Chamada[] = [];
    await motorCom(fabrica('nunca', chamadas, 600), confiante).validar('qualidade_da_resposta', ENTRADAS);
    assert(chamadas[0].fatiaMs > 550, 'modo confiável: a 1ª chamada recebe o orçamento todo, sem cortar para sobrar tempo ao outro modo', chamadas[0]);
    const novo: Chamada[] = [];
    await motorCom(fabrica('nunca', novo, 600), new PerfilDoJuiz()).validar('qualidade_da_resposta', ENTRADAS);
    assert(novo[0].fatiaMs < 400, 'modelo ainda desconhecido: a 1ª chamada divide o tempo (proteção contra quem se perde raciocinando)', novo[0]);
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S376 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;
}

main().catch(e => { console.error(e); process.exit(1); });
