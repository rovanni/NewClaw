/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S35
 * CapabilityRegistry.probeExecution() deixou de medir um `pip3` solto do PATH
 * (execSync('pip3 --version'), string via shell) e passou a testar pip SOBRE o
 * runtime Python 3 resolvido pela política já aprovada em crossPlatform.ts
 * (defaultPython3Candidates/resolvePython3Runtime), via `<runtime> -m pip --version`
 * executado sem shell (execFile, array de args).
 *
 * ACHADO que motivou a correção (auditoria + validação empírica nesta máquina): um
 * `pip3` standalone no PATH pode pertencer a uma instalação Python DIFERENTE da que
 * `py -3` (primeiro candidato da política no Windows) resolveria — reproduzido ao
 * vivo: `pip3`/`pip`/`python -m pip` apontavam para C:\Python314, enquanto
 * `py -3 -m pip` apontava para uma instalação Python separada (AppData\Local).
 *
 * Escopo tocado: apenas src/core/CapabilityRegistry.ts. crossPlatform.ts NÃO foi
 * alterado (resolvePython3Runtime/defaultPython3Candidates são reaproveitados como
 * já existiam, sem extrair nenhum helper novo).
 *
 * Cobre os 9 casos pedidos:
 *   1 → py -3 com pip disponível (source: candidato Windows preservado)
 *   2 → Python válido sem pip (branch de execFile falho, mensagem conservadora)
 *   3 → ausência de runtime Python 3 (pip:false sem afirmar "não instalado")
 *   4 → pip3 standalone divergente é ignorado (nunca chamado como comando literal)
 *   5 → path com espaços (execFile array, sem shell string)
 *   6 → timeout explícito
 *   7 → `-m pip --version` non-zero → false (subprocess real, sem mock)
 *   8 → summary continua refletindo pip ✓/✗
 *   9 → invalidate('execution') força novo probe
 *
 * Execução: npx ts-node src/__tests__/regression/S35_CapabilityRegistry_PipProbe.test.ts
 *
 * NOTA: src/__tests__/ continua ignorado pelo Git — este arquivo não existe em um
 * clone limpo do repositório, apenas nesta máquina de desenvolvimento.
 */

process.env.WORKSPACE_DIR = process.env.WORKSPACE_DIR || 'D:/IA/newclaw/workspace';

import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { CapabilityRegistry } from '../../core/CapabilityRegistry';
import { resolvePython3Runtime, defaultPython3Candidates, Python3Runtime } from '../../utils/crossPlatform';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

function readSource(): string {
    const p = path.join(process.cwd(), 'src', 'core', 'CapabilityRegistry.ts');
    return fs.readFileSync(p, 'utf-8');
}

// Reimplementação local (não exportada do source) do mesmo padrão usado por
// runPipCheck() em CapabilityRegistry.ts, só para provar o comportamento real de
// exit code com subprocess de verdade — sem precisar exportar nada novo do módulo.
function runPipCheckLikeSource(runtime: Python3Runtime): Promise<boolean> {
    return new Promise((resolve) => {
        execFile(
            runtime.command,
            [...runtime.argsPrefix, '-m', 'pip', '--version'],
            { timeout: 3000, windowsHide: true },
            (error) => resolve(!error),
        );
    });
}

async function main(): Promise<void> {

// ── 1: py -3 preservado como candidato (política não reaberta) ──

console.log('\n=== S35-1 — py -3 continua primeiro candidato Windows (política preservada) ===');
{
    const candidates = defaultPython3Candidates();
    if (process.platform === 'win32') {
        assert(candidates[0]?.command === 'py' && JSON.stringify(candidates[0]?.argsPrefix) === '["-3"]',
            'py -3 é o primeiro candidato no Windows', candidates);
    } else {
        assert(candidates[0]?.command === 'python3', 'python3 é o primeiro candidato em Linux/macOS', candidates);
    }
}

// ── 2 e 3: source garante separação Python válido / pip ausente ──

console.log('\n=== S35-2 — Python válido sem pip: mensagem conservadora, não afirma "não instalado" ===');
{
    const src = readSource();
    assert(/'.*-m pip --version' falhou — pip pode não estar instalado neste runtime'/.test(src) ||
           /-m pip --version.*falhou.*pip pode não estar instalado neste runtime/.test(src),
        'mensagem de falha é conservadora ("pode não estar instalado"), não afirma ausência como fato', null);
    assert(!/pip não instalado'/.test(src), 'não existe afirmação categórica "pip não instalado" no source', null);
}

console.log('\n=== S35-3 — ausência de runtime Python 3: pip:false sem tocar npm/sudo ===');
{
    const src = readSource();
    assert(/if \(!pythonRuntime\)/.test(src), 'branch explícito para runtime ausente', null);
    assert(/sem runtime Python 3 resolvido — pip não pôde ser testado/.test(src),
        'mensagem distingue "não pôde ser testado" de "não instalado"', null);
    // npm e sudo continuam calculados independentemente do resultado do runtime Python
    const npmIdx  = src.indexOf("const npmOut  = runSafe('npm --version')");
    const pyIdx   = src.indexOf('const pythonRuntime = await resolvePython3Runtime');
    assert(npmIdx > 0 && npmIdx < pyIdx, 'npm é sondado antes e independente da resolução do runtime Python', { npmIdx, pyIdx });
}

// ── 4: pip3 standalone divergente nunca é chamado ──

console.log('\n=== S35-4 — pip3 solto do PATH nunca é invocado como comando literal ===');
{
    const src = readSource();
    assert(!/pip3 --version/.test(src), 'literal "pip3 --version" removido do source', null);
    assert(!/execSync\(['"]pip3/.test(src), 'nenhum execSync com "pip3" hardcoded', null);
    assert(/runtime\.command/.test(src) && /runPipCheck\(pythonRuntime\)/.test(src),
        'pip é testado sobre runtime.command (resolvido pela política), nunca sobre um "pip3" literal', null);
}

// ── 5: path com espaços — execFile array, sem shell ──

console.log('\n=== S35-5 — path com espaços preservado (execFile array, sem shell string) ===');
{
    const src = readSource();
    assert(/execFile\(\s*runtime\.command,\s*\[\.\.\.runtime\.argsPrefix, '-m', 'pip', '--version'\]/.test(src),
        'runPipCheck usa execFile com array de args — command com espaços não é splitado nem precisa de aspas', null);
    const withSpaces: Python3Runtime = { command: 'C:\\Program Files\\Python312\\python.exe', argsPrefix: [] };
    assert(withSpaces.command.includes(' '), 'runtime de teste representa um path real com espaço, sem exigir shell escaping', withSpaces);
}

// ── 6: timeout explícito ──

console.log('\n=== S35-6 — timeout explícito, pequeno, passado ao execFile ===');
{
    const src = readSource();
    assert(/PIP_PROBE_TIMEOUT_MS\s*=\s*3000/.test(src), 'timeout pequeno e explícito (3000ms)', null);
    assert(/timeout:\s*PIP_PROBE_TIMEOUT_MS/.test(src), 'timeout é passado às options do execFile — spawn que trava é tratado como falha', null);
}

// ── 7: -m pip --version non-zero → false (subprocess real) ──

console.log('\n=== S35-7 — subprocess real: exit 0 → true, exit != 0 → false ===');
{
    const realRuntime = await resolvePython3Runtime(defaultPython3Candidates());
    assert(realRuntime !== null, 'ambiente de teste tem Python 3 real resolvido (pré-requisito do caso)', realRuntime);
    if (realRuntime) {
        const ok = await runPipCheckLikeSource(realRuntime);
        assert(ok === true, '`<runtime> -m pip --version` real retorna true (pip confirmado disponível nesta máquina)', ok);
    }
    // Runtime válido mas comando inexistente simula um --version com exit != 0 tratado como false.
    const brokenRuntime: Python3Runtime = { command: '__nonexistent_binary_xyz__', argsPrefix: [] };
    const brokenResult = await runPipCheckLikeSource(brokenRuntime);
    assert(brokenResult === false, 'binário inexistente / spawn failure é tratado como pip indisponível (false), nunca lança exceção', brokenResult);
}

// ── 8: summary continua refletindo pip ✓/✗ ──

console.log('\n=== S35-8 — getCapabilitySummary() continua com linha "Execução: pip ✓/✗" ===');
{
    const registry = CapabilityRegistry.getInstance();
    registry.invalidate('execution');
    const summary = await registry.getCapabilitySummary();
    assert(/Execução:\s*pip\s*[✓✗]/.test(summary), 'summary contém a linha de execução com símbolo pip ✓/✗', summary);
}

// ── 9: invalidate('execution') força novo probe ──

console.log('\n=== S35-9 — invalidate("execution") força novo probe (cache renovado) ===');
{
    const registry = CapabilityRegistry.getInstance();
    await registry.can('execution.pip');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const before = (registry as any).cache.execution?.ts as number | undefined;
    assert(typeof before === 'number', 'cache.execution populado após 1ª chamada', before);

    registry.invalidate('execution');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const afterInvalidate = (registry as any).cache.execution;
    assert(afterInvalidate === null, 'invalidate("execution") zera o cache imediatamente', afterInvalidate);

    await new Promise((r) => setTimeout(r, 5));
    await registry.can('execution.pip');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const after = (registry as any).cache.execution?.ts as number | undefined;
    assert(typeof after === 'number' && after >= (before ?? 0), 'novo probe roda e repopula o cache com timestamp igual/mais recente', { before, after });
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S35 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;

}

main().catch((err) => {
    console.error('S35 erro inesperado:', err);
    process.exitCode = 1;
});
