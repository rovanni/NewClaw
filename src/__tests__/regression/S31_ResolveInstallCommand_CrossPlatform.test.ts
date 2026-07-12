/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S31
 * resolveInstallCommand() decide o comando de instalação por plataforma REAL detectada, nunca
 * cai em installCmd legado (histórico: sempre apt/Linux) fora de Linux.
 *
 * ACHADO REAL (auditoria desta sessão): GoalExecutionLoop.ts injetava depInfo.installCmd
 * VERBATIM em exec_command no fluxo needs_dependency — 19 das 20 entradas de KNOWN_DEPS usam
 * "sudo apt install X -y" (Linux/Debian apenas). Num Windows, o step de instalação automática
 * executaria um comando inexistente ("sudo"/"apt" não existem lá).
 *
 * Cobre os 10 casos pedidos.
 *
 * Execução: npx ts-node src/__tests__/regression/S31_ResolveInstallCommand_CrossPlatform.test.ts
 */

process.env.WORKSPACE_DIR = process.env.WORKSPACE_DIR || 'D:/IA/newclaw/workspace';

import { resolveInstallCommand } from '../../loop/planning/resolveInstallCommand';
import { DependencyInfo } from '../../loop/GoalTypes';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

const win = { platform: 'windows' as const };
const linux = { platform: 'linux' as const };
const mac = { platform: 'macos' as const };

console.log('\n=== S31-1 — win32 + installByPlatform.windows → usa comando Windows ===');
{
    const dep: DependencyInfo = { name: 'x', installByPlatform: { windows: 'choco install x -y' }, manualInstructions: 'm', type: 'system' };
    assert(resolveInstallCommand(dep, win) === 'choco install x -y', 'usa installByPlatform.windows');
}

console.log('\n=== S31-2 — linux + installByPlatform.linux → usa comando Linux específico ===');
{
    const dep: DependencyInfo = { name: 'x', installByPlatform: { linux: 'apt-get install x -y' }, installCmd: 'sudo apt install x -y', manualInstructions: 'm', type: 'system' };
    assert(resolveInstallCommand(dep, linux) === 'apt-get install x -y', 'installByPlatform.linux tem precedência sobre installCmd legado');
}

console.log('\n=== S31-3 — darwin + installByPlatform.macos → usa comando macOS ===');
{
    const dep: DependencyInfo = { name: 'x', installByPlatform: { macos: 'brew install x' }, manualInstructions: 'm', type: 'system' };
    assert(resolveInstallCommand(dep, mac) === 'brew install x', 'usa installByPlatform.macos');
}

console.log('\n=== S31-4 — linux sem installByPlatform.linux + installCmd legado → usa installCmd legado ===');
{
    const dep: DependencyInfo = { name: 'x', installCmd: 'sudo apt install x -y', manualInstructions: 'm', type: 'system' };
    assert(resolveInstallCommand(dep, linux) === 'sudo apt install x -y', 'cai no installCmd legado em Linux');
}

console.log('\n=== S31-5 — win32 sem installByPlatform.windows + installCmd legado apt → undefined ===');
{
    const dep: DependencyInfo = { name: 'x', installCmd: 'sudo apt install x -y', manualInstructions: 'm', type: 'system' };
    assert(resolveInstallCommand(dep, win) === undefined, 'NUNCA cai no installCmd apt fora de Linux (Windows)');
}

console.log('\n=== S31-6 — darwin sem installByPlatform.macos + installCmd legado apt → undefined ===');
{
    const dep: DependencyInfo = { name: 'x', installCmd: 'sudo apt install x -y', manualInstructions: 'm', type: 'system' };
    assert(resolveInstallCommand(dep, mac) === undefined, 'NUNCA cai no installCmd apt fora de Linux (macOS)');
}

console.log('\n=== S31-7 — plataforma específica tem precedência sobre installCmd legado (mesmo em Linux) ===');
{
    const dep: DependencyInfo = { name: 'x', installByPlatform: { linux: 'comando-especifico' }, installCmd: 'comando-legado', manualInstructions: 'm', type: 'system' };
    assert(resolveInstallCommand(dep, linux) === 'comando-especifico', 'installByPlatform vence installCmd mesmo quando ambos existem');
}

console.log('\n=== S31-8 — entrada real "pandoc" em win32 → NUNCA produz sudo apt ===');
{
    const pandoc: DependencyInfo = { name: 'pandoc', installCmd: 'sudo apt install pandoc -y', manualInstructions: 'Instale com: sudo apt install pandoc -y', type: 'system' };
    const result = resolveInstallCommand(pandoc, win);
    assert(result === undefined, `pandoc em Windows nunca gera comando automático (obtido: ${result})`, result);
}

console.log('\n=== S31-9 — entrada real "pandoc" em linux → mantém comportamento legado atual ===');
{
    const pandoc: DependencyInfo = { name: 'pandoc', installCmd: 'sudo apt install pandoc -y', manualInstructions: 'Instale com: sudo apt install pandoc -y', type: 'system' };
    assert(resolveInstallCommand(pandoc, linux) === 'sudo apt install pandoc -y', 'pandoc em Linux continua usando o installCmd legado, sem regressão');
}

console.log('\n=== S31-10 — entrada real "marp" migrada para installByPlatform → funciona nos 3 SOs ===');
{
    // Espelha exatamente a entrada real de KNOWN_DEPS (GoalEvaluator.ts) após a migração desta sessão.
    const marp: DependencyInfo = {
        name: '@marp-team/marp-cli',
        installByPlatform: {
            windows: 'npm install -g @marp-team/marp-cli',
            linux: 'npm install -g @marp-team/marp-cli',
            macos: 'npm install -g @marp-team/marp-cli',
        },
        manualInstructions: 'Instale o marp-cli globalmente: npm install -g @marp-team/marp-cli',
        type: 'node',
    };
    assert(resolveInstallCommand(marp, win) === 'npm install -g @marp-team/marp-cli', 'marp continua instalável automaticamente no Windows (não regride)', resolveInstallCommand(marp, win));
    assert(resolveInstallCommand(marp, linux) === 'npm install -g @marp-team/marp-cli', 'marp continua instalável automaticamente no Linux');
    assert(resolveInstallCommand(marp, mac) === 'npm install -g @marp-team/marp-cli', 'marp continua instalável automaticamente no macOS');
}

console.log('\n=== S31-extra — sem informação de SO (getOSSync() === null) → undefined, nunca assume ===');
{
    const dep: DependencyInfo = { name: 'x', installCmd: 'sudo apt install x -y', installByPlatform: { linux: 'apt-get install x -y' }, manualInstructions: 'm', type: 'system' };
    assert(resolveInstallCommand(dep, null) === undefined, 'sem OSCapabilities disponível, nunca resolve comando nenhum');
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S31 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exit(1);
