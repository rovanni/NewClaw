#!/usr/bin/env node
/**
 * Executa toda a suíte de regressão local (src/__tests__/regression/*.test.ts) via subprocesso
 * real e decide PASSOU/FALHOU pelo exit code de cada processo — não por inspeção de texto na
 * última linha de saída.
 *
 * Gate S4.5: a verificação usada até aqui (grep de texto tipo "❌ Falhou: [1-9]" na última linha)
 * não detecta exceção não tratada (o processo encerra com stack trace, não com a string esperada)
 * nem teste que segue rodando/imprimindo depois de uma assertion falhar sem chamar process.exit(1).
 * Isso permitiu falso verde em S12_RiskAnalyzer_SanitizePlanSteps.test.ts (mock desatualizado
 * causando TypeError não tratado) e S5_FundamentalTools_Q2Skip.test.ts (2 assertions falhando
 * sem abortar o processo). Este script corrige isso: cada arquivo roda em subprocesso próprio,
 * só o exit code decide passa/falha.
 *
 * Uso:
 *   node scripts/run-regression-tests.cjs             → roda a suíte real
 *   node scripts/run-regression-tests.cjs --selftest   → prova (fixtures descartáveis) que o
 *                                                          harness detecta pass/fail corretamente
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// Resolve o binário do ts-node e invoca via `node` diretamente (spawnSync(process.execPath, ...)),
// em vez de `npx`/`npx.cmd`. No Windows, spawnSync de um `.cmd` sem shell:true falha com EINVAL
// (o processo nem chega a rodar), e com shell:true o array de args é apenas concatenado pelo
// cmd.exe (childprocess emite até DEP0190 por causa disso), o que se mostrou não confiável em
// teste manual (exit code do processo real não propagava corretamente). Chamar o .js do ts-node
// via node é o caminho padrão, sem shell, sem shim de plataforma.
const tsNodeBin = require.resolve('ts-node/dist/bin.js');

function runOne(filePath) {
    const result = spawnSync(process.execPath, [tsNodeBin, filePath], { encoding: 'utf-8' });
    const crashed = result.error != null;
    const exitCode = crashed ? null : result.status;
    const ok = !crashed && exitCode === 0;
    return { file: filePath, ok, exitCode, crashed, stdout: result.stdout || '', stderr: result.stderr || '' };
}

function runSuite(dir) {
    const files = fs.existsSync(dir)
        ? fs.readdirSync(dir).filter((f) => f.endsWith('.test.ts')).sort().map((f) => path.join(dir, f))
        : [];

    const results = files.map(runOne);
    let failures = 0;
    for (const r of results) {
        const label = path.basename(r.file);
        if (r.ok) {
            console.log(`  OK   ${label}`);
        } else {
            failures++;
            console.error(`  FAIL ${label} (exitCode=${r.exitCode}, crashed=${r.crashed})`);
            const tail = (r.stderr || r.stdout).split('\n').slice(-15).join('\n');
            console.error(tail);
        }
    }
    return { total: results.length, failures };
}

function selfTest() {
    // Os fixtures PRECISAM viver dentro de src/ (mesmo que descartáveis): ts-node resolve
    // tsconfig.json subindo a partir do diretório do arquivo-alvo. Um arquivo fora da árvore
    // do projeto (ex: em os.tmpdir()) pode acabar herdando um tsconfig.json completamente
    // alheio ao projeto (ex: um global no perfil do usuário), causando comportamento
    // imprevisível — no caso observado, execução silenciosa sem rodar o conteúdo real do
    // arquivo (nem stdout, nem stderr, exit 0), o que mascarava justamente os casos de
    // falha que este selftest existe para provar. src/__tests__/ já é 100% gitignored
    // (local-only), então uma subpasta ali não suja o repositório.
    const tmpDir = fs.mkdtempSync(path.join(__dirname, '..', 'src', '__tests__', 'selftest_scratch_'));
    try {
        // /// <reference types="node" /> é obrigatório: o tsconfig do projeto não inclui tipos
        // globais implícitos (sem isso, `console`/`process` não compilam sob strict mode) —
        // mesma convenção usada em todo arquivo real de src/__tests__/regression/*.test.ts.
        const header = '/// <reference types="node" />\n';
        fs.writeFileSync(path.join(tmpDir, 'a_pass.test.ts'), `${header}console.log('fixture pass'); process.exit(0);\n`);
        fs.writeFileSync(path.join(tmpDir, 'b_fail_exit1.test.ts'), `${header}console.log('fixture fail exit1'); process.exit(1);\n`);
        fs.writeFileSync(path.join(tmpDir, 'c_fail_throw.test.ts'), `${header}throw new Error('fixture uncaught exception');\n`);
        // Reproduz o caso real que causou falso verde: assertion falha mas o processo
        // continua e termina com exit 0 (sem process.exit(1) explícito no fim).
        fs.writeFileSync(
            path.join(tmpDir, 'd_fail_silent_continue.test.ts'),
            `${header}console.error('❌ FALHOU: assertion'); console.log('mas o processo segue rodando e sai com 0');\n`
        );

        const passResult = runOne(path.join(tmpDir, 'a_pass.test.ts'));
        const failExitResult = runOne(path.join(tmpDir, 'b_fail_exit1.test.ts'));
        const failThrowResult = runOne(path.join(tmpDir, 'c_fail_throw.test.ts'));
        const silentContinueResult = runOne(path.join(tmpDir, 'd_fail_silent_continue.test.ts'));

        let ok = true;
        if (passResult.ok !== true) { console.error('SELFTEST FALHOU: fixture de sucesso (exit 0) deveria ser ok=true'); ok = false; }
        if (failExitResult.ok !== false) { console.error('SELFTEST FALHOU: fixture exit(1) deveria ser ok=false'); ok = false; }
        if (failThrowResult.ok !== false) { console.error('SELFTEST FALHOU: fixture com exceção não tratada deveria ser ok=false'); ok = false; }
        // Este caso é o único que o harness NÃO consegue pegar sozinho — documenta o limite
        // real: exit code correto depende do próprio teste chamar process.exit(1) ao falhar.
        // A responsabilidade de cada teste individual (assert() + process.exit(1) no final)
        // continua sendo do arquivo de teste; o harness garante que esse exit code É respeitado
        // pela suíte, não inventa detecção de falha textual por cima.
        if (silentContinueResult.ok !== true) {
            console.error('SELFTEST FALHOU: fixture que não chama process.exit(1) deveria mesmo assim sair com exit 0 (limite documentado, não é bug do harness)');
            ok = false;
        }

        if (ok) {
            console.log('SELFTEST OK:');
            console.log('  teste chama process.exit(0) ou termina normalmente  -> exit 0    -> suíte considera OK');
            console.log('  teste chama process.exit(1)                        -> exit 1    -> suíte considera FALHA');
            console.log('  teste lança exceção não tratada                    -> exit != 0 -> suíte considera FALHA');
            console.log('  limite documentado: teste que detecta falha mas não chama process.exit(1) não é pego por este harness — responsabilidade do próprio arquivo de teste, não do runner.');
        }
        return ok;
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
}

const isSelfTest = process.argv.includes('--selftest');

if (isSelfTest) {
    const ok = selfTest();
    process.exit(ok ? 0 : 1);
} else {
    // tests/regression/ é a suíte VERSIONADA (reproduzível em qualquer clone) — distinta de
    // src/__tests__/regression/, que continua existindo como área local-only de investigação
    // (gitignored, não lida aqui). Migrar uma regressão de local-only para versionada é uma
    // decisão deliberada de maturidade, feita arquivo a arquivo, não automática.
    //
    // Diretório ausente ou vazio NÃO é sucesso: antes, a ausência de src/__tests__/regression/
    // (o caso normal em qualquer clone limpo, já que era 100% gitignored) fazia este script
    // sair com exit 0 — um clone limpo reportava "suíte passou" mesmo protegendo zero bugs.
    // Fail-closed: 0 regressões encontradas é uma falha de configuração, não uma suíte vazia
    // e válida.
    const dir = path.join(__dirname, '..', 'tests', 'regression');
    const { total, failures } = runSuite(dir);
    console.log('');
    if (total === 0) {
        console.error(`SUÍTE: 0 regressões versionadas encontradas em ${dir} — falha (fail-closed). Um diretório ausente ou vazio não é sucesso.`);
        process.exit(1);
    }
    console.log(`SUÍTE: ${total - failures}/${total} passaram`);
    process.exit(failures > 0 ? 1 : 0);
}
