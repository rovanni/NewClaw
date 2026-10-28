/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S451 (28/10/2026)
 *
 * O modelo do juiz é UM só e mora no motor único da fábrica de provedores (ADR-014, `obterMotor`). Quem valida usa esse
 * motor, nunca uma instância própria: a troca de modelo no painel (`ObserverValidator.setModel`) só chega ao motor único.
 *
 * ORIGEM: instalação Windows, 27/10/2026. Às 18:06 o painel voltou o juiz para `glm-5.3-flash:cloud` (e às 17:51 o tinha
 * posto em `gpt-oss-20b`), mas `suficiencia_do_pedido` (motor próprio do GoalOrchestrator) e `qualidade_da_resposta`
 * (motor próprio do AgentLoop) seguiram pedindo `Qwen3.8-27B-UD-Q4_K_M.gguf` ao Ollama: HTTP 404 três vezes até 18:27,
 * enquanto os outros tipos, pelo motor único, já usavam o modelo novo.
 *
 * REGRESSÃO SE: algum consumidor fora de validation/motorPadrao.ts criar o próprio motor (`criarMotorDeValidacao` ou
 * `new ValidationEngine`); ou o modelo definido pelo painel deixar de ser o que o motor único manda ao provedor.
 *
 * Execução: npx ts-node src/__tests__/regression/S451_JuizSempreNoMotorUnico.test.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { obterMotor, criarMotorDeValidacao } from '../../validation/motorPadrao';
import { TIPO_SUFICIENCIA_DO_PEDIDO } from '../../validation/tipos/suficienciaDoPedido';

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string, detail?: unknown): void {
    if (cond) { console.log(`  ✅ ${msg}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${msg}`, detail ?? ''); failed++; }
}

const SRC = path.join(__dirname, '..', '..');

function arquivosTs(dir: string): string[] {
    const out: string[] = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== '__tests__') out.push(...arquivosTs(p)); }
        else if (e.name.endsWith('.ts')) out.push(p);
    }
    return out;
}

/** Fábrica falsa que anota o modelo pedido em cada chamada (6º argumento de chatWithFallback). */
function fabrica(): { pf: any; modelos: Array<string | undefined> } {
    const modelos: Array<string | undefined> = [];
    const pf = {
        getBudgetAuxiliar: () => ({ timeoutMs: 30_000, origem: 'padrao', latenciaTipicaMs: null }),
        chatWithFallback: async (...args: unknown[]) => {
            modelos.push(args[5] as string | undefined);
            return { status: 'success', content: JSON.stringify({ acao: 'seguir', faltando: [], resolvidos: [] }), attempts: [] };
        },
    };
    return { pf, modelos };
}

const ENTRADAS = { pedido: 'liste os arquivos da pasta tmp', preferencias: '', memoria: '', conversa: '', ferramentas: '- exec_command: roda comandos', skills: '' };

async function main(): Promise<void> {
    console.log('\n🧪 S451 — o juiz sempre pelo motor único\n');

    console.log('Controle: uma instância própria não enxerga o modelo trocado no motor único (o defeito de 27/10)');
    {
        const { pf, modelos } = fabrica();
        const proprio = criarMotorDeValidacao(pf);
        obterMotor(pf).definirModeloDoJuiz('modelo-novo');
        await proprio.validar(TIPO_SUFICIENCIA_DO_PEDIDO, ENTRADAS);
        assert(modelos.length > 0 && modelos.every(m => m !== 'modelo-novo'), 'instância própria ignora a troca', modelos);
    }

    console.log('\nO modelo trocado pelo painel é o que o motor único pede ao provedor');
    {
        const { pf, modelos } = fabrica();
        const { ObserverValidator } = await import('../../loop/ObserverValidator');
        const observer = new ObserverValidator(pf, 'modelo-antigo');
        await obterMotor(pf).validar(TIPO_SUFICIENCIA_DO_PEDIDO, ENTRADAS);
        const antes = modelos.splice(0);
        observer.setModel('modelo-novo');
        await obterMotor(pf).validar(TIPO_SUFICIENCIA_DO_PEDIDO, ENTRADAS);
        assert(antes.length > 0 && antes.every(m => m === 'modelo-antigo'), 'antes da troca: o modelo da configuração', antes);
        assert(modelos.length > 0 && modelos.every(m => m === 'modelo-novo'), 'depois da troca: o modelo do painel', modelos);
    }

    console.log('\nGuarda: nenhum consumidor cria o próprio motor');
    {
        const fora = arquivosTs(SRC)
            .filter(f => path.relative(SRC, f) !== path.join('validation', 'motorPadrao.ts'))
            .filter(f => /criarMotorDeValidacao\(|new ValidationEngine\(/.test(fs.readFileSync(f, 'utf-8')))
            .map(f => path.relative(SRC, f));
        assert(fora.length === 0, 'só motorPadrao.ts cria o motor', fora);
        const agentLoop = fs.readFileSync(path.join(SRC, 'loop', 'AgentLoop.ts'), 'utf-8');
        const orquestrador = fs.readFileSync(path.join(SRC, 'loop', 'GoalOrchestrator.ts'), 'utf-8');
        assert(/this\.motorDeValidacao = obterMotor\(providerFactory\)/.test(agentLoop), 'AgentLoop (qualidade_da_resposta) usa o motor único');
        assert(/this\.motorDeValidacao = obterMotor\(providerFactory\)/.test(orquestrador), 'GoalOrchestrator (suficiencia_do_pedido) usa o motor único');
    }

    console.log(`\n${passed} passaram, ${failed} falharam\n`);
    if (failed > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
