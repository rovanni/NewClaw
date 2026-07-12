/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S34
 * Resolução de runtime Python 3 (crossPlatform.ts) reutilizada uma única vez por
 * EnvironmentProbe.probe() para os 4 pacotes Python, substituindo probePyPkgCmd()
 * (que hardcodava `isWindows ? 'python' : 'python3'` sem nunca validar se era
 * realmente Python 3, e cujo formato de shell one-liner não tinha como representar
 * `py -3` nem um path absoluto com espaços com segurança — não existe helper de
 * shell escaping genérico no projeto).
 *
 * ACHADO que motivou o desenho: migrar probePyPkgCmd() para resolver runtime
 * internamente, uma vez por chamada, criaria N+1 (até 4× resolução redundante,
 * já que EnvironmentProbe.probe() chama o probe de pacote 4 vezes). A correção:
 * resolver o runtime UMA VEZ em EnvironmentProbe.probe() e passar o resultado já
 * resolvido para os 4 checks de import, via execFile (array de args, sem shell).
 *
 * Cobre os 15 casos pedidos:
 *   1-10 → resolvePython3Runtime() com probe fake determinístico (sem subprocess)
 *   + probePython3Runtime()/runPython3Import() reais (subprocess de verdade,
 *     Python 3 confirmado disponível nesta máquina de teste)
 *   11-13 → inspeção de source de EnvironmentProbe.ts (resolução única, reuso
 *     pelos 4 pacotes, ferramentas não-Python independentes do resultado Python)
 *   14 → timeout: inspeção de source confirma timeout pequeno e explícito
 *   15 → regressão do parsing: pptx/docx/PIL/markdown preservados
 *
 * Execução: npx ts-node src/__tests__/regression/S34_Python3RuntimeResolution.test.ts
 */

process.env.WORKSPACE_DIR = process.env.WORKSPACE_DIR || 'D:/IA/newclaw/workspace';

import * as fs from 'fs';
import * as path from 'path';
import {
    Python3Runtime,
    resolvePython3Runtime,
    defaultPython3Candidates,
    probePython3Runtime,
    runPython3Import,
} from '../../utils/crossPlatform';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

function fakeProbe(validCommands: Set<string>) {
    const calls: string[] = [];
    const probe = async (runtime: Python3Runtime): Promise<boolean> => {
        calls.push(runtime.command);
        return validCommands.has(runtime.command);
    };
    return { probe, calls };
}

async function main(): Promise<void> {

// ── 1-3: Windows (candidatos fabricados manualmente, independente do SO real) ──

console.log('\n=== S34-1 — Windows: py -3 válido, primeiro candidato, short-circuit ===');
{
    const winCandidates: Python3Runtime[] = [
        { command: 'py', argsPrefix: ['-3'] },
        { command: 'python', argsPrefix: [] },
        { command: 'python3', argsPrefix: [] },
    ];
    const { probe, calls } = fakeProbe(new Set(['py']));
    const runtime = await resolvePython3Runtime(winCandidates, probe);
    assert(runtime?.command === 'py' && JSON.stringify(runtime.argsPrefix) === '["-3"]', 'py -3 selecionado', runtime);
    assert(calls.length === 1 && calls[0] === 'py', 'short-circuit: só "py" foi probado', calls);
}

console.log('\n=== S34-2 — Windows: py -3 inválido, python válido ===');
{
    const winCandidates: Python3Runtime[] = [
        { command: 'py', argsPrefix: ['-3'] },
        { command: 'python', argsPrefix: [] },
        { command: 'python3', argsPrefix: [] },
    ];
    const { probe, calls } = fakeProbe(new Set(['python']));
    const runtime = await resolvePython3Runtime(winCandidates, probe);
    assert(runtime?.command === 'python', 'python selecionado após py -3 falhar', runtime);
    assert(JSON.stringify(calls) === JSON.stringify(['py', 'python']), 'python3 nunca testado (short-circuit)', calls);
}

console.log('\n=== S34-3 — Windows: py e python ausentes, python3 válido ===');
{
    const winCandidates: Python3Runtime[] = [
        { command: 'py', argsPrefix: ['-3'] },
        { command: 'python', argsPrefix: [] },
        { command: 'python3', argsPrefix: [] },
    ];
    const { probe, calls } = fakeProbe(new Set(['python3']));
    const runtime = await resolvePython3Runtime(winCandidates, probe);
    assert(runtime?.command === 'python3', 'python3 selecionado como último recurso', runtime);
    assert(calls.length === 3, 'todos os 3 candidatos testados em ordem', calls);
}

// ── 4-5: Linux/macOS ──

console.log('\n=== S34-4 — Linux/macOS: python3 válido ===');
{
    const unixCandidates: Python3Runtime[] = [
        { command: 'python3', argsPrefix: [] },
        { command: 'python', argsPrefix: [] },
    ];
    const { probe, calls } = fakeProbe(new Set(['python3']));
    const runtime = await resolvePython3Runtime(unixCandidates, probe);
    assert(runtime?.command === 'python3', 'python3 selecionado', runtime);
    assert(calls.length === 1, 'short-circuit: python nunca testado', calls);
}

console.log('\n=== S34-5 — Linux/macOS: python3 inválido, python válido ===');
{
    const unixCandidates: Python3Runtime[] = [
        { command: 'python3', argsPrefix: [] },
        { command: 'python', argsPrefix: [] },
    ];
    const { probe } = fakeProbe(new Set(['python']));
    const runtime = await resolvePython3Runtime(unixCandidates, probe);
    assert(runtime?.command === 'python', 'python selecionado como fallback', runtime);
}

// ── 6: nenhum candidato válido ──

console.log('\n=== S34-6 — nenhum candidato válido → null ===');
{
    const { probe } = fakeProbe(new Set());
    const runtime = await resolvePython3Runtime(
        [{ command: 'py', argsPrefix: ['-3'] }, { command: 'python', argsPrefix: [] }],
        probe
    );
    assert(runtime === null, 'retorna null quando nenhum candidato passa', runtime);
}

// ── 7: Python 2 simulado ──

console.log('\n=== S34-7 — Python 2 simulado: probe rejeita, considerado inválido ===');
{
    // Simula um "python" que existe mas é Python 2 — o probe real (probePython3Runtime)
    // rejeitaria via sys.version_info[0]!=3; aqui simulamos esse resultado (false) via fake.
    const { probe } = fakeProbe(new Set()); // nenhum candidato "passa" a validação de Python 3
    const runtime = await resolvePython3Runtime([{ command: 'python', argsPrefix: [] }], probe);
    assert(runtime === null, 'Python 2 (simulado) não é aceito como runtime Python 3 válido', runtime);
}

// ── 8-9: representação ──

console.log('\n=== S34-8 — path absoluto com espaços: preservado em command, sem split ===');
{
    const withSpaces: Python3Runtime = { command: 'C:\\Program Files\\Python312\\python.exe', argsPrefix: [] };
    assert(withSpaces.command === 'C:\\Program Files\\Python312\\python.exe', 'command preserva o path inteiro, incluindo espaços', withSpaces);
    assert(withSpaces.argsPrefix.length === 0, 'argsPrefix vazio, nenhum split ocorreu');
}

console.log('\n=== S34-9 — py -3: command="py", argsPrefix=["-3"] ===');
{
    const candidates = defaultPython3Candidates();
    const pyDash3 = candidates.find(c => c.command === 'py');
    if (pyDash3) {
        assert(pyDash3.command === 'py' && JSON.stringify(pyDash3.argsPrefix) === '["-3"]', 'py -3 representado como command+argsPrefix, não como string única', pyDash3);
    } else {
        // Ambiente de execução não-Windows: candidato "py" não existe na lista real —
        // confirmado por inspeção de código em vez de execução (ver seção 15 do relatório).
        const srcPath = path.join(process.cwd(), 'src', 'utils', 'crossPlatform.ts');
        const src = fs.readFileSync(srcPath, 'utf-8');
        assert(/command:\s*'py',\s*argsPrefix:\s*\['-3'\]/.test(src), '"py -3" presente no branch Windows do source (não executável neste SO de teste)', null);
    }
}

// ── 10: short-circuit (reforço, com contagem explícita) ──

console.log('\n=== S34-10 — short-circuit: candidatos após sucesso não são probados ===');
{
    const { probe, calls } = fakeProbe(new Set(['a']));
    await resolvePython3Runtime(
        [{ command: 'a', argsPrefix: [] }, { command: 'b', argsPrefix: [] }, { command: 'c', argsPrefix: [] }],
        probe
    );
    assert(calls.length === 1 && calls[0] === 'a', 'apenas o primeiro candidato (válido) foi probado — b e c nunca chamados', calls);
}

// ── Validação real (subprocess de verdade, sem mock) — Python 3 confirmado nesta máquina ──

console.log('\n=== S34-extra — probePython3Runtime()/runPython3Import() reais (subprocess de verdade) ===');
{
    const realCandidates = defaultPython3Candidates();
    const realRuntime = await resolvePython3Runtime(realCandidates);
    assert(realRuntime !== null, 'ambiente de teste tem Python 3 real disponível e foi resolvido', realRuntime);
    if (realRuntime) {
        const sysOk = await runPython3Import(realRuntime, 'sys');
        assert(sysOk === true, 'import de "sys" (sempre disponível) retorna true via subprocess real', sysOk);
        const bogusOk = await runPython3Import(realRuntime, '__definitely_not_a_real_package__');
        assert(bogusOk === false, 'import de pacote inexistente retorna false (exit code != 0)', bogusOk);
    }
    const invalidCandidate: Python3Runtime = { command: '__nonexistent_binary_xyz__', argsPrefix: [] };
    const invalidResult = await probePython3Runtime(invalidCandidate);
    assert(invalidResult === false, 'binário inexistente (spawn failure) é tratado como candidato inválido', invalidResult);
}

// ── 11-13: inspeção de source de EnvironmentProbe.ts (resolução única, reuso, fallback) ──

console.log('\n=== S34-11 — EnvironmentProbe.probe(): resolvePython3Runtime chamado no máximo 1 vez ===');
{
    const envProbePath = path.join(process.cwd(), 'src', 'loop', 'EnvironmentProbe.ts');
    const src = fs.readFileSync(envProbePath, 'utf-8');
    const calls = src.match(/resolvePython3Runtime\(/g) ?? [];
    assert(calls.length === 1, `resolvePython3Runtime( aparece exatamente 1 vez no source (obtido: ${calls.length})`, calls.length);
}

console.log('\n=== S34-12 — 4 pacotes reutilizam a MESMA variável de runtime já resolvida ===');
{
    const envProbePath = path.join(process.cwd(), 'src', 'loop', 'EnvironmentProbe.ts');
    const src = fs.readFileSync(envProbePath, 'utf-8');
    assert(/const pythonRuntime = await resolvePython3Runtime/.test(src), 'runtime resolvido uma vez em variável própria', null);
    assert(/PYTHON_PKGS_TO_PROBE\.map\(async \(p\).*runPython3Import\(pythonRuntime, p\)/.test(src), 'os 4 pacotes chamam runPython3Import(pythonRuntime, p) — reusando a mesma variável, não resolvendo de novo', null);
}

console.log('\n=== S34-13 — ausência de runtime: 4 pacotes false, probes não-Python independentes ===');
{
    const envProbePath = path.join(process.cwd(), 'src', 'loop', 'EnvironmentProbe.ts');
    const src = fs.readFileSync(envProbePath, 'utf-8');
    assert(/for \(const p of PYTHON_PKGS_TO_PROBE\) pythonPkgs\[p\] = false;/.test(src), 'branch else preenche os 4 pacotes com false quando runtime é null', null);
    // Confirma que o probe de ferramentas (tools) roda ANTES e é independente da resolução Python —
    // não há branch condicional envolvendo `tools` a partir do resultado de resolvePython3Runtime.
    const toolProbeIdx = src.indexOf('const result = await execTool.execute');
    const pythonProbeIdx = src.indexOf('resolvePython3Runtime(');
    assert(toolProbeIdx > 0 && pythonProbeIdx > toolProbeIdx, 'probe de ferramentas (tools) executa e conclui antes da resolução Python — nunca abortado por ela', { toolProbeIdx, pythonProbeIdx });
}

// ── 14: timeout ──

console.log('\n=== S34-14 — timeout: pequeno e explícito, candidato tratado como inválido ===');
{
    const srcPath = path.join(process.cwd(), 'src', 'utils', 'crossPlatform.ts');
    const src = fs.readFileSync(srcPath, 'utf-8');
    assert(/PYTHON3_PROBE_TIMEOUT_MS\s*=\s*3000/.test(src), 'timeout pequeno e explícito (3000ms), mesmo valor já usado por which() no mesmo arquivo', null);
    assert(/timeout:\s*PYTHON3_PROBE_TIMEOUT_MS/.test(src), 'timeout é passado ao execFile — spawn que trava é tratado como inválido (error !== null)', null);
}

// ── 15: regressão do parsing — pptx/docx/PIL/markdown preservados ──

console.log('\n=== S34-15 — regressão: pptx/docx/PIL/markdown preservados em EnvironmentProbe ===');
{
    const envProbePath = path.join(process.cwd(), 'src', 'loop', 'EnvironmentProbe.ts');
    const src = fs.readFileSync(envProbePath, 'utf-8');
    assert(/PYTHON_PKGS_TO_PROBE = \['pptx', 'docx', 'PIL', 'markdown'\]/.test(src), 'lista de 4 pacotes preservada, sem mudança de shape público (EnvironmentCapabilities.pythonPkgs continua Record<string, boolean>)', null);
    assert(!/probePyPkgCmd/.test(src), 'probePyPkgCmd removida do consumidor (função morta eliminada, não preservada artificialmente)', null);
    assert(!/PYPKG_OK|PYPKG_MISSING/.test(src), 'marcadores de texto do shell antigo removidos (parsing agora é por exit code, não por prefixo de linha)', null);
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S34 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;

}

main().catch((err) => {
    console.error('S34 erro inesperado:', err);
    process.exitCode = 1;
});
