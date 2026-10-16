/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S418
 * ReflectionMemory: a ferramenta consertada não herda as falhas da versão anterior (ADR-022).
 *
 * INCIDENTE REAL (Windows, 15–16/10/2026): depois do conserto do read_document (d2705e8, PDF via o Python que funciona),
 * o planejador escreveu "read_document tem 100% de falha histórica" e evitou a ferramenta — as falhas eram TODAS da
 * versão de antes do conserto. Mesmo mecanismo no teste de 16/10: o npm install cortado por tempo virou "falha do
 * exec_command", que alimenta o [BLOCK-HINT] de "100% de falha histórica".
 *
 * REGRESSÃO SE: a versão deixar de ser medida do código (hash), ou as perguntas "esta ferramenta costuma falhar?"
 * (findToolFailures / findHardConstraints) voltarem a somar registros de outra versão; ou registros antigos sem versão
 * passarem a valer para a versão atual; ou o comportamento mudar para ferramentas sem versão medida.
 *
 * Execução: npx ts-node src/__tests__/regression/S418_ReflexaoPorVersaoDaFerramenta.test.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import Database from 'better-sqlite3';
import { ReflectionMemory } from '../../memory/ReflectionMemory';
import { ToolRegistry } from '../../core/ToolRegistry';
import { ExecCommandTool } from '../../tools/exec_command';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

const NOME = '__s418_leitor__';
class LeitorAntigo { name = NOME; description = 'v1'; parameters = {}; async execute() { return { success: false, output: 'sem leitor' }; } }
class LeitorConsertado { name = NOME; description = 'v2'; parameters = {}; async execute() { return { success: true, output: 'lido com o Python que funciona' }; } }

function memoria(): { rm: ReflectionMemory; db: any } {
    const db = new (Database as any)(':memory:');
    return { rm: new ReflectionMemory({ getDatabase: () => db } as any), db };
}
const falhar = (rm: ReflectionMemory, n: number) => {
    for (let i = 0; i < n; i++) rm.record({ userInput: 'leia o pdf', intent: 'tarefa', toolUsed: NOME, approved: false, reason: 'sem leitor de PDF', confidence: 0.9 });
};

function main(): void {
    console.log('\n=== S418-1 — a versão é MEDIDA do código ===');
    {
        const arquivo = path.join(process.cwd(), 'src', 'tools', 'exec_command.ts');
        const esperado = createHash('sha256').update(fs.readFileSync(arquivo, 'utf-8')).digest('hex').slice(0, 12);
        if (!ToolRegistry.has('exec_command')) ToolRegistry.register(new ExecCommandTool(), { dangerous: true });
        assert(ToolRegistry.versao('exec_command') === esperado, 'ferramenta de verdade: hash do arquivo do módulo carregado', { obtido: ToolRegistry.versao('exec_command'), esperado });
        assert(ToolRegistry.versao('__nao_existe__') === undefined, 'ferramenta que não existe: sem versão (nada inventado)');
        ToolRegistry.register(new LeitorAntigo() as any);
        const v1 = ToolRegistry.versao(NOME);
        ToolRegistry.unregister(NOME);
        ToolRegistry.register(new LeitorConsertado() as any);
        const v2 = ToolRegistry.versao(NOME);
        assert(!!v1 && !!v2 && v1 !== v2, 'código diferente → versão diferente', { v1, v2 });
        ToolRegistry.unregister(NOME);
    }

    console.log('\n=== S418-2 — o caso real: falhas da versão antiga não valem para a consertada ===');
    {
        const { rm, db } = memoria();
        ToolRegistry.register(new LeitorAntigo() as any);
        falhar(rm, 3);
        assert(/Falha: 100% \(3\/3\)/.test(rm.findToolFailures(NOME)), 'na MESMA versão, o padrão de falha aparece (o aprendizado continua valendo)', rm.findToolFailures(NOME));
        assert(rm.findHardConstraints([NOME]).some(c => c.includes(`'${NOME}' falhou em 100%`)), 'e vira restrição dura, como antes');
        const gravadas = db.prepare('SELECT DISTINCT tool_version v FROM reflection_annotations').all() as { v: string }[];
        assert(gravadas.length === 1 && gravadas[0].v === ToolRegistry.versao(NOME), 'cada registro guarda a versão da ferramenta', gravadas);

        ToolRegistry.unregister(NOME);
        ToolRegistry.register(new LeitorConsertado() as any);   // o "deploy do conserto"
        assert(rm.findToolFailures(NOME) === '', 'versão consertada: nenhum "100% de falha histórica" herdado', rm.findToolFailures(NOME));
        assert(rm.findHardConstraints([NOME]).length === 0, 'nem restrição dura herdada');

        falhar(rm, 2);
        assert(/Falha: 100% \(2\/2\)/.test(rm.findToolFailures(NOME)), 'se a versão NOVA também falhar, ela aprende de novo (só as falhas dela: 2/2)', rm.findToolFailures(NOME));
        ToolRegistry.unregister(NOME);
    }

    console.log('\n=== S418-3 — registros antigos (sem versão) e ferramenta sem versão medida ===');
    {
        const { rm, db } = memoria();
        falhar(rm, 3);   // ferramenta não registrada: sem versão → gravado com NULL
        assert((db.prepare('SELECT COUNT(*) c FROM reflection_annotations WHERE tool_version IS NULL').get() as any).c === 3, 'sem versão medida, grava NULL');
        assert(/Falha: 100% \(3\/3\)/.test(rm.findToolFailures(NOME)), 'e as consultas seguem como antes (somam tudo)', rm.findToolFailures(NOME));
        ToolRegistry.register(new LeitorConsertado() as any);
        assert(rm.findToolFailures(NOME) === '', 'com versão medida, registros antigos sem versão não valem para ela (eram de um código que ninguém sabe qual)');
        ToolRegistry.unregister(NOME);
    }

    console.log(`\n=== S418: ${passed} passaram, ${failed} falharam ===`);
    if (failed > 0) process.exit(1);
}

main();
