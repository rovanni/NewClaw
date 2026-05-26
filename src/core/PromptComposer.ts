/**
 * PromptComposer — Composição eficiente de prompts para o GoalPlanner.
 *
 * Substitui blocos verbosos por encoding compacto estruturado, filtrando
 * capabilities por relevância ao goal atual (goal-aware layers).
 *
 * Princípios:
 *   - Eficiência semântica por token, não minimização bruta
 *   - Só injeta o que é relevante para o goal (layer detection)
 *   - Formato compacto key:value em vez de prosa
 *   - Budget por seção para evitar prompt obesity
 *   - Métricas integradas para observabilidade
 */

import { createLogger } from '../shared/AppLogger';

const log = createLogger('PromptComposer');

// ── Tipos internos ────────────────────────────────────────────────────────────

type GoalLayer = 'workspace' | 'network' | 'media' | 'document' | 'code' | 'install';

interface ParsedCapabilities {
    availableTools:   string[];
    unavailableTools: string[];
    workspaceRoot:    string;
    workspaceRead:    boolean;
    workspaceWrite:   boolean;
    networkInternet:  boolean;
    networkLocalhost: boolean;
    pip:  boolean;
    npm:  boolean;
    sudo: boolean;
    // Operational environment
    osPlatform:    string;
    osShell:       string;
    osArch:        string;
    osPkg:         string;
    cpuCores:      number;
    ramFreeMB:     number;
    diskFreeMB:    number;
    gpuAvailable:  boolean;
    gpuLabel:      string;
    nodeVersion:   string;
    containerized: string;
}

interface MetricsAccumulator {
    planCount:             number;
    replanCount:           number;
    totalPromptChars:      number;
    totalCapabilityChars:  number;
    totalReflectionChars:  number;
    totalMemoryChars:      number;
}

export interface MetricsSnapshot {
    plans:                  number;
    replans:                number;
    avgPromptTokens:        number;
    avgCapabilityTokens:    number;
    avgReflectionTokens:    number;
    avgMemoryTokens:        number;
    compressionRatio:       number;
}

// ── Constantes ────────────────────────────────────────────────────────────────

// Keywords que ativam cada camada de capabilities
const LAYER_PATTERNS: Record<GoalLayer, RegExp> = {
    workspace: /\b(arquivo|file|pasta|folder|diret[oó]rio|workspace|salvar|criar|escrever|ler|editar|texto|conte[uú]do)\b/i,
    network:   /\b(download|url|https?|web|p[aá]gina|site|scrape|internet|buscar|navegar|acessar|curl|wget)\b/i,
    media:     /\b(v[ií]deo|[aá]udio|mp4|mp3|ffmpeg|imagem|gif|convert|m[ií]dia|m[uú]sica|foto|webm|avi)\b/i,
    document:  /\b(pdf|pptx|docx|markdown|apresenta[cç][aã]o|pandoc|relat[oó]rio|word|powerpoint|excel|xlsx)\b/i,
    code:      /\b(c[oó]digo|script|python|node|npm|pip|biblioteca|package|m[oó]dulo|programar|executar)\b/i,
    install:   /\b(instalar|install|depend[eê]ncia|pacote|pip install|npm install)\b/i,
};

// Fallback strategy por binário bloqueado
const TOOL_FALLBACKS: Record<string, string[]> = {
    pandoc:      ['python-pptx', 'html'],
    ffmpeg:      ['moviepy', 'pil'],
    marp:        ['python-pptx', 'html'],
    libreoffice: ['python-pptx', 'python-docx'],
    pdftotext:   ['pdfplumber', 'pdfminer'],
    pdfimages:   ['pdfplumber'],
    convert:     ['pil'],
    magick:      ['pil'],
    gs:          ['pdfplumber'],
};

// Camada que torna cada fallback relevante
const FALLBACK_LAYER: Record<string, GoalLayer> = {
    pandoc:      'document',
    ffmpeg:      'media',
    marp:        'document',
    libreoffice: 'document',
    pdftotext:   'document',
    pdfimages:   'document',
    convert:     'media',
    magick:      'media',
    gs:          'document',
};

// Budget em caracteres por seção (~chars/4 ≈ tokens)
const BUDGET = {
    capabilities: 1200,  // ~300 tokens
    reflection:   600,   // ~150 tokens
    memory:       1600,  // ~400 tokens
} as const;

// Baseline verbose para cálculo do compression ratio
const VERBOSE_BASELINE_CHARS = 2000;

// ── PromptComposer ────────────────────────────────────────────────────────────

export class PromptComposer {

    private static acc: MetricsAccumulator = {
        planCount:            0,
        replanCount:          0,
        totalPromptChars:     0,
        totalCapabilityChars: 0,
        totalReflectionChars: 0,
        totalMemoryChars:     0,
    };

    // ── Layer detection ───────────────────────────────────────────────────────

    /**
     * Detecta quais camadas de capabilities são relevantes para o goal.
     * Workspace é sempre incluída (quase todo goal envolve arquivos).
     */
    static detectLayers(goalText: string): Set<GoalLayer> {
        const layers = new Set<GoalLayer>();
        layers.add('workspace');  // core layer — sempre presente
        for (const [layer, pattern] of Object.entries(LAYER_PATTERNS) as [GoalLayer, RegExp][]) {
            if (pattern.test(goalText)) layers.add(layer);
        }
        return layers;
    }

    // ── Capability parser ─────────────────────────────────────────────────────

    private static parseCapabilities(context: string): ParsedCapabilities {
        const lines = context.split('\n').map(l => l.trim()).filter(Boolean);

        let availableTools:   string[] = [];
        let unavailableTools: string[] = [];
        let workspaceRoot   = '';
        let workspaceRead   = false;
        let workspaceWrite  = false;
        let networkInternet  = false;
        let networkLocalhost = false;
        let pip  = false;
        let npm  = false;
        let sudo = false;
        // Operational environment
        let osPlatform    = '';
        let osShell       = '';
        let osArch        = '';
        let osPkg         = '';
        let cpuCores      = 0;
        let ramFreeMB     = 0;
        let diskFreeMB    = 0;
        let gpuAvailable  = false;
        let gpuLabel      = '';
        let nodeVersion   = '';
        let containerized = '';

        for (const line of lines) {
            if (/indisponíveis/i.test(line)) {
                const m = line.match(/:\s*(.+)$/);
                if (m) unavailableTools = m[1].split(',').map(s => s.trim()).filter(Boolean);
            } else if (/^[•\-]?\s*ferramentas:/i.test(line)) {
                const m = line.match(/:\s*(.+)$/);
                if (m) availableTools = m[1].split(',').map(s => s.trim()).filter(Boolean);
            } else if (/workspace/i.test(line)) {
                workspaceRead  = /leitura ✓/.test(line);
                workspaceWrite = /escrita ✓/.test(line);
                const rm = line.match(/Workspace:\s*([^\s(]+)/);
                if (rm) workspaceRoot = rm[1];
            } else if (/rede:/i.test(line)) {
                networkInternet  = /internet ✓/.test(line);
                networkLocalhost = /localhost ✓/.test(line);
            } else if (/execu/i.test(line)) {
                pip  = /pip ✓/.test(line);
                npm  = /npm ✓/.test(line);
                sudo = /sudo ✓/.test(line);
            } else if (/^[•\-]?\s*OS:/i.test(line)) {
                // • OS: linux (ubuntu) | shell: /bin/bash | arch: x64 | pkg: apt
                const platM = line.match(/OS:\s*([\w]+)/i);
                if (platM) osPlatform = platM[1].toLowerCase();
                const shellM = line.match(/shell:\s*([^\s|]+)/i);
                if (shellM) osShell = shellM[1];
                const archM = line.match(/arch:\s*([^\s|]+)/i);
                if (archM) osArch = archM[1];
                const pkgM = line.match(/pkg:\s*([^\s|]+)/i);
                if (pkgM) osPkg = pkgM[1];
            } else if (/^[•\-]?\s*Hardware:/i.test(line)) {
                // • Hardware: cpu:4 cores | ram:2048MB total / 512MB livre | disk:20000MB livre | gpu:nenhuma
                const cpuM = line.match(/cpu:(\d+)/i);
                if (cpuM) cpuCores = parseInt(cpuM[1]);
                const ramM = line.match(/\/\s*(\d+)MB livre/i);
                if (ramM) ramFreeMB = parseInt(ramM[1]);
                const diskM = line.match(/disk:(\d+)MB/i);
                if (diskM) diskFreeMB = parseInt(diskM[1]);
                gpuAvailable = !/gpu:\s*nenhuma\b/i.test(line);
                const gpuM = line.match(/gpu:([^|]+)/i);
                if (gpuM) gpuLabel = gpuM[1].trim();
            } else if (/^[•\-]?\s*Runtime:/i.test(line)) {
                // • Runtime: node:v20.11.0 | containerizado:docker
                const nodeM = line.match(/node:(v[\d.]+)/i);
                if (nodeM) nodeVersion = nodeM[1];
                const contM = line.match(/containerizado:([^\s|]+)/i);
                if (contM) containerized = contM[1];
            }
        }

        return {
            availableTools, unavailableTools, workspaceRoot,
            workspaceRead, workspaceWrite,
            networkInternet, networkLocalhost,
            pip, npm, sudo,
            osPlatform, osShell, osArch, osPkg,
            cpuCores, ramFreeMB, diskFreeMB, gpuAvailable, gpuLabel,
            nodeVersion, containerized,
        };
    }

    // ── Compact ENV block ─────────────────────────────────────────────────────

    /**
     * Gera bloco [ENV] compacto e relevante ao goal.
     *
     * Exemplo de output para goal "criar apresentação pptx":
     *
     *   [ENV]
     *   tools:
     *     ok: [python3,npm,git]
     *     blocked: [pandoc,marp]
     *   workspace: {read: true, write: true}
     *   exec: {pip: true, sudo: false}
     *   skills: [pptx-generator]
     *   rules: [no_blocked_tools, feasibility_first, prefer_skills_over_exec]
     *   fallbacks:
     *     pandoc: [python-pptx,html]
     *   known_failures:
     *     pip_pep668:100%
     */
    static buildCompactEnv(
        capabilityContext: string,
        goalText: string,
        skillsSummary?: string,
        knownFailures?: string,
    ): string {
        if (!capabilityContext) return '';

        const caps   = this.parseCapabilities(capabilityContext);
        const layers = this.detectLayers(goalText);

        const parts: string[] = ['[ENV]'];

        // ── Tools ─────────────────────────────────────────────────────────────
        // Blocked: só os relevantes para as camadas detectadas
        const relevantBlocked = caps.unavailableTools.filter(t => {
            const tlayer = FALLBACK_LAYER[t.toLowerCase()];
            return !tlayer || layers.has(tlayer);  // sem layer mapeada → sempre mostrar
        });

        if (caps.availableTools.length > 0 || relevantBlocked.length > 0) {
            parts.push('tools:');
            if (caps.availableTools.length > 0)
                parts.push(`  ok: [${caps.availableTools.join(',')}]`);
            if (relevantBlocked.length > 0)
                parts.push(`  blocked: [${relevantBlocked.join(',')}]`);
        }

        // ── OS ────────────────────────────────────────────────────────────────
        if (caps.osPlatform) {
            const pkgStr  = caps.osPkg      ? `, pkg:${caps.osPkg}`   : '';
            const shellStr = caps.osShell   ? `, shell:${caps.osShell}` : '';
            const archStr  = caps.osArch    ? `, arch:${caps.osArch}`   : '';
            parts.push(`os: {platform:${caps.osPlatform}${shellStr}${archStr}${pkgStr}}`);
        }

        // ── Hardware (apenas para camadas que consomem recursos) ──────────────
        if (layers.has('media') || layers.has('code') || layers.has('install') || layers.has('document')) {
            if (caps.cpuCores > 0 || caps.ramFreeMB > 0 || caps.diskFreeMB > 0) {
                const gpuStr = caps.gpuAvailable
                    ? `, gpu:${caps.gpuLabel || 'true'}`
                    : ', gpu:false';
                parts.push(`hw: {cpu:${caps.cpuCores}, ram_free:${caps.ramFreeMB}MB, disk_free:${caps.diskFreeMB}MB${gpuStr}}`);
            }
        }

        // ── Runtime ───────────────────────────────────────────────────────────
        if (caps.nodeVersion || caps.containerized) {
            const contStr = caps.containerized && caps.containerized !== 'não'
                ? `, container:${caps.containerized}` : '';
            const nodeStr = caps.nodeVersion ? `node:${caps.nodeVersion}` : '';
            if (nodeStr || contStr) parts.push(`runtime: {${nodeStr}${contStr}}`);
        }

        // ── Workspace ─────────────────────────────────────────────────────────
        const wsPath = caps.workspaceRoot ? ` path:${caps.workspaceRoot}` : '';
        parts.push(`workspace: {read: ${caps.workspaceRead}, write: ${caps.workspaceWrite}, arbitrary_paths: false${wsPath}}`);

        // ── Network ───────────────────────────────────────────────────────────
        if (layers.has('network')) {
            parts.push(`network: {internet: ${caps.networkInternet}, localhost: ${caps.networkLocalhost}}`);
        }

        // ── Execução ──────────────────────────────────────────────────────────
        if (layers.has('code') || layers.has('install')) {
            parts.push(`exec: {pip: ${caps.pip}, npm: ${caps.npm}, sudo: ${caps.sudo}}`);
        }

        // ── Skills ────────────────────────────────────────────────────────────
        if (skillsSummary) {
            const names = skillsSummary
                .split('\n')
                .map(l => l.match(/- ([^:]+):/)?.[1]?.trim())
                .filter(Boolean)
                .join(',');
            if (names) parts.push(`skills: [${names}]`);
        }

        // ── Regras (compactas) ────────────────────────────────────────────────
        parts.push('rules: [no_blocked_tools, feasibility_first, prefer_skills_over_exec]');

        // ── Fallbacks: só ferramentas bloqueadas com fallback e layer ativa ───
        const fallbackEntries = relevantBlocked
            .map(t => t.toLowerCase())
            .filter(t => TOOL_FALLBACKS[t])
            .map(t => `  ${t}: [${TOOL_FALLBACKS[t].join(',')}]`);

        if (fallbackEntries.length > 0) {
            parts.push('fallbacks:');
            parts.push(...fallbackEntries);
        }

        // ── Known failures embutidos (do replan) ──────────────────────────────
        if (knownFailures) {
            parts.push(knownFailures);
        }

        const result = parts.join('\n');
        return this.enforceBudget(result, BUDGET.capabilities);
    }

    // ── Reflection compression ────────────────────────────────────────────────

    /**
     * Comprime o output verboso de ReflectionMemory.buildContextHint()
     * de ~400 chars para ~80 chars mantendo padrões e taxas de falha.
     *
     * Antes:
     *   "Padrões de erro similares detectados no histórico:\n
     *    - Ferramenta: exec_command | Padrão: pip_pep668 | Falha: 100% (3/3)\n
     *      Sugestão baseada em histórico: \"use venv\""
     *
     * Depois:
     *   "known_failures:\n  pip_pep668:100% fix:\"use venv\""
     */
    static compressReflection(hint: string): string {
        if (!hint) return '';

        const patternRe = /Padrão:\s*(\S+)\s*\|\s*Falha:\s*(\d+%)/g;
        const fixRe     = /Sugestão[^:]*:\s*"([^"]{1,60})"/g;

        const entries: Array<{ name: string; rate: string }> = [];
        const fixes:   string[] = [];

        let m: RegExpExecArray | null;
        while ((m = patternRe.exec(hint)) !== null) {
            entries.push({ name: m[1], rate: m[2] });
        }
        while ((m = fixRe.exec(hint)) !== null) {
            fixes.push(m[1].slice(0, 40));
        }

        if (entries.length === 0) return '';

        const lines = ['known_failures:'];
        for (let i = 0; i < entries.length; i++) {
            const fix = fixes[i] ? ` fix:"${fixes[i]}"` : '';
            lines.push(`  ${entries[i].name}:${entries[i].rate}${fix}`);
        }

        return this.enforceBudget(lines.join('\n'), BUDGET.reflection);
    }

    // ── Budget enforcement ────────────────────────────────────────────────────

    /**
     * Trunca texto ao budget em caracteres, cortando na última linha completa.
     * Usa ~4 chars/token como estimativa.
     */
    static enforceBudget(text: string, maxChars: number): string {
        if (text.length <= maxChars) return text;
        const truncated = text.slice(0, maxChars);
        const lastNl = truncated.lastIndexOf('\n');
        return lastNl > maxChars * 0.5
            ? truncated.slice(0, lastNl) + '\n  ...'
            : truncated + '...';
    }

    static enforceMemoryBudget(text: string): string {
        return this.enforceBudget(text, BUDGET.memory);
    }

    // ── Métricas ──────────────────────────────────────────────────────────────

    static recordPlan(promptChars: number, capChars: number, reflChars: number, memChars: number): void {
        this.acc.planCount++;
        this.acc.totalPromptChars      += promptChars;
        this.acc.totalCapabilityChars  += capChars;
        this.acc.totalReflectionChars  += reflChars;
        this.acc.totalMemoryChars      += memChars;
    }

    static recordReplan(): void {
        this.acc.replanCount++;
    }

    static getMetrics(): MetricsSnapshot {
        const n = Math.max(this.acc.planCount, 1);
        const avgPromptTokens     = Math.round(this.acc.totalPromptChars     / n / 4);
        const avgCapabilityTokens = Math.round(this.acc.totalCapabilityChars / n / 4);
        const avgReflectionTokens = Math.round(this.acc.totalReflectionChars / n / 4);
        const avgMemoryTokens     = Math.round(this.acc.totalMemoryChars     / n / 4);
        const compressionRatio    = avgCapabilityTokens > 0
            ? +((VERBOSE_BASELINE_CHARS / 4) / avgCapabilityTokens).toFixed(2)
            : 0;

        return {
            plans:               this.acc.planCount,
            replans:             this.acc.replanCount,
            avgPromptTokens,
            avgCapabilityTokens,
            avgReflectionTokens,
            avgMemoryTokens,
            compressionRatio,
        };
    }

    static logMetrics(): void {
        const m = this.getMetrics();
        log.info(
            `[Metrics] plans=${m.plans} replans=${m.replans}` +
            ` avgPrompt=${m.avgPromptTokens}tok avgCap=${m.avgCapabilityTokens}tok` +
            ` avgRefl=${m.avgReflectionTokens}tok compressionRatio=${m.compressionRatio}x`
        );
    }
}
