/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S160
 * exec_command: normalização de env/cwd no Windows para evitar "spawn ...cmd.exe ENOENT"
 *
 * INCIDENTE REAL (newclaw-audit.log, 2026-07-29 23:18:04, goal_1785377727278_guufa,
 * sessão web:conv_1785374610166): `exec_command` falhou com
 * "ERROR: spawn C:\WINDOWS\system32\cmd.exe ENOENT" — o binário existe de verdade no
 * disco (confirmado nesta mesma máquina), mas o spawn do PRÓPRIO shell falhou. Contribuiu
 * para 1 replan extra num goal que já ia estourar o teto de 10min do dashboard web —
 * causa raiz de o usuário não receber nenhuma resposta.
 *
 * ACHADO (Fase 1 — busca no histórico do git): um fix para exatamente essa classe de erro
 * já tinha sido escrito em 14/07/2026 (commit 4df6042, branch
 * investigation/tool-dedup-loop) — normaliza a capitalização de PATH e garante
 * SystemRoot/SystemDrive/ComSpec no env do processo filho, além de garantir que o cwd
 * exista antes do spawn (cwd inexistente também derruba o spawn do shell com ENOENT no
 * Windows, sem indicar a causa real). Esse fix nunca foi mergeado em main (branch
 * divergiu 167 commits antes desta investigação) — o bug ficou latente em produção.
 *
 * FIX (portado e adaptado ao pipeline atual de exec_command.ts): mesma normalização,
 * aplicada só quando process.platform==='win32' — zero efeito em Linux/macOS.
 *
 * REGRESSÃO SE: a normalização de env (PATH/SystemRoot/SystemDrive/ComSpec) ou a garantia
 * de cwd existente forem removidas de exec_command.ts, OU deixarem de ser guardadas por
 * `process.platform === 'win32'` (não podem rodar em Linux/macOS).
 *
 * Execução: npx ts-node src/__tests__/regression/S160_ExecCommand_WindowsSpawnEnoentNormalization.test.ts
 */

process.env.WORKSPACE_DIR = process.env.WORKSPACE_DIR || 'D:/IA/newclaw/workspace';

import * as fs from 'fs';
import * as path from 'path';
import { ExecCommandTool } from '../../tools/exec_command';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

async function main() {
    // ── 1. Inspeção do source: normalização presente e corretamente guardada por platform ──
    console.log('\n=== S160 — Inspeção do source exec_command.ts ===');

    const srcPath = path.join(process.cwd(), 'src', 'tools', 'exec_command.ts');
    const src = fs.readFileSync(srcPath, 'utf-8');

    assert(
        /process\.platform === 'win32'[\s\S]{0,400}env\.SystemRoot/.test(src),
        "normalização de SystemRoot guardada por process.platform === 'win32'"
    );
    assert(/env\.SystemDrive/.test(src), 'normalização garante SystemDrive');
    assert(/env\.ComSpec/.test(src), 'normalização garante ComSpec');
    assert(
        /pathKey\s*&&\s*pathKey\s*!==\s*'PATH'/.test(src),
        'normalização corrige capitalização divergente da chave PATH'
    );
    assert(
        /fs\.existsSync\(execOptions\.cwd\)/.test(src),
        'garante existência do cwd antes do spawn (cwd inexistente também causa ENOENT no Windows)'
    );
    assert(
        /execOptions\.cwd = workspaceDir/.test(src),
        'fallback para workspaceDir quando mkdir do cwd falha'
    );

    // ── 2. Simulação: env com chave PATH em capitalização divergente e sem SystemRoot ──
    // (reproduz o cenário documentado no commit original: processo herdado de Tarefa
    // Agendada/PM2 com env parcialmente stripped) — replica a lógica exata do fix.
    console.log('\n=== S160 — Simulação: normalização corrige env divergente ===');

    function normalizeWindowsEnv(rawEnv: Record<string, string | undefined>): Record<string, string | undefined> {
        const env: Record<string, string | undefined> = { ...rawEnv };
        const envKeys = Object.keys(env);
        const pathKey = envKeys.find(k => k.toLowerCase() === 'path');
        if (pathKey && pathKey !== 'PATH') {
            env.PATH = env[pathKey];
            delete env[pathKey];
        }
        if (!env.SystemRoot) env.SystemRoot = 'C:\\Windows';
        if (!env.SystemDrive) env.SystemDrive = 'C:';
        if (!env.ComSpec) env.ComSpec = 'C:\\Windows\\system32\\cmd.exe';
        return env;
    }

    const strippedEnv = { Path: 'C:\\Windows\\System32' }; // casing divergente, sem SystemRoot/ComSpec
    const normalized = normalizeWindowsEnv(strippedEnv);

    assert(normalized.PATH === 'C:\\Windows\\System32', 'PATH normalizado a partir de "Path" (casing divergente)');
    assert(normalized.Path === undefined, 'chave antiga "Path" removida após normalização');
    assert(normalized.SystemRoot === 'C:\\Windows', 'SystemRoot preenchido quando ausente');
    assert(normalized.SystemDrive === 'C:', 'SystemDrive preenchido quando ausente');
    assert(normalized.ComSpec === 'C:\\Windows\\system32\\cmd.exe', 'ComSpec preenchido quando ausente');

    // ── 3. Smoke test real: exec_command ainda funciona nesta máquina Windows ──────────
    if (process.platform === 'win32') {
        console.log('\n=== S160 — Smoke test real (subprocess de verdade nesta máquina Windows) ===');
        const tool = new ExecCommandTool();
        const result = await tool.execute({ command: 'echo newclaw-s160-ok' });
        assert(result.success === true, `exec_command executa com sucesso no Windows real — obtido: ${JSON.stringify(result).slice(0, 200)}`);
        assert(
            (result.output ?? '').includes('newclaw-s160-ok'),
            `saída contém o marcador esperado — obtido: "${(result.output ?? '').slice(0, 100)}"`
        );
    } else {
        console.log('\n=== S160 — Smoke test real pulado (não é Windows — normalização não se aplica) ===');
    }

    // ── Resultado ────────────────────────────────────────────────────────────────
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S160 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    console.log(`\nCOBERTURA:`);
    console.log(`  Normalização de env presente e guardada por platform: testado`);
    console.log(`  Correção de PATH/SystemRoot/SystemDrive/ComSpec: simulado`);
    console.log(`  Garantia de cwd existente: testado (source)`);
    console.log(`  exec_command real funciona nesta máquina: ${process.platform === 'win32' ? 'testado (live)' : 'pulado (não-Windows)'}`);
    if (failed > 0) process.exit(1);
}

main();
