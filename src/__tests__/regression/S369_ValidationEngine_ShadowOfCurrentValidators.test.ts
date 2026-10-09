/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S369 (ADR-014 M1–M6 em sombra, 09/10/2026)
 *
 * Os validadores atuais ganham o seu tipo no motor único, rodando em SOMBRA: depois do veredito real, sem bloquear e
 * sem mudar nada, com as MESMAS entradas; a comparação vai para o gravador de voo (`sombra_motor_comparada`) — é a
 * evidência do critério de troca (ADR-014 §5). Desligado por padrão (`VALIDACAO_SOMBRA`): no servidor local, que
 * atende um pedido por vez, cada sombra é uma chamada a mais na fila do usuário.
 *
 * S369-1 — os 7 tipos registram e passam no contrato.
 * S369-2 — liga/desliga por tipo; desligada, nenhuma chamada ao modelo.
 * S369-3 — ligada: roda com as entradas dadas, compara, e uma falha nunca alcança quem chamou.
 * S369-4 — escala do juiz de grounding preservada na comparação.
 * S369-5 — os cinco validadores atuais penduram a sombra com as mesmas entradas do julgamento real.
 */

import * as fs from 'fs';
import * as path from 'path';
import { criarRegistroPadrao, sombraLigadaPara } from '../../validation/motorPadrao';
import { validarDescritor } from '../../validation/contratoDeValidacao';
import { rodarEmSombra } from '../../validation/sombra';
import { estadoDeGrounding } from '../../validation/tipos/saidaContraEvidencia';

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string, detail?: unknown): void {
    if (cond) { console.log(`  ✅ ${msg}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${msg}`, detail ?? ''); failed++; }
}
const esperar = (ms: number) => new Promise(r => setTimeout(r, ms));
const ler = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), ...p), 'utf-8');

function fabrica(resposta: object | Error) {
    const prompts: string[] = [];
    return {
        prompts,
        pf: {
            getBudgetAuxiliar: () => ({ timeoutMs: 30_000, origem: 'padrao', latenciaTipicaMs: null }),
            chatWithFallback: async (msgs: Array<{ content: string }>) => {
                prompts.push(msgs[0].content);
                if (resposta instanceof Error) throw resposta;
                return { status: 'success', content: JSON.stringify(resposta), attempts: [] };
            },
        } as any,
    };
}

async function main(): Promise<void> {
    console.log('\n=== S369-1 — os 7 tipos ===');
    {
        const tipos = criarRegistroPadrao().tipos();
        const nomes = tipos.map(t => t.tipo);
        assert(['suficiencia_do_pedido', 'saida_contra_evidencia', 'qualidade_da_resposta', 'resultado_do_passo', 'risco_do_plano', 'conclusao_do_objetivo', 'conteudo_molde']
            .every(n => nomes.includes(n)), `todos registrados (${nomes.join(', ')})`);
        assert(tipos.every(t => validarDescritor(t).length === 0), 'todos passam na validação do contrato');
        assert(tipos.every(t => t.raciocinio === 'desligado'), 'todos com raciocínio desligado (a medição pedida pelo ADR-014)');
    }

    console.log('\n=== S369-2 — liga/desliga por tipo ===');
    {
        delete process.env.VALIDACAO_SOMBRA;
        assert(!sombraLigadaPara('qualidade_da_resposta'), 'sem VALIDACAO_SOMBRA → desligada (padrão)');
        process.env.VALIDACAO_SOMBRA = 'saida_contra_evidencia, risco_do_plano';
        assert(sombraLigadaPara('risco_do_plano') && !sombraLigadaPara('qualidade_da_resposta'), 'lista por tipo');
        process.env.VALIDACAO_SOMBRA = 'todos';
        assert(sombraLigadaPara('conteudo_molde'), '"todos" liga todos');
        delete process.env.VALIDACAO_SOMBRA;
        const f = fabrica({ estado: 'aprovado', itens: [] });
        rodarEmSombra({ providerFactory: f.pf, tipo: 'qualidade_da_resposta', entradas: { pedido: 'p', resposta: 'r' }, avaliadorAtual: 'validador_qualidade', estadoAtual: 'aprovado', estadoDoMotor: (_: unknown, v: any) => v.estado });
        await esperar(50);
        assert(f.prompts.length === 0, 'desligada → nenhuma chamada ao modelo');
    }

    console.log('\n=== S369-3 — ligada: roda, compara, e nunca alcança quem chamou ===');
    {
        process.env.VALIDACAO_SOMBRA = 'todos';
        const f = fabrica({ estado: 'reprovado', itens: [], motivo: 'x' });
        const retorno: unknown = rodarEmSombra({
            providerFactory: f.pf, tipo: 'qualidade_da_resposta',
            entradas: { pedido: 'PEDIDO-INTEIRO', resposta: 'RESPOSTA-INTEIRA', ferramentas: 'SAIDA-DA-FERRAMENTA' },
            avaliadorAtual: 'validador_qualidade', estadoAtual: 'aprovado', estadoDoMotor: (_: unknown, v: any) => v.estado,
        });
        assert(retorno === undefined, 'quem chama não espera a sombra — não há promessa a aguardar (dispara e segue)');
        await esperar(100);
        assert(f.prompts.length === 1 && ['PEDIDO-INTEIRO', 'RESPOSTA-INTEIRA', 'SAIDA-DA-FERRAMENTA'].every(t => f.prompts[0].includes(t)),
            'a sombra recebe as entradas inteiras');
        const quebrada = fabrica(new Error('provedor caiu'));
        let vazou = false;
        process.on('unhandledRejection', () => { vazou = true; });
        rodarEmSombra({ providerFactory: quebrada.pf, tipo: 'conteudo_molde', entradas: { texto: 't' }, avaliadorAtual: 'validacao_conteudo_molde', estadoAtual: 'aprovado', estadoDoMotor: (_: unknown, v: any) => v.estado });
        await esperar(100);
        assert(!vazou, 'falha do motor na sombra não vaza (nenhuma rejeição não tratada)');
        delete process.env.VALIDACAO_SOMBRA;
    }

    console.log('\n=== S369-4 — escala do juiz de grounding ===');
    {
        const it = (confere: 'sim' | 'nao' | 'sem_evidencia') => ({ item: 'a', confere });
        assert(estadoDeGrounding({ estado: 'aprovado', itens: [] }) === 'NOT_APPLICABLE', 'sem afirmação derivada → NOT_APPLICABLE');
        assert(estadoDeGrounding({ estado: 'aprovado', itens: [it('sim')] }) === 'VALIDATED', 'todas sustentadas → VALIDATED');
        assert(estadoDeGrounding({ estado: 'reprovado', itens: [it('nao')] }) === 'REJECTED', 'alguma contradita → REJECTED');
        assert(estadoDeGrounding({ estado: 'nao_avaliavel', itens: [it('sem_evidencia')] }) === 'NOT_EVALUABLE', 'alguma não determinada → NOT_EVALUABLE');
        assert(estadoDeGrounding({ estado: 'nao_avaliavel', itens: [], naoAvaliavelPorque: 'prazo' }) === 'UNVALIDATED', 'motor sem veredito → UNVALIDATED');
    }

    console.log('\n=== S369-5 — ganchos nos cinco validadores atuais ===');
    {
        const ov = ler('src', 'loop', 'ObserverValidator.ts');
        assert(/rodarEmSombra<EstadoDeGrounding>\(\{[\s\S]{0,200}tipo: TIPO_SAIDA_CONTRA_EVIDENCIA,[\s\S]{0,120}entradas: \{ pedido, resposta: response, evidencias: blocoEvidencias \}/.test(ov),
            'juiz de grounding: o MESMO bloco de evidências, a resposta inteira e o pedido');
        assert(/tipo: 'qualidade_da_resposta'[\s\S]{0,200}entradas: \{ pedido: userMessage, resposta: finalResponse, intencao: intent/.test(ov) && /reg\.desfecho === 'veredito' && !result\.validationSkipped/.test(ov),
            'qualidade: mesmas entradas, só quando houve veredito real');
        assert(/tipo: 'resultado_do_passo'[\s\S]{0,200}pedido: goalIntent, resultado: toolOutput/.test(ler('src', 'loop', 'StepSemanticValidator.ts')), 'passo: resultado íntegro e pedido');
        const ra = ler('src', 'loop', 'RiskAnalyzer.ts');
        assert(/if \(!shadow\) \{[\s\S]{0,300}tipo: 'risco_do_plano'/.test(ra), 'risco: só na revisão real (a sombra própria do RiskAnalyzer não gera outra)');
        assert(/tipo: 'conclusao_do_objetivo'[\s\S]{0,300}pedido: goal\.userIntent, alvo: validationTarget/.test(ler('src', 'loop', 'GoalExecutionLoop.ts')), 'conclusão: as mesmas seções do prompt atual');
        assert(/tipo: 'conteudo_molde'[\s\S]{0,120}entradas: \{ pedido, texto: content, ferramenta: toolName \}/.test(ler('src', 'shared', 'contentStubClassifier.ts')), 'conteúdo-molde: o texto inteiro');
        assert(/new WeakMap<object, ValidationEngine>/.test(ler('src', 'validation', 'sombra.ts')), 'um motor por fábrica de provedores (sem instância por chamada)');
    }

    console.log(`\nS369 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(e => { console.error(e); process.exitCode = 1; });
