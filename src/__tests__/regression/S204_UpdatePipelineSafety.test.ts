/// <reference types="node" />
/**
 * S204 — contratos do updater multiplataforma: instalação bloqueada fora da allowlist,
 * updater falha com exit code observável e recovery de liveness em Windows/Linux.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

async function main(): Promise<void> {
    const root = path.resolve(__dirname, '../../..');
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
    const updater = fs.readFileSync(path.join(root, 'bin', 'newclaw'), 'utf8');
    const npmrc = fs.readFileSync(path.join(root, '.npmrc'), 'utf8');
    const gitignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8').split(/\r?\n/);

    assert(manifest.peerDependencies['newclaw-kernel-adapter'] === '^0.1.0'
        && manifest.peerDependenciesMeta['newclaw-kernel-adapter']?.optional === true,
        'adaptador segue peer opcional e não força caminho local em instalações limpas');
    assert(!lock.packages['node_modules/newclaw-kernel-adapter'],
        'lockfile não cria link quebrado para o adaptador ausente');
    assert(manifest.engines.node === '^22.22.2 || ^24.15.0' && manifest.engines.npm === '>=12.2.0',
        'matriz declarada corresponde ao mínimo do npm 12.2 e ao npm com allowScripts');
    assert(npmrc.includes('strict-allow-scripts=true') && npmrc.includes('engine-strict=true'),
        'scripts não revisados e versões fora da matriz causam falha de instalação');
    assert(manifest.allowScripts['better-sqlite3'] === true
        && manifest.allowScripts['@whiskeysockets/baileys@7.0.0-rc13'] === true
        && manifest.allowScripts['protobufjs@7.6.5'] === true
        && Object.keys(manifest.allowScripts).length === 3,
    'allowlist autoriza apenas addon nativo e versões revisadas dos scripts de dependência');
    const runtimePolicy = require(path.join(root, 'scripts', 'check-runtime.cjs')) as {
        supportsNodeVersion: (version: string) => boolean;
        supportsNpmVersion: (version: string) => boolean;
    };
    assert(!runtimePolicy.supportsNodeVersion('v22.22.1')
        && runtimePolicy.supportsNodeVersion('v22.22.2')
        && runtimePolicy.supportsNodeVersion('v24.15.0')
        && runtimePolicy.supportsNpmVersion('12.2.0')
        && !runtimePolicy.supportsNpmVersion('11.20.0'),
    'preinstall rejeita Node/npm abaixo da matriz necessária à política npm 12');
    assert(updater.includes("execute('npm ci'") && !updater.includes("execSync('npm install'"),
        'atualizador usa instalação reproduzível do lockfile');
    assert(!updater.includes('git reset --hard ${remoteRef}') && updater.includes('npm ci')
        && updater.includes('npm run build') && updater.includes('waitForApplication'),
    'pull com falha não força reset remoto e falhas posteriores acionam recovery e health check');
    assert(gitignore.includes('data/') && updater.includes('git stash push --include-untracked')
        && !updater.includes('git clean -fd'),
    'dados persistentes ignorados não são limpos pelo updater ou pelo stash');

    const { assertGitReady, installBuildRestart, rollbackUpdate } = require(path.join(root, 'bin', 'newclaw')) as {
        installBuildRestart: (restart: boolean, execute: (command: string) => void,
            restartProcess: () => void, healthCheck: () => Promise<void>, migrateAutostart?: boolean) => Promise<void>;
        rollbackUpdate: (head: string, stash: string | null, execute: (command: string) => void,
            restartProcess: () => void, healthCheck: () => Promise<void>) => Promise<void>;
        updateEnvFile: (values: Record<string, string | null>, filePath: string) => void;
        assertGitReady: (execute: (command: string) => string, exists: (filePath: string) => boolean) => void;
    };
    const rejects = async (action: () => Promise<void>): Promise<boolean> => {
        try { await action(); return false; } catch { return true; }
    };
    for (const failedCommand of ['npm ci', 'npm run build', 'npm prune --omit=dev']) {
        const rejected = await rejects(() => installBuildRestart(false, command => {
            if (command === failedCommand) throw new Error(`mock failure: ${command}`);
        }, () => undefined, async () => undefined, false));
        assert(rejected, `falha de instalação/build/prune em ${failedCommand} propaga erro`);
    }
    let healthCalled = false;
    assert(await rejects(() => installBuildRestart(true, () => undefined,
        () => { throw new Error('mock restart failure'); }, async () => { healthCalled = true; }, false))
        && !healthCalled, 'falha no reinício interrompe o pipeline antes do health check');
    assert(await rejects(() => installBuildRestart(true, () => undefined, () => undefined,
        async () => { throw new Error('mock health failure'); }, false)),
    'falha no health check propaga erro após o restart');

    const recoveryCommands: string[] = [];
    await rollbackUpdate('abc123', null, command => recoveryCommands.push(command), () => {
        recoveryCommands.push('restart');
    }, async () => { recoveryCommands.push('health'); });
    const expectedRecoveryCommands = [
        'git reset --hard abc123', 'npm ci', 'npm run build',
        ...(fs.existsSync(path.resolve(root, '..', 'newclaw-kernel-adapter', 'package.json'))
            ? ['node scripts/link-local-kernel-adapter.cjs'] : []),
        'restart', 'health',
    ];
    assert(recoveryCommands.join('|') === expectedRecoveryCommands.join('|'),
        'rollback só confirma após restaurar commit, reinstalar, compilar, reiniciar e checar health');
    assert(await rejects(() => rollbackUpdate('abc123', null, command => {
        if (command.startsWith('git reset --hard')) throw new Error('mock git failure');
    }, () => undefined, async () => undefined)), 'falha de Git durante rollback não é mascarada');

    assertGitReady(command => command.replace('git rev-parse --git-path ', '.git/'), () => false);
    let gitOperationBlocked = false;
    try {
        assertGitReady(command => command.replace('git rev-parse --git-path ', '.git/'),
            filePath => filePath.endsWith('rebase-apply'));
    } catch { gitOperationBlocked = true; }
    assert(gitOperationBlocked, 'atualizador recusa iniciar durante rebase local em andamento');

    const linkFixture = fs.mkdtempSync(path.join(os.tmpdir(), 'newclaw-adapter-link-'));
    try {
        const projectDir = path.join(linkFixture, 'project');
        const adapterDir = path.join(linkFixture, 'newclaw-kernel-adapter');
        fs.mkdirSync(projectDir, { recursive: true });
        fs.mkdirSync(adapterDir, { recursive: true });
        fs.writeFileSync(path.join(adapterDir, 'package.json'), JSON.stringify({ name: 'newclaw-kernel-adapter', version: '0.1.0' }));
        const { ensureOptionalAdapterLink } = require(path.join(root, 'scripts', 'link-local-kernel-adapter.cjs')) as {
            ensureOptionalAdapterLink: (project: string, adapter: string) => boolean;
        };
        const linked = ensureOptionalAdapterLink(projectDir, adapterDir);
        assert(linked && fs.realpathSync(path.join(projectDir, 'node_modules', 'newclaw-kernel-adapter')) === fs.realpathSync(adapterDir),
            'peer local opcional usa junction no Windows ou symlink no Linux sem recalcular o lockfile');
        const conflictProject = path.join(linkFixture, 'conflict-project');
        const conflictLink = path.join(conflictProject, 'node_modules', 'newclaw-kernel-adapter');
        fs.mkdirSync(conflictLink, { recursive: true });
        fs.writeFileSync(path.join(conflictLink, 'keep.txt'), 'preserve');
        let refused = false;
        try { ensureOptionalAdapterLink(conflictProject, adapterDir); } catch { refused = true; }
        assert(refused && fs.existsSync(path.join(conflictLink, 'keep.txt')),
            'não substitui nem apaga um diretório existente no caminho do adaptador');
    } finally {
        fs.rmSync(linkFixture, { recursive: true, force: true });
    }

    const envFixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'newclaw-env-preservation-'));
    const envFixture = path.join(envFixtureDir, '.env');
    try {
        const originalEnv = '# comentário preservado\r\nAPI_TOKEN="valor secreto"\r\nUPDATE_CHANNEL="stable" # canal\r\nUPDATE_BRANCH=old-branch\r\n';
        fs.writeFileSync(envFixture, originalEnv);
        const { updateEnvFile } = require(path.join(root, 'bin', 'newclaw')) as {
            updateEnvFile: (values: Record<string, string | null>, filePath: string) => void;
        };
        updateEnvFile({ UPDATE_CHANNEL: 'dev', UPDATE_BRANCH: 'feature/test' }, envFixture);
        assert(fs.readFileSync(envFixture, 'utf8') === '# comentário preservado\r\nAPI_TOKEN="valor secreto"\r\nUPDATE_CHANNEL="dev" # canal\r\nUPDATE_BRANCH=feature/test\r\n',
            'atualização do canal preserva valores, comentários, aspas e CRLF do .env');
        updateEnvFile({ UPDATE_BRANCH: null }, envFixture);
        assert(!fs.readFileSync(envFixture, 'utf8').includes('UPDATE_BRANCH=')
            && fs.readFileSync(envFixture, 'utf8').includes('# comentário preservado'),
            'limpar branch de Development remove só a chave-alvo');
    } finally {
        fs.rmSync(envFixtureDir, { recursive: true, force: true });
    }

    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'newclaw-script-policy-'));
    try {
        const packageDir = path.join(fixture, 'fixtures', 'unreviewed');
        fs.mkdirSync(packageDir, { recursive: true });
        fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({
            name: 'newclaw-unreviewed-script-fixture', version: '1.0.0',
            scripts: { postinstall: 'node -e "process.exit(0)"' },
        }));
        fs.writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({
            name: 'newclaw-script-policy-fixture', version: '1.0.0',
            dependencies: { 'newclaw-unreviewed-script-fixture': 'file:fixtures/unreviewed' },
        }));
        fs.writeFileSync(path.join(fixture, '.npmrc'), 'strict-allow-scripts=true\n');
        let blocked = false;
        try { execSync('npm install --no-audit --no-fund', { cwd: fixture, stdio: 'pipe' }); }
        catch (error) { blocked = /strict-allow-scripts|install script|blocked/i.test(String((error as any).stderr)); }
        assert(blocked, 'script desconhecido em fixture local é bloqueado pela política strict');
    } finally {
        fs.rmSync(fixture, { recursive: true, force: true });
    }

    const runtime = globalThis as any;
    const oldFetch = runtime.fetch;
    try {
        runtime.fetch = async () => ({ status: 503, json: async () => ({ status: 'degraded' }) });
        const { waitForApplication } = require(path.join(root, 'bin', 'newclaw')) as {
            waitForApplication: (options?: { timeoutMs?: number; intervalMs?: number }) => Promise<void>;
        };
        await waitForApplication({ timeoutMs: 100, intervalMs: 0 });
        assert(true, 'health endpoint degradado por provider externo confirma que o app reiniciou');
        runtime.fetch = async () => ({ status: 500, json: async () => ({ status: 'error' }) });
        let rejected = false;
        try { await waitForApplication({ timeoutMs: 0, intervalMs: 0 }); } catch { rejected = true; }
        assert(rejected, 'health check inválido falha em vez de declarar atualização concluída');
    } finally {
        runtime.fetch = oldFetch;
    }

    console.log(`\nS204: ${passed} passaram, ${failed} falharam`);
    if (failed) process.exit(1);
}

main().catch(error => { console.error(error); process.exit(1); });
