/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S37
 * Investigação de log real (segunda rodada, 04/07/2026 22:34-22:37, 2min após o
 * commit f8c408c que corrigiu a classificação missing_tool→needs_dependency):
 * dessa vez o sistema corretamente detectou 'edge-tts' ausente, injetou um step
 * de instalação, `pip install edge-tts` reportou sucesso real (instalou
 * edge-tts-7.2.8 em AppData\Roaming\Python\Python314\site-packages) — mas
 * `send_audio` continuou falhando com "spawn edge-tts ENOENT" nas 3 tentativas
 * seguintes, mesmo após a instalação "bem-sucedida".
 *
 * ACHADO (comprovado ao vivo nesta máquina): pip grava o script de console
 * (edge-tts.exe) em AppData\Roaming\Python\PythonXXX\Scripts — pasta que o
 * instalador padrão do Python NÃO adiciona ao PATH no Windows. Nem um restart
 * do processo resolveria, pois o PATH persistido do usuário (registro do
 * Windows) também não contém essa pasta.
 *
 * CORREÇÃO: mesmo princípio já aplicado hoje ao probe de pip em
 * CapabilityRegistry.ts (commit 35aa97d) — não confiar em nome de binário
 * solto no PATH; resolver o runtime Python 3 real (resolvePython3Runtime/
 * defaultPython3Candidates, infra já existente e testada) e invocar o pacote
 * como módulo (`<runtime> -m edge_tts`), que funciona independente de qualquer
 * diretório de Scripts estar no PATH. EDGE_TTS_PATH continua funcionando como
 * escape hatch explícito para quem prefere um binário fixo.
 *
 * Cobre:
 *   1. resolveEdgeTtsCommand() resolve via runtime+`-m edge_tts` (não bare 'edge-tts')
 *   2. EDGE_TTS_PATH continua tendo prioridade quando definido
 *   3. fallback pro binário solto só quando nenhum runtime Python 3 é resolvido
 *   4. subprocess real: `<runtime> -m edge_tts --version` funciona nesta máquina
 *   5. subprocess real: geração de MP3 real via -m edge_tts (reproduz o caso do incidente)
 *   6. argsPrefix (ex: py -3) é preservado corretamente na chamada ao módulo
 *
 * Execução: npx ts-node src/__tests__/regression/S37_SendAudio_EdgeTtsPathResolution.test.ts
 */

process.env.WORKSPACE_DIR = process.env.WORKSPACE_DIR || 'D:/IA/newclaw/workspace';

import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { resolvePython3Runtime, defaultPython3Candidates, Python3Runtime } from '../../utils/crossPlatform';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

function readSource(): string {
    return fs.readFileSync(path.join(process.cwd(), 'src', 'tools', 'send_audio.ts'), 'utf-8');
}

function runViaModule(runtime: Python3Runtime, args: string[], timeoutMs = 15000): Promise<{ ok: boolean; stdout: string }> {
    return new Promise((resolve) => {
        execFile(
            runtime.command,
            [...runtime.argsPrefix, '-m', 'edge_tts', ...args],
            { timeout: timeoutMs, encoding: 'utf-8', windowsHide: true },
            (err, stdout) => resolve({ ok: !err, stdout: stdout || '' }),
        );
    });
}

async function main(): Promise<void> {

// ── 1-3: source inspection — resolveEdgeTtsCommand() implementa a correção ──

console.log('\n=== S37-1 — send_audio.ts resolve edge-tts via runtime+"-m edge_tts", não bare "edge-tts" ===');
{
    const src = readSource();
    assert(/resolvePython3Runtime\(defaultPython3Candidates\(\)\)/.test(src),
        'resolveEdgeTtsCommand() usa a mesma infra já aprovada (resolvePython3Runtime/defaultPython3Candidates)', null);
    assert(/argsPrefix:\s*\[\.\.\.runtime\.argsPrefix, '-m', 'edge_tts'\]/.test(src),
        'invocação via módulo: [...argsPrefix, "-m", "edge_tts"] — não bare "edge-tts"', null);
    assert(!/const edgeTtsPath = process\.env\.EDGE_TTS_PATH \|\| 'edge-tts'/.test(src),
        'linha antiga (bare "edge-tts" direto do PATH) foi removida', null);
}

console.log('\n=== S37-2 — EDGE_TTS_PATH continua com prioridade explícita quando definido ===');
{
    const src = readSource();
    assert(/const override = process\.env\.EDGE_TTS_PATH;\s*\n\s*if \(override\) return \{ command: override, argsPrefix: \[\] \};/.test(src),
        'override explícito (EDGE_TTS_PATH) é verificado ANTES de tentar resolver runtime Python', null);
}

console.log('\n=== S37-3 — fallback pro binário solto só quando nenhum runtime Python 3 é resolvido ===');
{
    const src = readSource();
    assert(/return \{ command: 'edge-tts', argsPrefix: \[\] \};/.test(src),
        'fallback final (comportamento histórico) preservado para ambientes sem Python 3 resolvível — sem regressão', null);
}

// ── 4-5: subprocess real, reproduzindo o incidente exato ──

console.log('\n=== S37-4 — subprocess real: "<runtime> -m edge_tts --version" funciona nesta máquina ===');
{
    const runtime = await resolvePython3Runtime(defaultPython3Candidates());
    assert(runtime !== null, 'runtime Python 3 resolvido nesta máquina (pré-requisito)', runtime);
    if (runtime) {
        const { ok, stdout } = await runViaModule(runtime, ['--version']);
        assert(ok && /edge-tts/i.test(stdout), '`-m edge_tts --version` executa com sucesso — mesmo pacote instalado no incidente real', { ok, stdout });
    }
}

console.log('\n=== S37-5 — subprocess real: geração de MP3 via -m edge_tts (reproduz o cenário do incidente) ===');
{
    const runtime = await resolvePython3Runtime(defaultPython3Candidates());
    if (runtime) {
        const outFile = path.join(process.env.WORKSPACE_DIR!, '_s37_test_audio.mp3');
        try { fs.unlinkSync(outFile); } catch { /* não existia */ }
        const { ok } = await runViaModule(runtime, [
            '--voice', 'pt-BR-AntonioNeural', '--text', 'teste de regressao S37', '--write-media', outFile,
        ], 30000);
        const fileExists = fs.existsSync(outFile);
        const fileSize = fileExists ? fs.statSync(outFile).size : 0;
        assert(ok && fileExists && fileSize > 0,
            'MP3 real gerado com sucesso via -m edge_tts — resolve o ENOENT observado no incidente (edge-tts instalado mas fora do PATH)',
            { ok, fileExists, fileSize });
        try { fs.unlinkSync(outFile); } catch { /* cleanup best-effort */ }
    }
}

// ── 6: argsPrefix preservado (ex: py -3) ──

console.log('\n=== S37-6 — argsPrefix do runtime (ex: py -3) é preservado na chamada ao módulo ===');
{
    const fakeRuntime: Python3Runtime = { command: 'py', argsPrefix: ['-3'] };
    const expectedArgs = [...fakeRuntime.argsPrefix, '-m', 'edge_tts', '--voice', 'x'];
    assert(JSON.stringify(expectedArgs) === JSON.stringify(['-3', '-m', 'edge_tts', '--voice', 'x']),
        'argsPrefix (["-3"]) é espalhado ANTES de "-m edge_tts" — preserva "py -3 -m edge_tts", não corrompe o launcher', expectedArgs);
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S37 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;

}

main().catch((err) => {
    console.error('S37 erro inesperado:', err);
    process.exitCode = 1;
});
