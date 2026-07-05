/**
 * EnvironmentProbe — Detecta capabilities reais do ambiente antes do planejamento.
 *
 * Roda um probe leve via exec_command para determinar quais ferramentas estão
 * disponíveis, evitando planos inviáveis desde o início.
 *
 * Cache de 5 minutos para evitar overhead em goals sequenciais.
 * O probe é não-destrutivo: usa apenas `which` e imports passivos.
 */

import { createLogger } from '../shared/AppLogger';
import { ToolRegistry } from '../core/ToolRegistry';
import { probeToolCmd, resolvePython3Runtime, defaultPython3Candidates, runPython3Import } from '../utils/crossPlatform';

const log = createLogger('EnvironmentProbe');

const PROBE_CACHE_TTL_MS = 5 * 60 * 1000;

export interface EnvironmentCapabilities {
    /** Ferramentas encontradas/não-encontradas via `which`. */
    tools: Record<string, boolean>;
    /** Pacotes Python disponíveis (import passivo). */
    pythonPkgs: Record<string, boolean>;
    probeTimestamp: number;
    /** Bloco de texto pronto para injeção em prompts de planejamento. */
    summary: string;
}

// Executáveis a verificar. Mantido pequeno para que o probe caiba em <500ms.
// edge-tts adicionado após bug real (04/07/2026): send_audio dependia dele silenciosamente —
// sem entrar neste probe, o planner nunca via "INDISPONÍVEL" e só descobria via ENOENT em
// runtime, depois de já ter tentado (e, por um bug relacionado no debounce, mascarado a falha).
const TOOLS_TO_PROBE = [
    'pandoc', 'marp', 'python3', 'pip3', 'node', 'npm',
    'ffmpeg', 'convert', 'libreoffice', 'pdftotext',
    'git', 'zip', 'wget', 'curl', 'edge-tts',
];

const PYTHON_PKGS_TO_PROBE = ['pptx', 'docx', 'PIL', 'markdown'];

// Cache global — partilhado entre todas as instâncias no mesmo processo.
let cachedCapabilities: EnvironmentCapabilities | null = null;

export class EnvironmentProbe {

    /**
     * Executa o probe e retorna as capabilities do ambiente.
     * Usa cache se o último probe tiver menos de 5 minutos.
     */
    async probe(): Promise<EnvironmentCapabilities> {
        if (cachedCapabilities && Date.now() - cachedCapabilities.probeTimestamp < PROBE_CACHE_TTL_MS) {
            return cachedCapabilities;
        }

        const execTool = ToolRegistry.get('exec_command');
        if (!execTool) {
            log.warn('[EnvironmentProbe] exec_command não disponível — probe ignorado');
            return this.emptyCapabilities();
        }

        try {
            // ── 1. Tool probe (cross-platform: where on Windows, command -v on Unix) ─
            const cmdSep  = process.platform === 'win32' ? ' & ' : '; ';
            const whichCmds = TOOLS_TO_PROBE.map(t => probeToolCmd(t)).join(cmdSep);

            const result = await execTool.execute({ command: whichCmds });

            const tools: Record<string, boolean> = {};

            if (result.success && result.output) {
                for (const line of result.output.split('\n')) {
                    const trimmed = line.trim();
                    if (trimmed.startsWith('OK:'))           tools[trimmed.slice(3)] = true;
                    else if (trimmed.startsWith('MISSING:')) tools[trimmed.slice(8)] = false;
                }
            }

            // Preenche faltantes como false (probe pode ter sido parcial)
            for (const t of TOOLS_TO_PROBE) if (!(t in tools)) tools[t] = false;

            // ── 2. Python package probe — resolve o runtime Python 3 UMA VEZ e reutiliza
            // para os 4 pacotes (nunca via exec_command/shell: um path absoluto com espaços
            // no `command` do runtime não teria como ser citado com segurança num one-liner
            // sem um helper de shell escaping, que não existe no projeto — execFile com
            // array de args evita esse problema por construção).
            const pythonPkgs: Record<string, boolean> = {};
            const pythonRuntime = await resolvePython3Runtime(defaultPython3Candidates());
            if (pythonRuntime) {
                const pkgResults = await Promise.all(
                    PYTHON_PKGS_TO_PROBE.map(async (p): Promise<[string, boolean]> => [p, await runPython3Import(pythonRuntime, p)])
                );
                for (const [p, available] of pkgResults) pythonPkgs[p] = available;
            } else {
                // Nenhum candidato de Python 3 validado — pacotes Python ficam indisponíveis,
                // mas isso NÃO aborta os probes de ferramentas não-Python acima (já concluídos).
                for (const p of PYTHON_PKGS_TO_PROBE) pythonPkgs[p] = false;
            }

            const available   = Object.entries(tools).filter(([, v]) =>  v).map(([k]) => k);
            const unavailable = Object.entries(tools).filter(([, v]) => !v).map(([k]) => k);
            const availablePy = Object.entries(pythonPkgs).filter(([, v]) =>  v).map(([k]) => k);

            const summaryLines = [
                `[AMBIENTE] Ferramentas disponíveis: ${available.length > 0 ? available.join(', ') : 'nenhuma detectada'}`,
                unavailable.length > 0 ? `[AMBIENTE] Ferramentas INDISPONÍVEIS (não tente usá-las): ${unavailable.join(', ')}` : '',
                availablePy.length > 0 ? `[AMBIENTE] Python packages disponíveis: ${availablePy.join(', ')}` : '',
            ].filter(Boolean);

            const summary = summaryLines.join('\n');

            cachedCapabilities = { tools, pythonPkgs, probeTimestamp: Date.now(), summary };
            log.info(`[EnvironmentProbe] probe ok: available=[${available.join(',')}] py=[${availablePy.join(',')}]`);
            return cachedCapabilities;

        } catch (err) {
            log.warn('[EnvironmentProbe] probe falhou, prosseguindo sem capabilities:', String(err));
            return this.emptyCapabilities();
        }
    }

    /**
     * Invalida o cache (chamar após instalação de dependência bem-sucedida,
     * para que o próximo plano veja a ferramenta recém-instalada).
     */
    static invalidateCache(): void {
        cachedCapabilities = null;
    }

    private emptyCapabilities(): EnvironmentCapabilities {
        return { tools: {}, pythonPkgs: {}, probeTimestamp: Date.now(), summary: '' };
    }
}
