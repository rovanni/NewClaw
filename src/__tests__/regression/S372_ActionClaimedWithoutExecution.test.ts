/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S372 (campanha 09/10/2026, opção A aprovada pelo operador)
 *
 * "Maravilha salve essas informações na memória sobre o river!" → "Salvo! 🧠 Criei o nó…" com ZERO ferramentas
 * executadas (log: só weather/web_search/crypto_analysis de turnos anteriores; banco sem o nó). O portão de commit
 * fazia `if (!last) return response` e só pegava promessa futura, por regex; o juiz de grounding não serve (exclui por
 * definição "o que o assistente diz que fez" e nem roda sem evidência).
 *
 * Agora: o roteador exigiu ferramenta + nenhuma rodou com sucesso → o motor único julga o que a resposta AFIRMA, com o
 * MESMO tipo `qualidade_da_resposta` que já julga a resposta nos turnos com ferramenta (um padrão de juiz, reutilizado —
 * não um juiz novo); reprovou por `claimed_without_execution` → a resposta não é entregue e o usuário recebe a mensagem
 * escrita pelo próprio modelo, no idioma do pedido.
 *
 * S372-1 — o tipo existente ganhou o item, o valor de falha e o campo extra; o prompt traz resposta, pedido e fato.
 * S372-2 — decisões do motor real com modelo falso: aprovar / reprovar / infraestrutura não bloqueia.
 * S372-3 — portão do AgentLoop: só com exigeFerramenta; não em passo de goal com evidência; desligável; erro não bloqueia.
 *
 * Execução: npx ts-node src/__tests__/regression/S372_ActionClaimedWithoutExecution.test.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { ValidationEngine } from '../../validation/ValidationEngine';
import { criarRegistroPadrao } from '../../validation/motorPadrao';
import { validarDescritor } from '../../validation/contratoDeValidacao';
import { descritorQualidadeDaResposta } from '../../validation/tipos/demaisTipos';
import { AgentLoop } from '../../loop/AgentLoop';

const TIPO = 'qualidade_da_resposta';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

const RESPOSTA_SALVO = 'Salvo! 🧠 Criei o nó "River (RIVER)" no domínio de memória gráfica.';
const PEDIDO = 'Maravilha salve essas informações na memória sobre o river!';

function motorCom(resposta: object | null, status = 'success'): ValidationEngine {
    const pf = {
        getBudgetAuxiliar: () => ({ timeoutMs: 30_000, origem: 'padrao', latenciaTipicaMs: null }),
        chatWithFallback: async () => ({ status, content: resposta ? JSON.stringify(resposta) : '', attempts: [] }),
    } as any;
    return new ValidationEngine(pf, criarRegistroPadrao(), () => undefined);
}

/** AgentLoop mínimo: só o que `verificarAcaoAfirmada` toca (estado do turno, motor, relógio do log). */
function agenteCom(motor: { validar: (...a: any[]) => Promise<any> }, exigeFerramenta: boolean | undefined) {
    const a = Object.create(AgentLoop.prototype) as any;
    a.activeTurnStates = new Map();
    a.motorDeValidacao = motor;
    a.getTurnState('c1').exigeFerramenta = exigeFerramenta;
    return a as { verificarAcaoAfirmada: (r: string, u: string, c: string, f: number, s?: AbortSignal, ch?: any) => Promise<string> };
}

async function main(): Promise<void> {

console.log('\n=== S372-1 — o tipo existente cobre o caso; nenhum tipo novo ===');
{
    const registro = criarRegistroPadrao();
    assert(validarDescritor(descritorQualidadeDaResposta as never).length === 0, 'qualidade_da_resposta continua válido');
    assert(registro.tipos().length === 7 && !registro.tipos().some(t => /acao_afirmada/.test(t.tipo)), 'o registro segue com os 7 tipos — nenhum juiz novo', registro.tipos().map(t => t.tipo));
    assert(descritorQualidadeDaResposta.checklist.some(c => /JÁ FEITA/.test(c) && /Ferramentas executadas neste turno/.test(c)), 'checklist: não afirmar ação feita sem ferramenta que a realizou');
    const nomes = (descritorQualidadeDaResposta.camposExtras ?? []).map(c => c.nome);
    assert(nomes.includes('tipo_de_falha') && nomes.includes('mensagem_ao_usuario'), 'campos extras: tipo_de_falha e mensagem_ao_usuario', nomes);
    const motor = new ValidationEngine({} as any, registro);
    const p = motor.montarPrompt(descritorQualidadeDaResposta as never, {
        resposta: RESPOSTA_SALVO, pedido: PEDIDO, ferramentas: 'Ferramentas executadas com sucesso neste turno: nenhuma.',
    });
    assert(p.includes(RESPOSTA_SALVO) && p.includes(PEDIDO), 'o prompt traz a resposta e o pedido INTEIROS');
    assert(p.includes('Ferramentas executadas com sucesso neste turno: nenhuma.'), 'o prompt traz o fato da execução');
    assert(/claimed_without_execution/.test(p) && /MESMO IDIOMA do pedido/.test(p), 'o valor de falha e a mensagem no idioma do pedido são pedidos ao modelo');
}

console.log('\n=== S372-2 — decisões (motor real, modelo falso) ===');
{
    const entradas = { resposta: RESPOSTA_SALVO, pedido: PEDIDO, ferramentas: 'Ferramentas executadas com sucesso neste turno: nenhuma.' };
    const validar = (m: ValidationEngine, e: Record<string, string> = entradas) => m.validar(TIPO, e).then(r => r.veredito);

    const v1 = await validar(motorCom({
        estado: 'reprovado', itens: [], tipo_de_falha: 'claimed_without_execution',
        mensagem_ao_usuario: 'Não consegui salvar: nenhuma ferramenta de memória foi executada. Peça de novo e eu salvo de verdade.',
    }));
    assert(v1.estado === 'reprovado' && v1.extras?.tipo_de_falha === 'claimed_without_execution', 'afirma "Salvo!" sem execução → reprovado por claimed_without_execution', v1);
    assert(/nenhuma ferramenta de memória/.test(v1.extras?.mensagem_ao_usuario ?? ''), 'a mensagem ao usuário vem do modelo', v1.extras);

    const v2 = await validar(motorCom({ estado: 'aprovado', itens: [], tipo_de_falha: 'none' }), { ...entradas, resposta: 'Quer que eu salve essas informações na memória?' });
    assert(v2.estado === 'aprovado', 'oferta/pergunta → aprovado', v2);

    const v3 = await validar(motorCom(null, 'timeout'));
    assert(v3.estado === 'nao_avaliavel' && !!v3.naoAvaliavelPorque, 'modelo fora / prazo → não avaliável (não bloqueia)', v3);

    const v4 = await validar(motorCom({ qualquer: 'coisa' }));
    assert(v4.extras?.tipo_de_falha !== 'claimed_without_execution', 'saída sem estrutura válida nunca bloqueia', v4);
}

console.log('\n=== S372-3 — portão do AgentLoop.verificarAcaoAfirmada ===');
{
    const chamadas: Array<Record<string, string>> = [];
    type Veredito = { estado: string; extras?: Record<string, string>; naoAvaliavelPorque?: string };
    const motorFalso = (veredito: Veredito) => ({
        validar: async (tipo: string, entradas: Record<string, string>) => { chamadas.push({ tipo, ...entradas }); return { veredito: { avaliacaoId: 'av_t', itens: [], ...veredito } }; },
    });
    const BLOQUEAR: Veredito = { estado: 'reprovado', extras: { tipo_de_falha: 'claimed_without_execution', mensagem_ao_usuario: 'Nada foi salvo; peça de novo.' } };

    chamadas.length = 0;
    let r = await agenteCom(motorFalso(BLOQUEAR), true).verificarAcaoAfirmada(RESPOSTA_SALVO, PEDIDO, 'c1', 0);
    assert(r === 'Nada foi salvo; peça de novo.' && chamadas.length === 1, 'exigiu ferramenta + zero executadas + juiz reprovou → entrega a mensagem do modelo', r);
    assert(chamadas[0].tipo === TIPO && chamadas[0].ferramentas.includes('nenhuma') && chamadas[0].resposta === RESPOSTA_SALVO && chamadas[0].pedido === PEDIDO,
        'o mesmo tipo qualidade_da_resposta recebeu resposta, pedido e o fato da execução', chamadas[0]);

    chamadas.length = 0;
    await agenteCom(motorFalso(BLOQUEAR), true).verificarAcaoAfirmada(RESPOSTA_SALVO, PEDIDO, 'c1', 2);
    assert(/falharam neste turno: 2/.test(chamadas[0]?.ferramentas ?? ''), 'falhas de ferramenta entram no fato da execução', chamadas[0]);

    chamadas.length = 0;
    r = await agenteCom(motorFalso(BLOQUEAR), false).verificarAcaoAfirmada(RESPOSTA_SALVO, PEDIDO, 'c1', 0);
    assert(r === RESPOSTA_SALVO && chamadas.length === 0, 'o roteador NÃO exigiu ferramenta (conversa) → nem chama o juiz', r);

    r = await agenteCom(motorFalso(BLOQUEAR), undefined).verificarAcaoAfirmada(RESPOSTA_SALVO, PEDIDO, 'c1', 0);
    assert(r === RESPOSTA_SALVO && chamadas.length === 0, 'sem a marca do roteador → não chama o juiz');

    r = await agenteCom(motorFalso(BLOQUEAR), true).verificarAcaoAfirmada(RESPOSTA_SALVO, PEDIDO, 'c1', 0, undefined, { priorStepEvidence: [{ id: 'G1', tool: 'x', output: 'y' }] });
    assert(r === RESPOSTA_SALVO && chamadas.length === 0, 'passo de goal com evidência de passos anteriores → fora do portão');

    r = await agenteCom(motorFalso({ estado: 'aprovado', extras: { tipo_de_falha: 'none' } }), true).verificarAcaoAfirmada('Explicação geral.', PEDIDO, 'c1', 0);
    assert(r === 'Explicação geral.', 'juiz aprovou → a resposta segue');

    r = await agenteCom(motorFalso({ estado: 'reprovado', extras: { tipo_de_falha: 'incomplete_response' } }), true).verificarAcaoAfirmada('Parcial.', PEDIDO, 'c1', 0);
    assert(r === 'Parcial.', 'outra reprovação de qualidade (não é ação afirmada) não bloqueia neste portão');

    r = await agenteCom(motorFalso({ estado: 'nao_avaliavel', naoAvaliavelPorque: 'prazo' }), true).verificarAcaoAfirmada(RESPOSTA_SALVO, PEDIDO, 'c1', 0);
    assert(r === RESPOSTA_SALVO, 'sem veredito por infraestrutura → não bloqueia');

    r = await agenteCom({ validar: async () => { throw new Error('motor fora'); } }, true).verificarAcaoAfirmada(RESPOSTA_SALVO, PEDIDO, 'c1', 0);
    assert(r === RESPOSTA_SALVO, 'erro do motor → entrega sem bloquear');

    r = await agenteCom(motorFalso({ estado: 'reprovado', extras: { tipo_de_falha: 'claimed_without_execution' } }), true).verificarAcaoAfirmada(RESPOSTA_SALVO, PEDIDO, 'c1', 0);
    assert(r.length > 20 && r !== RESPOSTA_SALVO, 'bloqueio sem mensagem do modelo → texto de reserva honesto, nunca a resposta falsa', r);

    process.env.VALIDACAO_ACAO_AFIRMADA = 'off';
    chamadas.length = 0;
    r = await agenteCom(motorFalso(BLOQUEAR), true).verificarAcaoAfirmada(RESPOSTA_SALVO, PEDIDO, 'c1', 0);
    delete process.env.VALIDACAO_ACAO_AFIRMADA;
    assert(r === RESPOSTA_SALVO && chamadas.length === 0, 'VALIDACAO_ACAO_AFIRMADA=off desliga o portão');

    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'loop', 'AgentLoop.ts'), 'utf-8');
    assert(/if \(!last\) return await this\.verificarAcaoAfirmada\(/.test(src), 'commitResponse: sem ferramenta executada, o turno passa pelo portão');
    assert(/exigeFerramenta = intentDecision\.requiresTools/.test(src), 'o fato do roteador (requiresTools) é gravado no estado do turno');
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S372 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;
}

main().catch((err) => { console.error('S372 erro inesperado:', err); process.exitCode = 1; });
