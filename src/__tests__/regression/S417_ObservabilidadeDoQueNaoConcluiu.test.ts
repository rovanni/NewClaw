/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S417
 * O que não concluiu deixa registro: juiz cortado (fim do que pensou/escreveu) e goal que esgotou os ciclos (o motivo).
 *
 * INCIDENTE REAL (Windows, 16/10/2026, goal_1792128547107_ogo6t): dois juízes pensaram 32 mil e 48 mil caracteres sem
 * concluir e o raciocínio foi descartado sem nenhum vestígio — não havia o que analisar para achar a causa. No fim, o
 * goal foi de "executing → failed" sem uma linha dizendo que o motivo era o limite de 12 ciclos com um passo pendente.
 * A mensagem ao usuário (S279) também não dizia — coberto lá, com a saída real do laço.
 *
 * REGRESSÃO SE: algum desses registros sumir.
 *
 * Execução: npx ts-node src/__tests__/regression/S417_ObservabilidadeDoQueNaoConcluiu.test.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { PerfilDoJuiz } from '../../validation/perfilDoJuiz';
import { ValidationEngine } from '../../validation/ValidationEngine';
import { criarRegistroPadrao } from '../../validation/motorPadrao';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}
const ler = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf-8');

async function main(): Promise<void> {
    console.log('\n=== S417-1 — juiz cortado: o fim do que escreveu vai para o log ===');
    {
        const linhas: string[] = [];
        const originais = { log: console.log, info: console.info, warn: console.warn, out: process.stdout.write.bind(process.stdout) };
        const registro = criarRegistroPadrao();
        const tipo = 'qualidade_da_resposta';
        const entradas = Object.fromEntries((registro.obter(tipo)?.entradas ?? []).filter(e => e.obrigatoria).map(e => [e.nome, 'x']));
        const pf = {
            getBudgetAuxiliar: () => ({ timeoutMs: 200, origem: 'padrao', latenciaTipicaMs: null }),
            chatWithFallback: async () => ({ status: 'cancelled', content: 'Vou analisar item por item... ainda conferindo o passo 7 MARCA_DO_FIM', attempts: [] }),
        } as any;
        const capturar = (...a: unknown[]) => { linhas.push(a.map(String).join(' ')); };
        console.log = console.info = console.warn = capturar;
        (process.stdout as any).write = (chunk: unknown) => { linhas.push(String(chunk)); return true; };
        try { await new ValidationEngine(pf, registro, () => 'modelo-teste', new PerfilDoJuiz()).validar(tipo, entradas); }
        finally { console.log = originais.log; console.info = originais.info; console.warn = originais.warn; (process.stdout as any).write = originais.out; }
        const sem = linhas.filter(l => l.includes('sem veredito'));
        assert(sem.length > 0 && sem.every(l => l.includes('MARCA_DO_FIM') && /escreveu \d+ chars até o corte/.test(l)), 'a linha "sem veredito" traz o tamanho e o FIM do que o modelo escreveu', sem);
    }

    console.log('\n=== S417-2 — raciocínio interrompido: descartado, mas o fim registrado ===');
    {
        const src = ler('src/core/OllamaProvider.ts');
        assert(/interrupted reasoning is never an answer\); fim do raciocínio: "\$\{thinking\.slice\(-600\)/.test(src), 'o log do descarte inclui os últimos 600 caracteres do raciocínio');
        assert(/if \(!content\) \{[\s\S]{0,700}throw streamErr;/.test(src), 'e o raciocínio continua NUNCA virando resposta (lança como antes)');
    }

    console.log('\n=== S417-3 — goal que esgota os ciclos: o motivo no log e na mensagem ===');
    {
        const src = ler('src/loop/GoalExecutionLoop.ts');
        assert(/MAX_CYCLES=\$\{GOAL_LIMITS\.MAX_CYCLES\} ciclos sem avanço esgotados \(ciclos no total=\$\{totalCycles\}\) — replans=/.test(src), 'linha de log com o limite (ciclos sem avanço), o total, os replanos e os passos pendentes');
        assert(/buildFailureMessage\(currentGoal, state\.cognitiveContext, motivoDaSaida\)/.test(src), 'o motivo vai para a autoridade única da mensagem de falha (comportamento real em S279)');
    }

    console.log(`\n=== S417: ${passed} passaram, ${failed} falharam ===`);
    if (failed > 0) process.exit(1);
}

main().catch(err => { console.error(err); process.exit(1); });
