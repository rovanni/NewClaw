/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S373 (campanha 09/10/2026: "um juiz só, distribuído no lugar dos seis")
 *
 * Os seis validadores antigos (grounding, qualidade, passo, conclusão, risco, conteúdo-molde) tinham, cada um, o próprio
 * prompt, o próprio leitor de JSON, o próprio prazo, o próprio modelo e a própria política de falha — mexer em um não
 * mexia nos outros e eles divergiam. Agora decidem TODOS pelo mesmo motor (`ValidationEngine`); o que muda de um para
 * outro é o descritor (dados). Este teste trava a padronização:
 *
 * S373-1 — o registro: todo tipo declara a política de "sem veredito", tem adaptador, raciocínio desligado e nenhum tem
 *          chave de modelo própria.
 * S373-2 — um ÚNICO ponto muda o modelo de todos os tipos (e o `setModel` do observador do painel chega nele).
 * S373-3 — nenhum consumidor tem mais prompt/leitor de JSON/modelo de juiz próprios; todos chamam o motor; sem sombra.
 * S373-4 — o motor expõe a política declarada (deveBloquear) — o consumidor não a reescreve.
 *
 * Execução: npx ts-node src/__tests__/regression/S373_OneJudge_AllValidatorsOnTheEngine.test.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { ValidationEngine } from '../../validation/ValidationEngine';
import { criarRegistroPadrao, obterMotor } from '../../validation/motorPadrao';
import { ObserverValidator } from '../../loop/ObserverValidator';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

const lerFonte = (rel: string): string => fs.readFileSync(path.join(process.cwd(), rel), 'utf-8');

function fabricaQueRegistra(modelos: Array<string | undefined>, saida: object | null) {
    return {
        getBudgetAuxiliar: () => ({ timeoutMs: 30_000, origem: 'padrao', latenciaTipicaMs: null }),
        chatWithFallback: async (_m: unknown, _t: unknown, _p: unknown, _to: unknown, _s: unknown, modelo: string | undefined) => {
            modelos.push(modelo);
            return saida ? { status: 'success', content: JSON.stringify(saida), attempts: [] } : { status: 'timeout', content: '', attempts: [] };
        },
    } as any;
}

async function main(): Promise<void> {

console.log('\n=== S373-1 — todo tipo segue o mesmo padrão ===');
{
    const tipos = criarRegistroPadrao().tipos() as any[];
    assert(tipos.length === 7, 'sete tipos registrados', tipos.map(t => t.tipo));
    for (const d of tipos) {
        assert(d.semVeredito === 'bloquear' || d.semVeredito === 'liberar', `${d.tipo}: declara a política de "sem veredito"`, d.semVeredito);
        assert(typeof d.adaptador === 'function', `${d.tipo}: tem adaptador (a tradução para o consumidor é do tipo, não do consumidor)`);
        assert(d.raciocinio === 'desligado', `${d.tipo}: raciocínio desligado`);
        assert(!('modeloConfig' in d), `${d.tipo}: sem chave de modelo própria (um modelo do juiz para todos)`);
    }
    const porTipo = Object.fromEntries(tipos.map(t => [t.tipo, t.semVeredito]));
    assert(porTipo.saida_contra_evidencia === 'bloquear' && porTipo.conclusao_do_objetivo === 'bloquear' && porTipo.conteudo_molde === 'bloquear',
        'fail-closed onde sempre foi (grounding, conclusão do objetivo, conteúdo-molde)', porTipo);
}

console.log('\n=== S373-2 — um único ponto muda o modelo de todos os tipos ===');
{
    const modelos: Array<string | undefined> = [];
    const motor = new ValidationEngine(fabricaQueRegistra(modelos, { estado: 'aprovado', itens: [], tipo_de_falha: 'none' }), criarRegistroPadrao(), () => 'do-ambiente');
    await motor.validar('qualidade_da_resposta', { pedido: 'p', resposta: 'r' });
    motor.definirModeloDoJuiz('escolhido-no-painel');
    await motor.validar('qualidade_da_resposta', { pedido: 'p', resposta: 'r' });
    await motor.validar('conteudo_molde', { texto: 'texto' });
    await motor.validar('risco_do_plano', { pedido: 'p', plano: '1. x' });
    motor.definirModeloDoJuiz(undefined);
    await motor.validar('conteudo_molde', { texto: 'texto' });
    assert(modelos[0] === 'do-ambiente', 'sem escolha em tempo de execução: a chave única do ambiente (OBSERVER_MODEL)', modelos);
    assert(modelos[1] === 'escolhido-no-painel' && modelos[2] === 'escolhido-no-painel' && modelos[3] === 'escolhido-no-painel', 'definirModeloDoJuiz vale para TODOS os tipos', modelos);
    assert(modelos[4] === 'do-ambiente', 'limpar a escolha volta à configuração', modelos);

    // O observador do painel (AgentLoop.updateConfig → observer.setModel) chega no mesmo ponto.
    const m2: Array<string | undefined> = [];
    const pf = fabricaQueRegistra(m2, { estado: 'aprovado', itens: [], tipo_de_falha: 'none' });
    const obs = new ObserverValidator(pf, '');
    obs.setModel('modelo-do-painel');
    await obterMotor(pf).validar('conteudo_molde', { texto: 'x' });
    assert(m2[0] === 'modelo-do-painel', 'ObserverValidator.setModel repassa ao motor único', m2);
}

console.log('\n=== S373-3 — os consumidores não têm mais juiz próprio ===');
{
    const consumidores: Array<[string, string]> = [
        ['grounding', 'src/loop/ObserverValidator.ts'], ['qualidade', 'src/loop/ObserverValidator.ts'],
        ['passo', 'src/loop/StepSemanticValidator.ts'], ['conclusão', 'src/loop/GoalExecutionLoop.ts'],
        ['risco', 'src/loop/RiskAnalyzer.ts'], ['conteúdo-molde', 'src/shared/contentStubClassifier.ts'],
    ];
    for (const [nome, arq] of consumidores) {
        const s = lerFonte(arq);
        assert(/obterMotor\(/.test(s), `${nome} (${arq}): chama o motor único`);
        assert(!/rodarEmSombra|OBSERVER_PROMPT|GROUNDING_PROMPT|SEMANTIC_VALIDATOR_MODEL|CONTENT_STUB_CLASSIFIER_MODEL|extractApprovedJson|parseGroundingOutput/.test(s),
            `${nome}: sem prompt, leitor de JSON, modelo ou sombra do juiz antigo`);
    }
    const stub = lerFonte('src/shared/contentStubClassifier.ts');
    const passo = lerFonte('src/loop/StepSemanticValidator.ts');
    assert(!/chatWithFallback/.test(stub) && !/chatWithFallback/.test(passo), 'conteúdo-molde e passo não chamam o provedor direto');
    const obs = lerFonte('src/loop/ObserverValidator.ts');
    assert(!/chatWithFallback/.test(obs), 'ObserverValidator (grounding e qualidade) não chama o provedor direto');
    assert(!fs.existsSync(path.join(process.cwd(), 'src', 'validation', 'sombra.ts')), 'a máquina de sombra não existe mais (decide o motor, não o juiz antigo)');
}

console.log('\n=== S373-4 — o motor expõe a política declarada ===');
{
    const semModelo = fabricaQueRegistra([], null);
    const motor = new ValidationEngine(semModelo, criarRegistroPadrao());
    const molde = await motor.validar('conteudo_molde', { texto: 'qualquer texto' });
    assert(molde.semVeredito === true && molde.deveBloquear === true, 'conteudo_molde sem veredito → deveBloquear (política do tipo)', molde.veredito);
    const risco = await motor.validar('risco_do_plano', { pedido: 'p', plano: '1. x' });
    assert(risco.semVeredito === true && risco.deveBloquear === false, 'risco_do_plano sem veredito → não bloqueia (política do tipo)', risco.veredito);
    const ok = await new ValidationEngine(fabricaQueRegistra([], { estado: 'aprovado', itens: [] }), criarRegistroPadrao()).validar('conteudo_molde', { texto: 't' });
    assert(ok.semVeredito === false && ok.deveBloquear === false, 'com veredito, a política não entra');
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S373 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;
}

main().catch((err) => { console.error('S373 erro inesperado:', err); process.exitCode = 1; });
