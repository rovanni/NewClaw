/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S378 (10/10/2026: "como uma pessoa decide se está recebendo todas as informações necessárias?")
 *
 * O campo `faltou` dos juízes (55 avaliações gravadas; 10 declararam falta de informação) apontou lacunas reais entre o que uma
 * pessoa teria no lugar do juiz e o que ele recebia. Cinco melhorias, todas no motor único ou nos seus consumidores:
 *
 * S378-1 — a data e a hora de hoje entram no prompt de TODOS os tipos (a versão do prompt não muda por causa dela).
 * S378-2 — o juiz de conclusão recebe os resultados INTEIROS desta execução, com qualquer corte declarado (antes: 300/200
 *          caracteres sem aviso).
 * S378-3 — o juiz de grounding sabe o que cada ferramenta usada FAZ, em seção própria que nunca vale como evidência.
 * S378-4 — o juiz de grounding vê a conversa recente (contexto do usuário, nunca evidência).
 * S378-5 — a resposta parcial entregue avisa o que NÃO foi confirmado, e só o corpo é revalidado.
 *
 * Execução: npx ts-node src/__tests__/regression/S378_JudgeInformation_WhatAPersonWouldHave.test.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { ValidationEngine } from '../../validation/ValidationEngine';
import { criarRegistroPadrao } from '../../validation/motorPadrao';
import { PerfilDoJuiz } from '../../validation/perfilDoJuiz';
import { ObserverValidator } from '../../loop/ObserverValidator';
import { GoalExecutionLoop } from '../../loop/GoalExecutionLoop';
import { AgentLoop, MARCA_DO_AVISO_PARCIAL } from '../../loop/AgentLoop';
import { descreverAgora } from '../../shared/dataEHora';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}
const ler = (rel: string): string => fs.readFileSync(path.join(process.cwd(), rel), 'utf-8');

/** Fábrica que captura o prompt enviado ao juiz e devolve o veredito pedido. */
function fabrica(prompts: string[], veredito: object) {
    return {
        getBudgetAuxiliar: () => ({ timeoutMs: 30_000, origem: 'padrao', latenciaTipicaMs: null }),
        modeloPermitidoPelaSoberania: () => true,
        chatWithFallback: async (m: Array<{ content: string }>) => {
            prompts.push(m[0].content);
            return { status: 'success', content: JSON.stringify(veredito), attempts: [] };
        },
    } as any;
}
const APROVADO = { estado: 'aprovado', itens: [], tipo_de_falha: 'none' };

async function main(): Promise<void> {

console.log('\n=== S378-1 — a data de hoje no prompt de todos os tipos ===');
{
    const agora = new Date('2026-10-10T18:31:00Z');
    const registro = criarRegistroPadrao();
    const tipos = registro.tipos() as any[];
    for (const d of tipos) {
        const prompts: string[] = [];
        const motor = new ValidationEngine(fabrica(prompts, APROVADO), registro, () => 'm', new PerfilDoJuiz(), () => agora);
        const entradas = Object.fromEntries(d.entradas.map((e: any) => [e.nome, 'x']));
        await motor.validar(d.tipo, entradas);
        assert(prompts.length === 1 && prompts[0].includes('Data e hora atuais:') && prompts[0].includes(descreverAgora(agora)), `${d.tipo}: o prompt traz a data e a hora de hoje`);
    }
    const semRelogio = new ValidationEngine({} as any, registro).montarPrompt(registro.obter('qualidade_da_resposta') as any, {});
    assert(!semRelogio.includes('Data e hora atuais'), 'o prompt-base (usado para a VERSÃO do prompt no gravador de voo) não tem a data — a versão não muda todo dia');
    const motorSrc = ler('src/validation/ValidationEngine.ts');
    assert(/versaoDoPrompt\(this\.montarPrompt\(d, \{\}\)\)/.test(motorSrc), 'a versão do prompt é calculada sem data');
    assert(/fuso/.test(ler('src/shared/dataEHora.ts')) && !/America\/Sao_Paulo/.test(ler('src/shared/dataEHora.ts')), 'o fuso é o da máquina (Windows, Linux e macOS), não um valor escrito à mão');
}

console.log('\n=== S378-2 — o juiz de conclusão recebe os resultados inteiros, com o corte declarado ===');
{
    const longo = 'dado '.repeat(1000);   // 5000 caracteres — antes chegava como 300
    const goal: any = {
        currentPlan: [{ id: 's1', description: 'consultar a fonte', status: 'completed', result: longo.slice(0, 200) }, { id: 's2', description: 'passo pendente', status: 'pending' }],
        attempts: [
            { toolName: 'web_search', result: 'success', planGeneration: 1, planStepId: 's1', output: longo.slice(0, 300), args: {} },
            { toolName: 'read', result: 'success', planGeneration: 1, planStepId: 's9', output: 'curto', args: {} },
            { toolName: 'x', result: 'failed', planStepId: 's3', output: 'não entra' },
        ],
        planGeneration: 1,
    };
    const state: any = { saidasCompletas: new Map([['1:s1', longo]]) };
    const r = (GoalExecutionLoop as any).resultadosParaOJuiz(goal, state, 30_000);
    assert(r.ferramentas.includes(longo) && !/cortado|ficaram guardados/.test(r.ferramentas.split('\n')[0]), 'com a saída completa da execução: entra INTEIRA (5000 caracteres, não 300)', r.ferramentas.length);
    assert(r.ferramentas.includes('(passo: consultar a fonte)'), 'cada resultado diz de qual passo veio');
    assert(!r.ferramentas.includes('não entra') && r.passos === '- consultar a fonte', 'só o que deu certo; os passos concluídos são listados sem resultado cortado');

    const semCompleta = (GoalExecutionLoop as any).resultadosParaOJuiz(goal, { saidasCompletas: new Map() }, 30_000);
    assert(/só os primeiros 300 caracteres ficaram guardados — o resto não está disponível/.test(semCompleta.ferramentas), 'goal retomado: só o trecho guardado existe — e o juiz é AVISADO');

    const apertado = (GoalExecutionLoop as any).resultadosParaOJuiz(goal, state, 2000);
    assert(/cortado para caber: mostrando \d+ de 5000 caracteres/.test(apertado.ferramentas), 'orçamento pequeno: o corte é declarado com os números');

    const fonte = ler('src/loop/GoalExecutionLoop.ts');
    assert(!/a\.output\?\.slice\(0, ATTEMPT_OUTPUT_EVIDENCE_LIMIT\)/.test(fonte), 'nenhum corte silencioso de 300 caracteres sobrou nos prompts dos juízes');
    assert(/primeiros \$\{limiteDosArtefatos\} de \$\{content\.length\} caracteres — o corte é do sistema, não do dado/.test(fonte), 'os artefatos dividem um orçamento comum e o corte é declarado com os números');
}

console.log('\n=== S378-3 — o que cada ferramenta faz, em seção própria (nunca evidência) ===');
{
    const prompts: string[] = [];
    const observador = new ObserverValidator(fabrica(prompts, { estado: 'aprovado', itens: [{ item: 'gravado', confere: 'sim', evidencia: 'E1', trecho: 'Grava um fato permanente na memória' }] }));
    observador.definirDescritorDeFerramentas(nome => nome === 'memory_write' ? 'Grava um fato permanente na memória' : undefined);
    const g = await observador.validateGrounding('Salvei na memória.', [{ id: 'E1', tool: 'memory_write', input: '{"x":1}', output: 'atualizado' }, { id: 'E2', tool: 'sem_descricao', output: 'ok' }]);
    const p = prompts[0];
    assert(/Ferramentas usadas neste turno — o que cada uma faz/.test(p) && p.includes('- memory_write: Grava um fato permanente na memória'), 'o prompt traz o que a ferramenta usada faz');
    assert(!p.includes('- sem_descricao:'), 'ferramenta sem descrição não ganha linha inventada');
    const iEvid = p.indexOf('FONTES DE VERDADE'), iFerr = p.indexOf('CONTEXTO DA EXECUÇÃO');
    assert(iEvid > -1 && iFerr > iEvid && !p.slice(iEvid, iFerr).includes('Grava um fato permanente'), 'a descrição fica FORA das fontes de verdade');
    assert(g.state !== 'VALIDATED', 'citar o texto da descrição como prova não vale: a citação só pode vir das evidências', g.state);
    assert(/NÃO sustenta nenhuma afirmação sobre dados/.test(p), 'o checklist diz que a descrição não sustenta afirmações');
}

console.log('\n=== S378-4 — a conversa recente como contexto ===');
{
    const prompts: string[] = [];
    const observador = new ObserverValidator(fabrica(prompts, APROVADO));
    await observador.validateGrounding('Resposta.', [{ id: 'E1', tool: 't', output: 'o' }], undefined, {
        userRequest: 'salve isso',
        recentMessages: [{ role: 'user', content: 'O curso é de Física' }, { role: 'assistant', content: 'Certo.' }, { role: 'tool', content: 'ignorado' }],
    });
    const p = prompts[0];
    assert(/Conversa recente \(antes deste pedido\)/.test(p) && p.includes('Usuário: O curso é de Física') && p.includes('Assistente: Certo.'), 'o juiz vê a conversa, com quem disse o quê');
    assert(!p.includes('ignorado'), 'só turnos reais (usuário/assistente)');
    assert(p.indexOf('Conversa recente') < p.indexOf('FONTES DE VERDADE') && /NÃO é evidência de dado das ferramentas/.test(p), 'é contexto do usuário, antes das fontes — nunca fonte de verdade');
    assert(/O que o ASSISTENTE disse em turnos anteriores da conversa não é evidência/.test(p), 'o que o assistente disse antes não vira prova');

    const semConversa: string[] = [];
    await new ObserverValidator(fabrica(semConversa, APROVADO)).validateGrounding('R.', [{ id: 'E1', tool: 't', output: 'o' }]);
    assert(/\[Conversa recente[^\]]*\]\n"""\n\(não informado\)/.test(semConversa[0]), 'sem conversa: DECLARADO ("não informado"), nunca omitido em silêncio');
    const muitas = Array.from({ length: 10 }, (_, i) => ({ role: 'user', content: `msg${i} ${'x'.repeat(1500)}` }));
    const janela = ObserverValidator.conversaParaOJuiz(muitas, 8000)!;
    assert(/\d+ mensagens mais antigas omitidas pelo sistema/.test(janela) && janela.includes('msg9') && !janela.includes('msg0'), 'conversa grande: saem as mais antigas, mensagens INTEIRAS, e a omissão é declarada');
    assert(ObserverValidator.conversaParaOJuiz([{ role: 'user', content: 'x'.repeat(20000) }], 8000)!.length >= 20000, 'uma única fala longa nunca é cortada no meio');
    const fonte = ler('src/loop/AgentLoop.ts');
    assert(/recentMessages: channelContext\?\.recentMessages, \.\.\.channelContext\?\.goalTrace/.test(fonte), 'o AgentLoop repassa a conversa ao juiz do turno');
    assert(/partial-revalidation', userRequest: userText, recentMessages/.test(fonte), '…e à revalidação da resposta parcial');
}

console.log('\n=== S378-5 — a resposta parcial avisa o que ficou de fora ===');
{
    const chamadas: string[] = [];
    const revalidados: string[] = [];
    const sintetizar = async (conteudoDoModelo: string, naoConfirmadas: any[], estado: string = 'VALIDATED') => {
        const falso: any = {
            profileRegistry: { getProfileByCategory: () => ({}) },
            callLLMWithFallback: async (msgs: Array<{ content: string }>) => { chamadas.push(msgs[0].content); return { status: 'success', content: conteudoDoModelo }; },
            observer: { validateGrounding: async (t: string) => { revalidados.push(t); return { state: estado, claims: [] }; } },
            ts: () => '',
        };
        return await (AgentLoop.prototype as any).trySynthesizePartialResponse.call(falso, 'pergunta', [{ claim: 'preço é 1,17', verdict: 'SUPPORTED', evidence: ['E1'] }], [], undefined, undefined, naoConfirmadas);
    };
    const pendentes = [{ claim: 'vento forte', verdict: 'NOT_EVALUABLE' }, { claim: 'ATH em 2020', verdict: 'NOT_SUPPORTED' }];

    const comAviso = await sintetizar(`O preço é 1,17.\n\n${MARCA_DO_AVISO_PARCIAL} Não consegui confirmar: vento forte; ATH em 2020.`, pendentes);
    assert(typeof comAviso === 'string' && comAviso.startsWith('O preço é 1,17.') && comAviso.includes(`${MARCA_DO_AVISO_PARCIAL} Não consegui confirmar: vento forte`), 'a resposta parcial entregue traz o aviso do que não foi confirmado', comAviso);
    assert(revalidados[0] === 'O preço é 1,17.', 'só o CORPO é revalidado pela barreira (o aviso é um juízo sobre o que não foi confirmado, não um dado)', revalidados[0]);
    assert(/vento forte \(as fontes não confirmam\)/.test(chamadas[0]) && /ATH em 2020 \(as fontes dizem outra coisa\)/.test(chamadas[0]), 'o modelo recebe o que ficou de fora e se foi contradito ou só não confirmado');
    assert(/no idioma do usuário/.test(chamadas[0]), 'o aviso é redigido pelo modelo, no idioma do usuário (o Core não escreve frase fixa)');

    const semAvisoDoModelo = await sintetizar('O preço é 1,17.', pendentes);
    assert(typeof semAvisoDoModelo === 'string' && semAvisoDoModelo.includes(`${MARCA_DO_AVISO_PARCIAL} vento forte; ATH em 2020`), 'o modelo esqueceu o aviso: nunca silêncio — a marca e os pontos aparecem', semAvisoDoModelo);
    const nada = await sintetizar('O preço é 1,17.', []);
    assert(nada === 'O preço é 1,17.', 'sem nada a avisar, nada é acrescentado');
    assert(await sintetizar('INSUFICIENTE', pendentes) === null, 'o sinal "INSUFICIENTE" continua descartando a parcial');
    assert(await sintetizar('O preço é 1,17.', pendentes, 'REJECTED') === null, 'se o corpo não passar na barreira, a parcial é descartada como antes');
    const fonte = ler('src/loop/AgentLoop.ts');
    assert(/comAviso: partial\.includes\(MARCA_DO_AVISO_PARCIAL\)/.test(fonte), 'o gravador de voo registra se a parcial saiu com aviso');
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S378 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;
}

main().catch(e => { console.error(e); process.exit(1); });
