/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S368 (ADR-015, 09/10/2026)
 *
 * "Suficiência do pedido": depois da pergunta e antes de qualquer ferramenta, o motor único (ADR-014) responde se o
 * pedido traz — por si, pelas preferências, pela memória ou pela conversa — os dados do usuário que a ação exige.
 * Falta e ninguém tem → pergunta OBRIGATÓRIA ao usuário (regra do operador). Origem citada que não existe nas fontes
 * (o caso real: uma cidade que ninguém informou) → também pergunta.
 *
 * S368-1 — contrato: o tipo é válido; as extensões genéricas (camposExtras, fontesDaCitacao) são conferidas.
 * S368-2 — prompt: pede o campo extra e diz de onde a citação pode vir.
 * S368-3 — decisões, com o motor real e um modelo falso: seguir / resolver pela memória / origem inventada /
 *          falta / infraestrutura não bloqueia.
 * S368-4 — encaixe: GoalOrchestrator valida antes da divisão goal × agente, guarda o pedido e devolve a pergunta;
 *          é a autoridade única de "perguntar ou não"; desligável.
 */

import * as fs from 'fs';
import * as path from 'path';
import { ValidationEngine } from '../../validation/ValidationEngine';
import { criarRegistroPadrao } from '../../validation/motorPadrao';
import { validarDescritor } from '../../validation/contratoDeValidacao';
import { descritorSuficienciaDoPedido, TIPO_SUFICIENCIA_DO_PEDIDO, type DecisaoDeSuficiencia } from '../../validation/tipos/suficienciaDoPedido';

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string, detail?: unknown): void {
    if (cond) { console.log(`  ✅ ${msg}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${msg}`, detail ?? ''); failed++; }
}

function motorCom(resposta: object | null, status = 'success'): { motor: ValidationEngine; prompts: string[]; opcoes: any[] } {
    const prompts: string[] = [];
    const opcoes: any[] = [];
    const pf = {
        getBudgetAuxiliar: () => ({ timeoutMs: 30_000, origem: 'padrao', latenciaTipicaMs: null }),
        chatWithFallback: async (msgs: Array<{ content: string }>, _t: unknown, _p: unknown, _to: unknown, _s: unknown, _m: unknown, o: any) => {
            prompts.push(msgs[0].content); opcoes.push(o);
            return { status, content: resposta ? JSON.stringify(resposta) : '', attempts: [] };
        },
    } as any;
    return { motor: new ValidationEngine(pf, criarRegistroPadrao(), () => undefined), prompts, opcoes };
}
const PREF = '[PREFERÊNCIAS SALVAS DO USUÁRIO — …]\n• Clima padrão: Sem cidade informada, considere Curitiba para a previsão do tempo.';

async function main(): Promise<void> {
    console.log('\n=== S368-1 — contrato do tipo e das extensões ===');
    {
        assert(validarDescritor(descritorSuficienciaDoPedido as never).length === 0, 'o tipo suficiencia_do_pedido é válido');
        assert(criarRegistroPadrao().obter(TIPO_SUFICIENCIA_DO_PEDIDO) !== undefined, 'registrado no registro padrão do motor');
        const ruim = { ...descritorSuficienciaDoPedido, tipo: 'x_ruim', camposExtras: [{ nome: 'motivo', instrucao: 'x' }, { nome: 'Pergunta', instrucao: '' }] };
        const erros = validarDescritor(ruim as never);
        assert(erros.some(e => /colide/.test(e)) && erros.some(e => /snake_case/.test(e)) && erros.some(e => /sem instrução/.test(e)),
            'campo extra que colide com o veredito, fora de snake_case ou sem instrução é recusado no registro', erros);
        const semFonte = { ...descritorSuficienciaDoPedido, tipo: 'x_sem_fonte', fontesDaCitacao: ['contexto_do_usuario'] };
        assert(validarDescritor(semFonte as never).some(e => /fonte da citação/.test(e)), 'citação sem nenhuma entrada no papel declarado é recusada');
        assert(descritorSuficienciaDoPedido.raciocinio === 'livre' && descritorSuficienciaDoPedido.semVeredito === 'liberar',
            'raciocínio do provedor/modelo (livre); sem veredito não bloqueia (política declarada no descritor)');
    }

    console.log('\n=== S368-2 — prompt: campo extra pedido; citação pode vir do pedido ===');
    {
        const motor = new ValidationEngine({} as any, criarRegistroPadrao());
        const p = motor.montarPrompt(descritorSuficienciaDoPedido as never, { pedido: 'Vai chover amanhã de manhã?', preferencias: PREF });
        assert(/"pergunta_ao_usuario"/.test(p) && /CAMPOS ADICIONAIS DA RESPOSTA/.test(p), 'o formato pede pergunta_ao_usuario, com a instrução do tipo');
        assert(/trecho CURTO[^.]*que o decide, de: O QUE ESTÁ SENDO JULGADO ou FONTES DE VERDADE/.test(p), 'a citação pode vir do pedido ou das fontes');
        assert(/MESMO IDIOMA do pedido/.test(p), 'a pergunta ao usuário é escrita no idioma do pedido (o Core não emite texto fixo)');
        const ordem = ['CONTEXTO DO USUÁRIO', 'O QUE ESTÁ SENDO JULGADO', 'FONTES DE VERDADE'].map(s => p.indexOf(s));
        assert(ordem[0] === -1 && ordem[1] > 0 && ordem[2] > ordem[1], 'pedido como objeto, preferências como fonte de verdade');
    }

    console.log('\n=== S368-3 — decisões (motor real, modelo falso) ===');
    {
        const validar = (m: ValidationEngine, entradas: Record<string, string>) =>
            m.validar<DecisaoDeSuficiencia>(TIPO_SUFICIENCIA_DO_PEDIDO, entradas).then(r => r.adaptado);

        const nada = motorCom({ estado: 'aprovado', itens: [] });
        assert((await validar(nada.motor, { pedido: 'Por que as criptomoedas caíram hoje?' })).acao === 'seguir', 'nenhum dado do usuário exigido → seguir');
        assert(nada.opcoes[0]?.raciocinio === 'livre', 'a chamada leva raciocinio=livre (declarado pelo tipo)');

        const memoria = motorCom({ estado: 'aprovado', itens: [{ item: 'cidade da previsão', confere: 'sim', evidencia: 'Curitiba', trecho: 'considere Curitiba para a previsão do tempo' }], pergunta_ao_usuario: 'Para qual cidade?' });
        const d1 = await validar(memoria.motor, { pedido: 'Vai chover amanhã de manhã?', preferencias: PREF });
        assert(d1.acao === 'seguir' && d1.resolvidos[0]?.valor === 'Curitiba', 'dado resolvido pela preferência, com trecho que existe → seguir, valor e origem registrados', d1);

        const inventada = motorCom({ estado: 'aprovado', itens: [{ item: 'cidade da previsão', confere: 'sim', evidencia: 'Cidade Inventada', trecho: 'cidade padrão é Cidade Inventada' }], pergunta_ao_usuario: 'Para qual cidade você quer a previsão?' });
        const d2 = await validar(inventada.motor, { pedido: 'Vai chover amanhã de manhã?', preferencias: PREF });
        assert(d2.acao === 'perguntar' && d2.faltando[0] === 'cidade da previsão' && d2.pergunta === 'Para qual cidade você quer a previsão?',
            'o caso real: origem citada que não existe nas fontes → PERGUNTAR (nunca seguir com o valor inventado)', d2);

        const noPedido = motorCom({ estado: 'aprovado', itens: [{ item: 'cidade', confere: 'sim', evidencia: 'Recife', trecho: 'tempo em Recife' }] });
        assert((await validar(noPedido.motor, { pedido: 'Como está o tempo em Recife amanhã?' })).acao === 'seguir', 'valor que está no próprio pedido vale como origem');

        const falta = motorCom({ estado: 'reprovado', itens: [{ item: 'cidade da previsão', confere: 'nao' }], pergunta_ao_usuario: 'De qual cidade?' });
        const d3 = await validar(falta.motor, { pedido: 'Vai chover amanhã?' });
        assert(d3.acao === 'perguntar' && d3.pergunta === 'De qual cidade?', 'falta e ninguém tem → pergunta obrigatória, escrita pelo modelo');

        const fora = motorCom(null, 'timeout');
        const d4 = await validar(fora.motor, { pedido: 'Vai chover amanhã?' });
        assert(d4.acao === 'sem_veredito', 'prazo esgotado / modelo fora → sem veredito (não bloqueia o pedido)', d4);

        const lixo = motorCom({ nada: 'disso' } as any);
        // Um objeto sem `estado` nem `itens` não é veredito (S374): antes virava "nada exigido → seguir" — lixo lido como aprovação.
        // Agora é "sem veredito", que também não bloqueia o pedido (política do tipo: liberar), sem fingir que o modelo aprovou.
        assert((await validar(lixo.motor, { pedido: 'x' })).acao === 'sem_veredito', 'saída fora do contrato → sem veredito (não bloqueia, não finge aprovação)');
    }

    console.log('\n=== S368-4 — encaixe no GoalOrchestrator ===');
    {
        const src = fs.readFileSync(path.join(process.cwd(), 'src', 'loop', 'GoalOrchestrator.ts'), 'utf-8');
        const iSuf = src.indexOf('await this.verificarSuficiencia(');
        const iTimedOut = src.indexOf('if (classification.timedOut)');
        const iDivisao = src.indexOf('if (!routerRequiresGoal) {');
        assert(iSuf > 0 && iSuf < iTimedOut && iSuf < iDivisao, 'roda depois do roteador e ANTES da divisão goal × agente (os dois caminhos passam por ela)');
        assert(/\(routerRequiresTools \|\| routerRequiresGoal\) && process\.env\.VALIDACAO_SUFICIENCIA !== 'off'/.test(src), 'só para pedidos de ferramenta/planejamento; desligável');
        const blocoPergunta = src.slice(src.indexOf("if (decisao.acao === 'perguntar') {"), src.indexOf("if (decisao.acao === 'perguntar') {") + 800);
        assert(/return this\.guardarEsclarecimento\(sessionKey, message, decisao\.pergunta/.test(blocoPergunta),
            'pergunta → guarda o pedido com a pergunta (a resposta volta junta) e devolve a pergunta do modelo');
        assert(/this\.pendingClarifications\.set\(sessionKey, \{ originalMessage, timestamp: Date\.now\(\), pergunta \}\)/.test(src)
            && !/this\.pendingClarifications\.set\(sessionKey, \{ originalMessage: message, timestamp: Date\.now\(\) \}\)/.test(src),
            'todos os pontos de esclarecimento guardam a pergunta feita (um método só)');
        // Teste real 09/10: "Florianópolis" chegou como "[RESPOSTA DO USUÁRIO]: Florianópolis" e o agente respondeu
        // "a cidade já estava salva na memória" sem consultar o tempo.
        assert(/\[ESCLARECIMENTO — o assistente perguntou: "\$\{pending\.pergunta\}"; o usuário respondeu: "\$\{message\}"\. Atenda o pedido acima usando esta resposta\.\]/.test(src),
            'a resposta volta dizendo O QUE foi perguntado e mandando atender o pedido original');
        assert(/classification\.isAmbiguous && suficienciaDecidiu/.test(src), 'quando a suficiência decidiu, isAmbiguous não pergunta de novo (autoridade única)');
        assert(/criarMotorDeValidacao\(providerFactory\)/.test(src) && /this\.memory\.memoriaProximaDoPedido\(pedido, 5\)/.test(src) && /this\.memory\.getPreferences\(\)/.test(src),
            'motor único; preferências e memória das fontes únicas');
    }

    console.log(`\nS368 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(e => { console.error(e); process.exitCode = 1; });
