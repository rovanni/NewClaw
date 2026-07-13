/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S111
 * Canais de atualização (Stable/Preview/Development) — resolveUpdateChannel() e
 * listRemoteBranches() em bin/newclaw, fonte única de verdade sobre qual branch
 * "newclaw update" e o Dashboard (via `update --check`/`--list-branches`) devem usar.
 *
 * bin/newclaw roda como script CJS puro (sem depender de dist/, para conseguir corrigir
 * um build quebrado), então esse teste faz `require()` direto do arquivo. Só isso não
 * dispara o CLI: o dispatch de comandos agora fica atrás de `if (require.main === module)`,
 * então requerer o arquivo só expõe { resolveUpdateChannel, listRemoteBranches, commands }
 * sem executar nada.
 *
 * Mocks: child_process.execSync (nunca bater na rede real via `git ls-remote`/`git branch -r`)
 * e fs.existsSync para o ENV_FILE (nunca ler o .env real da máquina rodando o teste — sem
 * isso, resolveUpdateChannel('dev', undefined) dependeria de UPDATE_BRANCH já persistido
 * localmente por acaso, tornando o teste 8 não-determinístico).
 *
 * Cobre: 1 stable (compat — nunca toca em git), 2 preview existente, 3 preview inexistente
 * (fallback com aviso, não falha), 4 dev com --branch explícita, 5 dev sem branch (fallback),
 * 6 default sem override nem .env (byte-idêntico ao comportamento pré-canais), 7-10
 * listRemoteBranches (filtro, refspec explícito de fetch — achado real num VPS Linux onde a
 * config default do remoto estava restrita e a lista vinha vazia —, ordenação por data mais
 * recente primeiro — achado real testando o Dashboard, ordem alfabética não deixa claro qual
 * branch é a mais atualizada —, e resiliência a git falhando).
 *
 * Execução: npx ts-node src/__tests__/regression/S111_UpdateChannelResolution.test.ts
 */

import * as path from 'path';
// `import cp = require(...)` (não `import * as cp from`) é necessário aqui: o namespace
// gerado por `import *` é uma view somente-leitura (getters não-configuráveis) mesmo para
// módulos core do Node, o que impede sobrescrever execSync/existsSync para o mock abaixo.
// A forma require() retorna o objeto module.exports real e mutável.
import cp = require('child_process');
import fs = require('fs');

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

const originalExecSync = cp.execSync;
const originalExistsSync = fs.existsSync;

let mockExecSyncImpl: (cmd: string) => string = () => '';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(cp as any).execSync = (cmd: string) => mockExecSyncImpl(cmd);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(fs as any).existsSync = (p: unknown) => {
    if (typeof p === 'string' && (p.endsWith('.env') || p.endsWith('newclaw.env'))) return false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return originalExistsSync(p as any);
};

const binNewclawPath = path.join(process.cwd(), 'bin', 'newclaw');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { resolveUpdateChannel, listRemoteBranches } = require(binNewclawPath) as {
    resolveUpdateChannel: (channel?: string, branch?: string) => { channel: string; branchName: string; warning: string | null };
    listRemoteBranches: () => Array<{ name: string; lastCommitAt: string }>;
};

console.log('\n=== S111-1 — stable → origin/main, nunca chama git ===');
{
    mockExecSyncImpl = () => { throw new Error('stable não deveria tocar em git'); };
    const r = resolveUpdateChannel('stable', undefined);
    assert(r.channel === 'stable' && r.branchName === 'main' && r.warning === null, 'stable resolve para main sem I/O de git', r);
}

console.log('\n=== S111-2 — preview existente no remoto → origin/preview, sem aviso ===');
{
    let sawLsRemote = false;
    mockExecSyncImpl = (cmd) => {
        if (/git ls-remote --exit-code origin preview/.test(cmd)) sawLsRemote = true;
        return '';
    };
    const r = resolveUpdateChannel('preview', undefined);
    assert(sawLsRemote, 'checou a existência da branch preview via ls-remote antes de decidir');
    assert(r.channel === 'preview' && r.branchName === 'preview' && r.warning === null, 'preview existente resolve para origin/preview', r);
}

console.log('\n=== S111-3 — preview inexistente no remoto → fallback pra Stable com aviso (não falha) ===');
{
    mockExecSyncImpl = () => { throw new Error('branch not found (simulado — ls-remote sai com erro)'); };
    const r = resolveUpdateChannel('preview', undefined);
    assert(r.channel === 'preview' && r.branchName === 'main', 'preview ausente cai para origin/main sem quebrar', r);
    assert(typeof r.warning === 'string' && r.warning.length > 0, 'aviso explícito é retornado quando preview não existe ainda', r);
}

console.log('\n=== S111-4 — dev com --branch explícita → origin/<branch>, sem tocar em git ===');
{
    mockExecSyncImpl = () => { throw new Error('dev com branch explícita não deveria tocar em git'); };
    const r = resolveUpdateChannel('dev', 'experimental/artifact-pipeline-refactor');
    assert(
        r.channel === 'dev' && r.branchName === 'experimental/artifact-pipeline-refactor' && r.warning === null,
        'dev com --branch usa a branch pedida diretamente', r
    );
}

console.log('\n=== S111-5 — dev sem branch (nem override, nem .env) → fallback pra Stable com aviso ===');
{
    const r = resolveUpdateChannel('dev', undefined);
    assert(r.channel === 'stable' && r.branchName === 'main', 'dev configurado sem branch nunca quebra o update — cai pra Stable', r);
    assert(typeof r.warning === 'string' && r.warning.length > 0, 'aviso explícito é retornado quando dev está sem branch', r);
}

console.log('\n=== S111-6 — sem override e sem .env → default Stable/main (compatibilidade com instalações existentes) ===');
{
    mockExecSyncImpl = () => { throw new Error('default stable não deveria tocar em git'); };
    const r = resolveUpdateChannel(undefined, undefined);
    assert(
        r.channel === 'stable' && r.branchName === 'main' && r.warning === null,
        'quem nunca configurou canal continua em origin/main — comportamento idêntico ao pré-canais', r
    );
}

console.log('\n=== S111-7 — listRemoteBranches: exclui origin/HEAD e origin/main, remove prefixo origin/, expõe lastCommitAt ===');
{
    mockExecSyncImpl = (cmd) => /^git fetch/.test(cmd)
        ? ''
        : 'origin/HEAD|||0 seconds ago\norigin/main|||1 hour ago\norigin/feature/x|||2 hours ago\norigin/experimental/y|||1 day ago\n';
    const branches = listRemoteBranches();
    const names = branches.map(b => b.name);
    assert(!names.includes('HEAD') && !names.includes('main'), 'origin/HEAD e origin/main excluídos da lista', branches);
    assert(names.includes('feature/x') && names.includes('experimental/y'), 'demais branches remotas listadas sem o prefixo origin/', branches);
    const featureX = branches.find(b => b.name === 'feature/x');
    assert(featureX?.lastCommitAt === '2 hours ago', 'lastCommitAt exposto por branch (base pra UI mostrar recência, não só ordem)', featureX);
}

console.log('\n=== S111-8 — listRemoteBranches: preserva a ordem já vinda do git (mais recente primeiro), sem reordenar por nome ===');
{
    // git branch -r --sort=-committerdate já entrega mais recente primeiro — achado real
    // testando o Dashboard: ordem alfabética ("claude/...", "dependabot/...",
    // "experimental/...") não deixa claro qual branch tem o commit mais recente. Um `.sort()`
    // por nome em JS depois do git (como o código tinha antes) desfaria essa ordenação.
    mockExecSyncImpl = (cmd) => /^git fetch/.test(cmd)
        ? ''
        : 'origin/zeta|||1 hour ago\norigin/alpha|||3 days ago\norigin/main|||5 minutes ago\n';
    const branches = listRemoteBranches();
    assert(
        branches.length === 2 && branches[0].name === 'zeta' && branches[1].name === 'alpha',
        '"zeta" (mais recente) vem antes de "alpha" (mais antiga) — ordem do git preservada, não alfabética', branches
    );
}

console.log('\n=== S111-9 — listRemoteBranches: descarta ref remota espúria sem sub-branch ("origin" puro) ===');
{
    // Achado real ao validar contra o repositório de verdade (não hipotético): `git branch -r`
    // pode listar uma ref chamada literalmente "origin" (sem "/algo"), que não corresponde a
    // nenhuma branch selecionável. Sem exigir o prefixo "origin/" antes do strip, esse valor
    // sobrevivia ao filtro (não era 'origin/HEAD' nem 'origin/main') e aparecia intacto na
    // lista exposta ao Dashboard/CLI.
    mockExecSyncImpl = (cmd) => /^git fetch/.test(cmd)
        ? ''
        : 'origin|||1 hour ago\norigin/main|||1 hour ago\norigin/feature/x|||2 hours ago\n';
    const branches = listRemoteBranches();
    const names = branches.map(b => b.name);
    assert(!names.includes('origin') && !names.includes(''), 'ref remota espúria "origin" (sem sub-branch) não aparece na lista', branches);
    assert(names.includes('feature/x'), 'branch real ainda é listada normalmente', branches);
}

console.log('\n=== S111-10 — listRemoteBranches: fetch usa refspec explícito de wildcard (achado real, VPS Linux) ===');
{
    // Um clone cuja config `remote.origin.fetch` esteja restrita a uma única branch (comum em
    // deploys mais antigos/enxutos) nunca traz os remote-tracking refs das outras branches com
    // um "git fetch origin --prune" bare — a listagem ficava vazia mesmo havendo branches reais
    // no GitHub (reportado ao vivo por um usuário rodando o Dashboard num VPS Linux).
    let fetchCmdSeen: string | null = null;
    mockExecSyncImpl = (cmd) => {
        if (/^git fetch/.test(cmd)) { fetchCmdSeen = cmd; return ''; }
        return 'origin/main|||1 hour ago\n';
    };
    listRemoteBranches();
    assert(fetchCmdSeen !== null, 'listRemoteBranches faz fetch antes de listar');
    assert(
        /\+refs\/heads\/\*:refs\/remotes\/origin\/\*/.test(fetchCmdSeen || ''),
        'fetch usa o refspec explícito de wildcard, não um "git fetch origin --prune" bare — funciona mesmo com config de fetch restrita', fetchCmdSeen
    );
}

console.log('\n=== S111-11 — listRemoteBranches: git indisponível não derruba o processo (retorna []) ===');
{
    mockExecSyncImpl = () => { throw new Error('git indisponível (simulado)'); };
    const branches = listRemoteBranches();
    assert(Array.isArray(branches) && branches.length === 0, 'falha de git vira lista vazia, nunca exceção não tratada', branches);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(cp as any).execSync = originalExecSync;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(fs as any).existsSync = originalExistsSync;

console.log(`\n${'─'.repeat(60)}`);
console.log(`S111 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exit(1);
