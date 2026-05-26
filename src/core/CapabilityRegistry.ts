/**
 * CapabilityRegistry — Singleton central de Capability Discovery.
 *
 * Combina dois probes:
 *   - CapabilityProbe: workspace (fs), rede (dns/curl), execução (shell passivo)
 *   - EnvironmentProbe: binários do sistema (via exec_command + which)
 *
 * Mantém cache por categoria com TTLs independentes, expõe API can()/canSync()
 * e gera summary textual para injeção no GoalPlanner.
 *
 * Uso:
 *   const registry = CapabilityRegistry.getInstance();
 *   await registry.bootstrap();   // aquece o cache na inicialização
 *   const ok = await registry.can('tool.pandoc');
 *   const summary = await registry.getCapabilitySummary();
 */

import { createLogger } from '../shared/AppLogger';
import { CapabilityProbe } from './CapabilityProbe';
import { EnvironmentProbe } from '../loop/EnvironmentProbe';
import {
    WorkspaceCapabilities,
    NetworkCapabilities,
    ExecutionCapabilities,
    ToolCapabilities,
    CapabilityStatus,
    OSCapabilities,
    HardwareCapabilities,
    RuntimeCapabilities,
} from './CapabilityTypes';

const log = createLogger('CapabilityRegistry');

// TTLs por categoria (ms)
const TTL = {
    os:         60 * 60 * 1000,   // 1 h  (muda só ao reiniciar)
    hardware:   2  * 60 * 1000,   // 2 min (RAM/disco flutuam)
    runtime:    5  * 60 * 1000,   // 5 min
    workspace:  5  * 60 * 1000,   // 5 min
    tools:      20 * 60 * 1000,   // 20 min
    network:    3  * 60 * 1000,   // 3 min
    execution:  10 * 60 * 1000,   // 10 min
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

    // Serializa refreshes simultâneos por categoria
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
            const toolCaps: ToolCapabilities = {};
            for (const [name, available] of Object.entries(caps.tools)) {
                toolCaps[name] = {
                    available,
                    confidence: 0.99,
                    source: 'probe',
                    checkedAt: caps.probeTimestamp,
                };
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
        if (existing) {
            await existing;
            return;
        }

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

    // ── API pública ───────────────────────────────────────────────────────────

    /**
     * Aquece todas as categorias em paralelo na inicialização.
     * Chamado no construtor do GoalOrchestrator (non-blocking via .catch).
     */
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

    /** Atualiza todas as categorias expiradas (lazy). */
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

    /** Invalida cache de uma categoria (força refresh no próximo can()). */
    invalidate(category: Category): void {
        this.cache[category] = null;
        if (category === 'tools') {
            EnvironmentProbe.invalidateCache();
        }
        log.debug(`[Registry] invalidated category=${category}`);
    }

    invalidateAll(): void {
        for (const cat of Object.keys(TTL) as Category[]) {
            this.invalidate(cat);
        }
    }

    /**
     * Verifica capability por chave. Faz lazy-refresh se cache estiver frio.
     *
     * Chaves suportadas:
     *   workspace.read, workspace.write
     *   network.outbound, network.localhost
     *   execution.pip, execution.npm, execution.sudo
     *   tool.<nome>  (ex: tool.pandoc, tool.python3)
     */
    async can(key: string): Promise<boolean> {
        const status = await this.getStatus(key);
        return status?.available ?? false;
    }

    /**
     * Versão síncrona — usa apenas o cache existente.
     * Retorna null se a categoria ainda não foi carregada.
     */
    canSync(key: string): boolean | null {
        const status = this.getStatusSync(key);
        if (status === undefined) return null;   // categoria não carregada
        return status?.available ?? false;
    }

    // ── Acessores de workspace ────────────────────────────────────────────────

    getWorkspaceRoot(): string | null {
        return this.cache.workspace?.data.root ?? null;
    }

    getKnownSubdirs(): string[] {
        return this.cache.workspace?.data.knownSubdirs ?? [];
    }

    // ── Summary para injeção no planner ──────────────────────────────────────

    /**
     * Gera bloco de texto compacto descrevendo as capabilities do ambiente.
     * Resultado pronto para ser injetado no prompt do GoalPlanner.
     */
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

        // OS
        const osData = this.cache.os?.data;
        if (osData) {
            const distroStr = osData.distro ? ` (${osData.distro})` : '';
            const pkgStr    = osData.packageManager ? ` | pkg: ${osData.packageManager}` : '';
            lines.push(`• OS: ${osData.platform}${distroStr} | shell: ${osData.shell} | arch: ${osData.architecture}${pkgStr}`);
        }

        // Hardware
        const hw = this.cache.hardware?.data;
        if (hw) {
            const gpuStr = hw.gpuAvailable ? `${hw.gpuName ?? 'gpu'} (${hw.gpuMemoryMB ?? '?'}MB)` : 'nenhuma';
            lines.push(`• Hardware: cpu:${hw.cpuCores} cores | ram:${hw.totalMemoryMB}MB total / ${hw.freeMemoryMB}MB livre | disk:${hw.diskFreeMB}MB livre | gpu:${gpuStr}`);
        }

        // Runtime
        const rt = this.cache.runtime?.data;
        if (rt) {
            const containerStr = rt.containerized ? `${rt.virtualization ?? 'container'}` : 'não';
            lines.push(`• Runtime: node:${rt.nodeVersion} | containerizado:${containerStr}`);
        }

        // Workspace
        const ws = this.cache.workspace?.data;
        if (ws) {
            const access  = [ws.canRead ? 'leitura ✓' : 'leitura ✗', ws.canWrite ? 'escrita ✓' : 'escrita ✗'].join(', ');
            const subdirs = ws.knownSubdirs.length > 0 ? ` | subpastas: ${ws.knownSubdirs.slice(0, 8).join(', ')}` : '';
            lines.push(`• Workspace: ${ws.root} (${access}, ${ws.entryCount} itens${subdirs})`);
        }

        // Ferramentas do sistema
        const tools = this.cache.tools?.data;
        if (tools) {
            const available   = Object.entries(tools).filter(([, s]) =>  s.available).map(([k]) => k);
            const unavailable = Object.entries(tools).filter(([, s]) => !s.available).map(([k]) => k);
            if (available.length > 0)   lines.push(`• Ferramentas: ${available.join(', ')}`);
            if (unavailable.length > 0) lines.push(`• Indisponíveis (não usar): ${unavailable.join(', ')}`);
        }

        // Rede
        const net = this.cache.network?.data;
        if (net) {
            const parts = [
                `internet ${net.outboundHttp.available ? '✓' : '✗'}`,
                `localhost ${net.localhostHttp.available ? '✓' : '✗'}`,
            ];
            lines.push(`• Rede: ${parts.join(' | ')}`);
        }

        // Execução
        const exec = this.cache.execution?.data;
        if (exec) {
            const parts = [
                `pip ${exec.pip.available ? '✓' : '✗'}`,
                `npm ${exec.npm.available ? '✓' : '✗'}`,
                `sudo ${exec.sudo.available ? '✓' : '✗'}`,
            ];
            lines.push(`• Execução: ${parts.join(' | ')}`);
        }

        return lines.join('\n');
    }

    // ── Acessores sync para OS e Hardware (usados pelo RiskAnalyzer) ──────────

    /** Retorna OS cacheado sem fazer probe. null = cache frio. */
    getOSSync(): OSCapabilities | null {
        return this.cache.os?.data ?? null;
    }

    /** Retorna hardware cacheado sem fazer probe. null = cache frio. */
    getHardwareSync(): HardwareCapabilities | null {
        return this.cache.hardware?.data ?? null;
    }

    /** Retorna runtime cacheado sem fazer probe. null = cache frio. */
    getRuntimeSync(): RuntimeCapabilities | null {
        return this.cache.runtime?.data ?? null;
    }

    // ── Internos ──────────────────────────────────────────────────────────────

    private async getStatus(key: string): Promise<CapabilityStatus | null | undefined> {
        const [category, ...rest] = key.split('.');
        const subkey = rest.join('.');

        switch (category) {
            case 'workspace':
                await this.ensureFresh('workspace');
                return this.resolveWorkspaceStatus(subkey);
            case 'network':
                await this.ensureFresh('network');
                return this.resolveNetworkStatus(subkey);
            case 'execution':
                await this.ensureFresh('execution');
                return this.resolveExecutionStatus(subkey);
            case 'tool':
                await this.ensureFresh('tools');
                return this.cache.tools?.data[subkey] ?? null;
            default:
                log.warn(`[Registry] unknown capability key: ${key}`);
                return null;
        }
    }

    private getStatusSync(key: string): CapabilityStatus | null | undefined {
        const [category, ...rest] = key.split('.');
        const subkey = rest.join('.');

        switch (category) {
            case 'workspace':
                if (!this.cache.workspace) return undefined;
                return this.resolveWorkspaceStatus(subkey);
            case 'network':
                if (!this.cache.network) return undefined;
                return this.resolveNetworkStatus(subkey);
            case 'execution':
                if (!this.cache.execution) return undefined;
                return this.resolveExecutionStatus(subkey);
            case 'tool':
                if (!this.cache.tools) return undefined;
                return this.cache.tools.data[subkey] ?? null;
            default:
                return null;
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
        if (subkey === 'outbound')   return net.outboundHttp;
        if (subkey === 'localhost')  return net.localhostHttp;
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
