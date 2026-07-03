/**
 * CapabilityRegistry — Singleton central de Capability Discovery.
 *
 * Consolida três responsabilidades anteriormente fragmentadas (Fase 2.5):
 *   1. Tipos de capability          (ex-CapabilityTypes)
 *   2. Sondas do ambiente           (ex-CapabilityProbe)
 *   3. Cache + API pública          (CapabilityRegistry)
 *
 * Combina dois probes:
 *   - CapabilityProbe (interno): workspace (fs), rede (dns/curl), execução (shell passivo)
 *   - EnvironmentProbe: binários do sistema (via exec_command + which)
 *
 * Mantém cache por categoria com TTLs independentes, expõe API can()/canSync()
 * e gera summary textual para injeção no GoalPlanner.
 *
 * Uso:
 *   const registry = CapabilityRegistry.getInstance();
 *   await registry.bootstrap();
 *   const ok = await registry.can('tool.pandoc');
 *   const summary = await registry.getCapabilitySummary();
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import dns from 'dns';
import os from 'os';
import { promisify } from 'util';
import { createLogger } from '../shared/AppLogger';
import { EnvironmentProbe } from '../loop/EnvironmentProbe';
import { which, isWindows, linuxDistro } from '../utils/crossPlatform';

const log = createLogger('CapabilityRegistry');
const dnsLookup = promisify(dns.lookup);

// ── Seção 1: Tipos de capability (ex-CapabilityTypes) ───────────────────────

export type CapabilitySource = 'probe' | 'inference' | 'cached' | 'manual';

/**
 * Status semântico de uma capability individual.
 * Inclui confiança, origem e timestamp para que o sistema possa
 * decidir se um valor cacheado ainda é confiável.
 */
export interface CapabilityStatus {
    available: boolean;
    /** Confiança da detecção: 0.0 – 1.0 */
    confidence: number;
    source: CapabilitySource;
    /** Date.now() no momento da detecção */
    checkedAt: number;
    /** Detalhes extras: versão, caminho do binário, mensagem de erro */
    details?: string;
}

/** Capabilities do workspace local. */
export interface WorkspaceCapabilities {
    root: string;
    canRead: boolean;
    canWrite: boolean;
    entryCount: number;
    knownSubdirs: string[];
    restrictedPaths: string[];
    checkedAt: number;
}

/** Capabilities de ferramentas do sistema (binários detectados via which). */
export type ToolCapabilities = Record<string, CapabilityStatus>;

/** Capabilities de rede: acesso externo e ao localhost. */
export interface NetworkCapabilities {
    outboundHttp: CapabilityStatus;
    localhostHttp: CapabilityStatus;
    checkedAt: number;
}

/** Capabilities de execução: gerenciadores de pacotes e privilégios. */
export interface ExecutionCapabilities {
    pip: CapabilityStatus;
    npm: CapabilityStatus;
    sudo: CapabilityStatus;
    checkedAt: number;
}

/** Sistema operacional e ambiente de shell do host. */
export interface OSCapabilities {
    platform: 'windows' | 'linux' | 'macos';
    architecture: string;
    shell: string;
    tempDirectory: string;
    pathSeparator: string;
    executableExtension: string;
    distro?: string;
    packageManager?: string;
    checkedAt: number;
}

/** Hardware disponível no host. */
export interface HardwareCapabilities {
    cpuCores: number;
    totalMemoryMB: number;
    freeMemoryMB: number;
    diskFreeMB: number;
    gpuAvailable: boolean;
    gpuName?: string;
    gpuMemoryMB?: number;
    checkedAt: number;
}

/** Capacidades e limites do runtime de execução. */
export interface RuntimeCapabilities {
    containerized: boolean;
    virtualization?: string;
    nodeVersion: string;
    maxFileSizeMB: number;
    checkedAt: number;
}

/** Snapshot completo das capabilities do ambiente operacional. */
export interface EnvironmentCapabilities {
    os:        OSCapabilities;
    hardware:  HardwareCapabilities;
    runtime:   RuntimeCapabilities;
    workspace: WorkspaceCapabilities;
    tools:     ToolCapabilities;
    network:   NetworkCapabilities;
    execution: ExecutionCapabilities;
    lastFullProbe: number;
}

// ── Seção 2: Sondas do ambiente (ex-CapabilityProbe) ────────────────────────

function runSafe(cmd: string, timeoutMs = 3000): string | null {
    try {
        return execSync(cmd, {
            timeout: timeoutMs,
            stdio: ['ignore', 'pipe', 'ignore'],
            encoding: 'utf8',
            windowsHide: true,
        }).trim();
    } catch {
        return null;
    }
}

function makeStatus(available: boolean, details?: string): CapabilityStatus {
    return { available, confidence: 0.99, source: 'probe', checkedAt: Date.now(), details };
}

/**
 * CapabilityProbe — Sondas leves do ambiente de execução.
 *
 * Executa verificações reais e não-destrutivas usando Node.js built-ins
 * (fs, child_process, dns) — sem passar pela camada de ferramentas do LLM.
 * Scope: workspace (fs), rede (dns), execução (shell passivo).
 */
class CapabilityProbe {

    probeWorkspace(): WorkspaceCapabilities {
        const root = process.env.WORKSPACE_DIR || path.join(process.cwd(), 'workspace');
        const now = Date.now();
        let canRead = false;
        let canWrite = false;
        let entryCount = 0;
        const knownSubdirs: string[] = [];

        try {
            fs.accessSync(root, fs.constants.R_OK);
            canRead = true;
            const entries = fs.readdirSync(root, { withFileTypes: true });
            entryCount = entries.length;
            for (const e of entries) {
                if (e.isDirectory()) {
                    knownSubdirs.push(e.name);
                    if (knownSubdirs.length >= 20) break;
                }
            }
        } catch (err) {
            log.warn(`[CapabilityProbe] workspace read probe: ${err}`);
        }

        try {
            fs.accessSync(root, fs.constants.W_OK);
            canWrite = true;
        } catch { /* not writable */ }

        const projectRoot = process.cwd();
        const restrictedPaths = [
            path.join(projectRoot, 'src'),
            path.join(projectRoot, '.env'),
            path.join(projectRoot, 'node_modules'),
            path.join(projectRoot, 'dist'),
        ];

        return { root, canRead, canWrite, entryCount, knownSubdirs, restrictedPaths, checkedAt: now };
    }

    async probeNetwork(): Promise<NetworkCapabilities> {
        const now = Date.now();
        let outbound = false;
        // Try multiple DNS targets — a single host failure (transient, blocked, DNS miss) must not
        // produce a false negative that poisons the cache for 3 minutes and causes the RiskAnalyzer
        // to flag all web_search/web_navigate steps as having no internet access.
        const dnsTargets = ['google.com', 'cloudflare.com', '1.1.1.1'];
        for (const target of dnsTargets) {
            try {
                await Promise.race([
                    dnsLookup(target),
                    new Promise<never>((_, rej) => setTimeout(() => rej(new Error('dns timeout')), 3000)),
                ]);
                outbound = true;
                break;
            } catch { /* try next target */ }
        }

        const port = process.env.PORT ?? '3090';
        const localhostOk = await new Promise<boolean>((resolve) => {
            try {
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const http = require('http') as typeof import('http');
                const req = http.get(
                    `http://localhost:${port}/health`,
                    { timeout: 1000 },
                    (res) => resolve((res.statusCode ?? 0) > 0 && (res.statusCode ?? 0) < 500)
                );
                req.on('error', () => resolve(false));
                req.on('timeout', () => { req.destroy(); resolve(false); });
            } catch { resolve(false); }
        });

        return {
            outboundHttp: makeStatus(outbound),
            localhostHttp: makeStatus(localhostOk),
            checkedAt: now,
        };
    }

    probeExecution(): ExecutionCapabilities {
        const now = Date.now();
        const pipOut  = runSafe('pip3 --version');
        const npmOut  = runSafe('npm --version');
        const sudoOut = isWindows ? null : runSafe('sudo -n true 2>/dev/null && echo yes || echo no');
        return {
            pip:  makeStatus(pipOut !== null, pipOut ?? undefined),
            npm:  makeStatus(npmOut !== null, npmOut ?? undefined),
            sudo: makeStatus(sudoOut?.trim() === 'yes'),
            checkedAt: now,
        };
    }

    probeOS(): OSCapabilities {
        const plat = process.platform;
        const architecture = process.arch;
        const now = Date.now();
        let platform: 'windows' | 'linux' | 'macos';
        let shell: string;
        let tempDirectory: string;
        let pathSeparator: string;
        let executableExtension: string;
        let distro: string | undefined;
        let packageManager: string | undefined;

        if (plat === 'win32') {
            platform = 'windows';
            shell = 'powershell';
            tempDirectory = process.env['TEMP'] ?? process.env['TMP'] ?? 'C:\\Windows\\Temp';
            pathSeparator = '\\';
            executableExtension = '.exe';
            packageManager = runSafe('choco --version', 2000) ? 'choco'
                           : runSafe('winget --version', 2000) ? 'winget'
                           : undefined;
        } else if (plat === 'darwin') {
            platform = 'macos';
            shell = process.env['SHELL'] ?? '/bin/zsh';
            tempDirectory = '/tmp';
            pathSeparator = '/';
            executableExtension = '';
            packageManager = which('brew') ? 'brew' : undefined;
        } else {
            platform = 'linux';
            shell = process.env['SHELL'] ?? '/bin/bash';
            tempDirectory = '/tmp';
            pathSeparator = '/';
            executableExtension = '';
            const lsb = runSafe('lsb_release -si', 2000);
            distro = lsb ? lsb.toLowerCase().trim() : linuxDistro();
            if      (which('apt-get')) packageManager = 'apt';
            else if (which('yum'))     packageManager = 'yum';
            else if (which('pacman'))  packageManager = 'pacman';
            else if (which('apk'))     packageManager = 'apk';
        }

        return { platform, architecture, shell, tempDirectory, pathSeparator, executableExtension, distro, packageManager, checkedAt: now };
    }

    probeHardware(): HardwareCapabilities {
        const now = Date.now();
        const cpuCores      = os.cpus().length;
        const totalMemoryMB = Math.round(os.totalmem() / 1024 / 1024);
        const freeMemoryMB  = Math.round(os.freemem()  / 1024 / 1024);

        let diskFreeMB = 0;
        if (process.platform === 'win32') {
            const out = runSafe('wmic logicaldisk where drivetype=3 get freespace /value 2>nul', 3000);
            const m   = out?.match(/FreeSpace=(\d+)/);
            if (m) diskFreeMB = Math.round(parseInt(m[1]) / 1024 / 1024);
        } else {
            const out = runSafe("df -m / 2>/dev/null | awk 'NR==2{print $4}'", 2000);
            if (out) diskFreeMB = parseInt(out.trim()) || 0;
        }

        let gpuAvailable = false;
        let gpuName: string | undefined;
        let gpuMemoryMB: number | undefined;

        const nvidiaOut = runSafe('nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits', 3000);
        if (nvidiaOut?.trim()) {
            const parts = nvidiaOut.split(',').map(s => s.trim());
            if (parts[0]) {
                gpuAvailable = true;
                gpuName      = parts[0];
                gpuMemoryMB  = parseInt(parts[1] ?? '0') || undefined;
            }
        }

        if (!gpuAvailable && process.platform === 'win32') {
            const wmicOut = runSafe('wmic path win32_videocontroller get name /value 2>nul', 2000);
            const m = wmicOut?.match(/Name=(.+)/);
            if (m && m[1] && !/Microsoft Basic|Standard VGA/i.test(m[1])) {
                gpuAvailable = true;
                gpuName      = m[1].trim();
            }
        }

        return { cpuCores, totalMemoryMB, freeMemoryMB, diskFreeMB, gpuAvailable, gpuName, gpuMemoryMB, checkedAt: now };
    }

    probeRuntime(): RuntimeCapabilities {
        const now = Date.now();
        let containerized = false;
        let virtualization: string | undefined;

        if (process.platform !== 'win32') {
            try {
                if (fs.existsSync('/.dockerenv')) {
                    containerized = true;
                    virtualization = 'docker';
                }
            } catch { /* sem permissão */ }

            if (!containerized) {
                const cgroup = runSafe('cat /proc/1/cgroup', 1000) ?? '';
                if      (cgroup.includes('docker') || cgroup.includes('containerd')) { containerized = true; virtualization = 'docker'; }
                else if (cgroup.includes('kubepods'))                                  { containerized = true; virtualization = 'kubernetes'; }
                else if (cgroup.includes('lxc'))                                       { containerized = true; virtualization = 'lxc'; }
            }
        }

        return { containerized, virtualization, nodeVersion: process.version, maxFileSizeMB: 100, checkedAt: now };
    }
}

// ── Seção 3: Cache + API pública (CapabilityRegistry) ───────────────────────

const TTL = {
    os:         60 * 60 * 1000,
    hardware:   2  * 60 * 1000,
    runtime:    5  * 60 * 1000,
    workspace:  5  * 60 * 1000,
    tools:      20 * 60 * 1000,
    network:    3  * 60 * 1000,
    execution:  10 * 60 * 1000,
} as const;

type Category = keyof typeof TTL;

interface CachedData {
    os:        { data: OSCapabilities;        ts: number } | null;
    hardware:  { data: HardwareCapabilities;  ts: number } | null;
    runtime:   { data: RuntimeCapabilities;   ts: number } | null;
    workspace: { data: WorkspaceCapabilities; ts: number } | null;
    tools:     { data: ToolCapabilities;      ts: number } | null;
    network:   { data: NetworkCapabilities;   ts: number } | null;
    execution: { data: ExecutionCapabilities; ts: number } | null;
}

export class CapabilityRegistry {
    private static instance: CapabilityRegistry | null = null;

    private readonly probe = new CapabilityProbe();
    private readonly envProbe = new EnvironmentProbe();

    private cache: CachedData = {
        os:        null,
        hardware:  null,
        runtime:   null,
        workspace: null,
        tools:     null,
        network:   null,
        execution: null,
    };

    private readonly refreshLocks = new Map<Category, Promise<void>>();

    private constructor() {}

    static getInstance(): CapabilityRegistry {
        if (!CapabilityRegistry.instance) {
            CapabilityRegistry.instance = new CapabilityRegistry();
        }
        return CapabilityRegistry.instance;
    }

    // ── Cache helpers ────────────────────────────────────────────────────────

    private isStale(category: Category): boolean {
        const entry = this.cache[category];
        if (!entry) return true;
        return Date.now() - entry.ts > TTL[category];
    }

    // ── Refresh por categoria ────────────────────────────────────────────────

    private async refreshWorkspace(): Promise<void> {
        try {
            const data = this.probe.probeWorkspace();
            this.cache.workspace = { data, ts: Date.now() };
            log.debug('[Registry] workspace refreshed');
        } catch (err) {
            log.warn('[Registry] workspace probe failed:', String(err));
        }
    }

    private async refreshTools(): Promise<void> {
        try {
            const caps = await this.envProbe.probe();
            if (Object.keys(caps.tools).length === 0) {
                log.warn('[Registry] tools probe empty (exec_command not ready) — cache skipped, will retry');
                return;
            }
            const toolCaps: ToolCapabilities = {};
            for (const [name, available] of Object.entries(caps.tools)) {
                toolCaps[name] = { available, confidence: 0.99, source: 'probe', checkedAt: caps.probeTimestamp };
            }
            this.cache.tools = { data: toolCaps, ts: Date.now() };
            log.debug('[Registry] tools refreshed');
        } catch (err) {
            log.warn('[Registry] tools probe failed:', String(err));
        }
    }

    private async refreshNetwork(): Promise<void> {
        try {
            const data = await this.probe.probeNetwork();
            this.cache.network = { data, ts: Date.now() };
            log.debug('[Registry] network refreshed');
        } catch (err) {
            log.warn('[Registry] network probe failed:', String(err));
        }
    }

    private async refreshExecution(): Promise<void> {
        try {
            const data = this.probe.probeExecution();
            this.cache.execution = { data, ts: Date.now() };
            log.debug('[Registry] execution refreshed');
        } catch (err) {
            log.warn('[Registry] execution probe failed:', String(err));
        }
    }

    private async refreshOS(): Promise<void> {
        try {
            const data = this.probe.probeOS();
            this.cache.os = { data, ts: Date.now() };
            log.debug(`[Registry] os refreshed: ${data.platform} ${data.architecture}`);
        } catch (err) {
            log.warn('[Registry] os probe failed:', String(err));
        }
    }

    private async refreshHardware(): Promise<void> {
        try {
            const data = this.probe.probeHardware();
            this.cache.hardware = { data, ts: Date.now() };
            log.debug(`[Registry] hardware refreshed: cpu=${data.cpuCores} ram=${data.totalMemoryMB}MB gpu=${data.gpuAvailable}`);
        } catch (err) {
            log.warn('[Registry] hardware probe failed:', String(err));
        }
    }

    private async refreshRuntime(): Promise<void> {
        try {
            const data = this.probe.probeRuntime();
            this.cache.runtime = { data, ts: Date.now() };
            log.debug(`[Registry] runtime refreshed: containerized=${data.containerized} node=${data.nodeVersion}`);
        } catch (err) {
            log.warn('[Registry] runtime probe failed:', String(err));
        }
    }

    private async ensureFresh(category: Category): Promise<void> {
        if (!this.isStale(category)) return;
        const existing = this.refreshLocks.get(category);
        if (existing) { await existing; return; }
        const refreshFn: Record<Category, () => Promise<void>> = {
            os:        () => this.refreshOS(),
            hardware:  () => this.refreshHardware(),
            runtime:   () => this.refreshRuntime(),
            workspace: () => this.refreshWorkspace(),
            tools:     () => this.refreshTools(),
            network:   () => this.refreshNetwork(),
            execution: () => this.refreshExecution(),
        };
        const promise = refreshFn[category]().finally(() => this.refreshLocks.delete(category));
        this.refreshLocks.set(category, promise);
        await promise;
    }

    // ── API pública ──────────────────────────────────────────────────────────

    async bootstrap(): Promise<void> {
        await Promise.allSettled([
            this.refreshOS(),
            this.refreshHardware(),
            this.refreshRuntime(),
            this.refreshWorkspace(),
            this.refreshTools(),
            this.refreshNetwork(),
            this.refreshExecution(),
        ]);
        log.info('[Registry] bootstrap complete');
    }

    async refreshAll(): Promise<void> {
        await Promise.allSettled([
            this.ensureFresh('os'),
            this.ensureFresh('hardware'),
            this.ensureFresh('runtime'),
            this.ensureFresh('workspace'),
            this.ensureFresh('tools'),
            this.ensureFresh('network'),
            this.ensureFresh('execution'),
        ]);
    }

    invalidate(category: Category): void {
        this.cache[category] = null;
        if (category === 'tools') EnvironmentProbe.invalidateCache();
        log.debug(`[Registry] invalidated category=${category}`);
    }

    invalidateAll(): void {
        for (const cat of Object.keys(TTL) as Category[]) this.invalidate(cat);
    }

    /**
     * Verifica capability por chave. Faz lazy-refresh se cache estiver frio.
     * Chaves: workspace.read/write, network.outbound/localhost,
     *         execution.pip/npm/sudo, tool.<nome>
     */
    async can(key: string): Promise<boolean> {
        const status = await this.getStatus(key);
        return status?.available ?? false;
    }

    canSync(key: string): boolean | null {
        const status = this.getStatusSync(key);
        if (status == null) return null;  // undefined (cache miss) or null (no data) → unknown
        if (status.available == null) return null;  // probe returned without availability info
        return status.available;
    }

    getWorkspaceRoot(): string | null { return this.cache.workspace?.data.root ?? null; }
    getKnownSubdirs(): string[]       { return this.cache.workspace?.data.knownSubdirs ?? []; }
    getOSSync(): OSCapabilities | null        { return this.cache.os?.data ?? null; }
    getHardwareSync(): HardwareCapabilities | null { return this.cache.hardware?.data ?? null; }
    getRuntimeSync(): RuntimeCapabilities | null   { return this.cache.runtime?.data ?? null; }

    async getCapabilitySummary(): Promise<string> {
        await Promise.allSettled([
            this.ensureFresh('os'),
            this.ensureFresh('hardware'),
            this.ensureFresh('runtime'),
            this.ensureFresh('workspace'),
            this.ensureFresh('tools'),
            this.ensureFresh('network'),
            this.ensureFresh('execution'),
        ]);

        const lines: string[] = ['[CAPACIDADES DO AMBIENTE — detectadas automaticamente]'];

        const osData = this.cache.os?.data;
        if (osData) {
            const distroStr = osData.distro ? ` (${osData.distro})` : '';
            const pkgStr    = osData.packageManager ? ` | pkg: ${osData.packageManager}` : '';
            lines.push(`• OS: ${osData.platform}${distroStr} | shell: ${osData.shell} | arch: ${osData.architecture}${pkgStr}`);
        }

        const hw = this.cache.hardware?.data;
        if (hw) {
            const gpuStr = hw.gpuAvailable ? `${hw.gpuName ?? 'gpu'} (${hw.gpuMemoryMB ?? '?'}MB)` : 'nenhuma';
            lines.push(`• Hardware: cpu:${hw.cpuCores} cores | ram:${hw.totalMemoryMB}MB total / ${hw.freeMemoryMB}MB livre | disk:${hw.diskFreeMB}MB livre | gpu:${gpuStr}`);
        }

        const rt = this.cache.runtime?.data;
        if (rt) {
            const containerStr = rt.containerized ? `${rt.virtualization ?? 'container'}` : 'não';
            lines.push(`• Runtime: node:${rt.nodeVersion} | containerizado:${containerStr}`);
        }

        const ws = this.cache.workspace?.data;
        if (ws) {
            const access  = [ws.canRead ? 'leitura ✓' : 'leitura ✗', ws.canWrite ? 'escrita ✓' : 'escrita ✗'].join(', ');
            const subdirs = ws.knownSubdirs.length > 0 ? ` | subpastas: ${ws.knownSubdirs.slice(0, 8).join(', ')}` : '';
            lines.push(`• Workspace: ${ws.root} (${access}, ${ws.entryCount} itens${subdirs})`);
        }

        const tools = this.cache.tools?.data;
        if (tools) {
            const available   = Object.entries(tools).filter(([, s]) =>  s.available).map(([k]) => k);
            const unavailable = Object.entries(tools).filter(([, s]) => !s.available).map(([k]) => k);
            if (available.length > 0)   lines.push(`• Ferramentas: ${available.join(', ')}`);
            if (unavailable.length > 0) lines.push(`• Indisponíveis (não usar): ${unavailable.join(', ')}`);
        }

        const net = this.cache.network?.data;
        if (net) {
            lines.push(`• Rede: internet ${net.outboundHttp.available ? '✓' : '✗'} | localhost ${net.localhostHttp.available ? '✓' : '✗'}`);
        }

        const exec = this.cache.execution?.data;
        if (exec) {
            lines.push(`• Execução: pip ${exec.pip.available ? '✓' : '✗'} | npm ${exec.npm.available ? '✓' : '✗'} | sudo ${exec.sudo.available ? '✓' : '✗'}`);
        }

        return lines.join('\n');
    }

    // ── Internos ─────────────────────────────────────────────────────────────

    private async getStatus(key: string): Promise<CapabilityStatus | null | undefined> {
        const [category, ...rest] = key.split('.');
        const subkey = rest.join('.');
        switch (category) {
            case 'workspace': await this.ensureFresh('workspace'); return this.resolveWorkspaceStatus(subkey);
            case 'network':   await this.ensureFresh('network');   return this.resolveNetworkStatus(subkey);
            case 'execution': await this.ensureFresh('execution'); return this.resolveExecutionStatus(subkey);
            case 'tool':      await this.ensureFresh('tools');     return this.cache.tools?.data[subkey] ?? null;
            default: log.warn(`[Registry] unknown capability key: ${key}`); return null;
        }
    }

    private getStatusSync(key: string): CapabilityStatus | null | undefined {
        const [category, ...rest] = key.split('.');
        const subkey = rest.join('.');
        switch (category) {
            case 'workspace': if (!this.cache.workspace) return undefined; return this.resolveWorkspaceStatus(subkey);
            case 'network':   if (!this.cache.network)   return undefined; return this.resolveNetworkStatus(subkey);
            case 'execution': if (!this.cache.execution) return undefined; return this.resolveExecutionStatus(subkey);
            case 'tool':      if (!this.cache.tools)     return undefined; return this.cache.tools.data[subkey] ?? null;
            default: return null;
        }
    }

    private resolveWorkspaceStatus(subkey: string): CapabilityStatus | null {
        const ws = this.cache.workspace?.data;
        if (!ws) return null;
        const now = ws.checkedAt;
        if (subkey === 'read')  return { available: ws.canRead,  confidence: 0.99, source: 'probe', checkedAt: now };
        if (subkey === 'write') return { available: ws.canWrite, confidence: 0.99, source: 'probe', checkedAt: now };
        return null;
    }

    private resolveNetworkStatus(subkey: string): CapabilityStatus | null {
        const net = this.cache.network?.data;
        if (!net) return null;
        if (subkey === 'outbound')  return net.outboundHttp;
        if (subkey === 'localhost') return net.localhostHttp;
        return null;
    }

    private resolveExecutionStatus(subkey: string): CapabilityStatus | null {
        const exec = this.cache.execution?.data;
        if (!exec) return null;
        if (subkey === 'pip')  return exec.pip;
        if (subkey === 'npm')  return exec.npm;
        if (subkey === 'sudo') return exec.sudo;
        return null;
    }
}
