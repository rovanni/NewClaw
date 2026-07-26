/**
 * EnvironmentProbe — Detecta capabilities reais do ambiente antes do planejamento.
 *
 * Roda um probe leve via exec_command para determinar quais ferramentas estão
 * disponíveis, evitando planos inviáveis desde o início.
 *
 * Cache de 5 minutos para evitar overhead em goals sequenciais.
 * O probe é não-destrutivo: usa apenas `which`, imports passivos (Python) e require() passivo
 * (Node) — o mecanismo varia por dependência (DependencyInfo.probeVia em GoalTypes.ts), nunca
 * por suposição.
 */

import { createLogger } from '../shared/AppLogger';
import { ToolRegistry } from './ToolRegistry';
import { probeToolCmd, resolvePython3Runtime, defaultPython3Candidates, runPython3Import, isBashFunctional, probeNodeRequire } from '../utils/crossPlatform';
import { KNOWN_DEPS } from '../loop/GoalEvaluator';

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
//
// magick/soffice/pdfimages/jq/unzip/gs/ghostscript/exiftool/npx/tesseract adicionados em
// Sprint 005/5.2 (docs/Auditorias/2026-07-26/AUDITORIA_CATALOGOS_FERRAMENTAS_2026-07-26.md, Caso 1): estavam em
// KNOWN_DEPS (GoalEvaluator.ts) com comando de instalação pronto, mas ausentes daqui — o
// planner nunca via "INDISPONÍVEL" proativamente para eles, só reativamente após ENOENT real.
// Ver S153_CatalogConsistency para o teste que impede esse tipo de gap reaparecer sem aviso.
//
// 'puppeteer' (também presente em KNOWN_DEPS) permanece deliberadamente FORA desta lista: não
// é um binário no PATH, é um módulo Node consumido via `require('puppeteer')`
// (scripts/html2pdf.sh:174) — o mecanismo de probe abaixo (`where`/`command -v`) sempre
// reportaria "ausente" mesmo com o pacote npm instalado e funcional, um FALSO NEGATIVO pior
// do que nenhuma informação. Verificado por um mecanismo diferente, não por exclusão silenciosa:
// ver NODE_REQUIRE_PROBE_TARGETS abaixo — qualquer entrada de KNOWN_DEPS com
// `probeVia: 'node-require'` (GoalTypes.ts) é sondada via probeNodeRequire() (crossPlatform.ts,
// mesmo padrão de runPython3Import) em vez de where/command -v. Isso é declarado uma vez, no
// próprio KNOWN_DEPS — a próxima dependência Node "require-only" (não só puppeteer) fica
// coberta corretamente por construção, sem exigir lembrar de adicionar uma segunda exceção
// manual aqui. Ver S154_CatalogConsistency para o teste que garante essa cobertura.
// Exportado para o teste de consistência de catálogos (S154_CatalogConsistency) verificar
// paridade com KNOWN_DEPS (GoalEvaluator.ts) sem duplicar esta lista via parsing de código-fonte.
// 'python3' fica FORA desta lista deliberadamente — mesmo motivo de 'bash' (ver abaixo):
// no Windows, `where python3` (e `where python`) encontram o stub do App Execution Alias
// da Microsoft Store mesmo sem nenhum Python real instalado — o arquivo existe no PATH,
// mas rodá-lo abre a Store ou falha ("Python was not found..."). Falso positivo reproduzido
// ao vivo em 26/07/2026: probe reportou "python3 disponível", o planner gerou um step
// python-pptx, e 5+ minutos de exec_command (`pip install`, `python3 script.py`) falharam
// um a um até o replan finalmente trocar de estratégia. 'pip3' permanece no probe genérico:
// diferente de python.exe/python3.exe, pip3.exe não é um alvo do App Execution Alias — só
// existe no PATH quando um Python real já instalou seus Scripts, então `where pip3` não
// sofre do mesmo falso positivo (sem evidência de que esteja errado, não é alterado aqui).
export const TOOLS_TO_PROBE = [
    'pandoc', 'marp', 'pip3', 'node', 'npm',
    'ffmpeg', 'convert', 'libreoffice', 'pdftotext',
    'git', 'zip', 'wget', 'curl', 'edge-tts',
    'magick', 'soffice', 'pdfimages', 'jq', 'unzip',
    'gs', 'ghostscript', 'exiftool', 'npx', 'tesseract',
];

// Dependências de KNOWN_DEPS cujo mecanismo correto de verificação é require(), não PATH —
// derivado da própria fonte única (GoalEvaluator.ts), não de uma lista mantida à mão aqui.
export const NODE_REQUIRE_PROBE_TARGETS = Object.entries(KNOWN_DEPS)
    .filter(([, dep]) => dep.probeVia === 'node-require')
    .map(([key]) => key);

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

            // 'bash' fica FORA de TOOLS_TO_PROBE deliberadamente: o probe genérico acima
            // usa `where`/`command -v`, que no Windows encontra o launcher stub do WSL
            // (bash.exe presente) mesmo sem nenhuma distro instalada — falso positivo que já
            // causou replans desperdiçados em produção (ver isBashFunctional() em
            // crossPlatform.ts). Só um probe de execução real detecta isso.
            tools['bash'] = await isBashFunctional();

            // 'puppeteer' e qualquer outra entrada de KNOWN_DEPS com probeVia: 'node-require'
            // não são binários de PATH — probadas via `node -e require(...)` (probeNodeRequire,
            // crossPlatform.ts), mesmo padrão do probe de pacotes Python abaixo. Mescladas no
            // mesmo mapa `tools` (não um bucket separado): para o texto de evidência gerado mais
            // abaixo, "disponível"/"indisponível" já trata todo mundo igual — a diferença é só
            // no MECANISMO de verificação, nunca na forma como a evidência chega ao Planner.
            if (NODE_REQUIRE_PROBE_TARGETS.length > 0) {
                const nodeReqResults = await Promise.all(
                    NODE_REQUIRE_PROBE_TARGETS.map(async (m): Promise<[string, boolean]> => [m, await probeNodeRequire(m)])
                );
                for (const [m, available] of nodeReqResults) tools[m] = available;
            }

            // ── 2. Python package probe — resolve o runtime Python 3 UMA VEZ e reutiliza
            // para os 4 pacotes (nunca via exec_command/shell: um path absoluto com espaços
            // no `command` do runtime não teria como ser citado com segurança num one-liner
            // sem um helper de shell escaping, que não existe no projeto — execFile com
            // array de args evita esse problema por construção).
            const pythonPkgs: Record<string, boolean> = {};
            const pythonRuntime = await resolvePython3Runtime(defaultPython3Candidates());

            // 'python3'/'python' em `tools` refletem o MESMO runtime validado por execução real
            // acima (nunca o resultado de `where`/`command -v`, que o stub do Windows Store
            // engana) — mesmo padrão de 'bash'/isBashFunctional(). Isso é o que chega ao
            // GoalPlanner via CapabilityRegistry.getCapabilitySummary() ("Indisponíveis (não
            // usar): ..."), então um Windows sem Python real agora aparece como tal ANTES do
            // plano ser montado, em vez de só ser descoberto depois de vários exec_command falhos.
            tools['python3'] = pythonRuntime !== null;
            tools['python']  = pythonRuntime !== null;

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
