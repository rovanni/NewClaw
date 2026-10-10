#!/usr/bin/env node
/**
 * Auditoria dinâmica (não faz parte da suíte): prova que CADA teste de regressão consegue falhar.
 *
 * Para cada `*.test.ts`, cria uma cópia temporária (`__mut__<nome>.negative.ts`, que o runner não descobre) com o helper de asserção
 * forçado a reprovar (scripts/mutacao-de-asserts.cjs), executa-a pelo MESMO executor do runner (runOne) e classifica:
 *   - detecta      → a cópia termina com exit != 0 (falha, timeout ou exceção): o teste sinaliza a violação;
 *   - ignorado     → o teste se declara ignorado (SKIP + 77) antes de qualquer asserção: não mutável neste ambiente;
 *   - marca-so     → exit 0, mas imprimiu "FALHOU:": o runner o marca INCONSISTENTE, porém o teste não propaga a falha sozinho;
 *   - NAO-FALHA    → exit 0 e nenhuma falha impressa: o teste termina antes das asserções ou as ignora — não consegue falhar;
 *   - sem-mutacao  → o arquivo não tem o helper no formato conhecido (precisa de auditoria manual).
 *
 * Uso: node scripts/auditoria-sinalizacao-de-falha.cjs [--report out.json] [--filter texto] [--timeout ms]
 * As cópias são removidas ao final (e no início, caso uma execução anterior tenha sido interrompida).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { runOne, discover } = require('./run-regression-tests.cjs');
const { mutarHelper } = require('./mutacao-de-asserts.cjs');

const args = process.argv.slice(2);
const valor = (nome) => { const i = args.findIndex((a) => a === nome || a.startsWith(nome + '=')); if (i < 0) return null; return args[i].includes('=') ? args[i].split('=').slice(1).join('=') : args[i + 1]; };
const relatorio = valor('--report');
const filtro = valor('--filter');
const timeoutMs = Number(valor('--timeout') || 300000);

const dir = path.join(__dirname, '..', 'src', '__tests__', 'regression');
const limpar = () => { for (const f of fs.readdirSync(dir)) if (f.startsWith('__mut__') && f.endsWith('.negative.ts')) fs.rmSync(path.join(dir, f), { force: true }); };
limpar();

const arquivos = discover(dir, filtro);
const resultados = [];
const t0 = Date.now();
try {
    for (const arq of arquivos) {
        const nome = path.basename(arq);
        const original = fs.readFileSync(arq, 'utf-8');
        const mutada = mutarHelper(original);
        if (mutada === null || mutada === original) { resultados.push({ nome, classe: 'sem-mutacao' }); console.log(`  SEM-MUTACAO  ${nome}`); continue; }
        const copia = path.join(dir, `__mut__${nome.replace(/\.test\.ts$/, '')}.negative.ts`);
        fs.writeFileSync(copia, mutada);
        let r;
        try { r = runOne(copia, timeoutMs); } finally { fs.rmSync(copia, { force: true }); }
        let classe;
        if (r.status === 'skipped') classe = 'ignorado';
        else if (r.status === 'failed' || r.status === 'timeout' || r.status === 'crashed') classe = 'detecta';
        else if (r.status === 'inconsistent') classe = 'marca-so';
        else classe = 'NAO-FALHA';
        resultados.push({ nome, classe, status: r.status, exitCode: r.exitCode, marcadores: r.failMarkers, duracaoMs: r.durationMs });
        console.log(`  ${classe.toUpperCase().padEnd(11)} ${nome}  (status ${r.status}, exit ${r.exitCode}, "FALHOU:" ${r.failMarkers}x)`);
    }
} finally {
    limpar();
}

const conta = (c) => resultados.filter((r) => r.classe === c).length;
const resumo = { arquivos: resultados.length, detecta: conta('detecta'), ignorado: conta('ignorado'), marcaSo: conta('marca-so'), naoFalha: conta('NAO-FALHA'), semMutacao: conta('sem-mutacao'), duracaoMs: Date.now() - t0 };
console.log('\nRESUMO:', JSON.stringify(resumo));
if (resumo.naoFalha) console.log('NÃO CONSEGUEM FALHAR:', resultados.filter((r) => r.classe === 'NAO-FALHA').map((r) => r.nome).join(', '));
if (resumo.marcaSo) console.log('SÓ O RUNNER OS MARCA (o teste não propaga):', resultados.filter((r) => r.classe === 'marca-so').map((r) => r.nome).join(', '));
if (resumo.semMutacao) console.log('SEM MUTAÇÃO (auditoria manual):', resultados.filter((r) => r.classe === 'sem-mutacao').map((r) => r.nome).join(', '));
if (relatorio) { fs.mkdirSync(path.dirname(path.resolve(relatorio)), { recursive: true }); fs.writeFileSync(relatorio, JSON.stringify({ resumo, resultados }, null, 2)); console.log('Relatório:', relatorio); }
process.exit(resumo.naoFalha || resumo.marcaSo ? 1 : 0);
