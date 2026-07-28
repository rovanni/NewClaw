/**
 * GoalEvaluator — Trata falhas de tool como estado, não como exceção.
 *
 * Classificação determinística de resultados de execução:
 *   success   → objetivo do step alcançado
 *   partial   → progresso parcial, retry pode funcionar
 *   blocked   → blocker identificado, replan necessário
 *   failed    → irrecuperável, budget esgotado
 *   needs_auth → autorização explícita requerida antes de prosseguir
 *
 * A classificação usa padrões de erro conhecidos antes de recorrer a LLM,
 * para garantir latência mínima na maioria dos casos.
 */

import { createLogger } from '../shared/AppLogger';
import { ToolResult } from './agentLoopTypes';
import { Goal, PlanStep, CycleResult, GoalBlocker, BlockerKind, DependencyInfo } from './GoalTypes';
import { OperationalKnowledge, currentPlatform } from '../memory/OperationalKnowledge';
import { permissionRegistry } from '../core/PermissionRegistry';
import { resolveInstallCommand } from './planning/resolveInstallCommand';
import { extractMissingExecutable } from './planning/extractMissingExecutable';
import { computeToolInputKey } from './planning/computeToolInputKey';
import { ECONNRESET_PATTERN, ETIMEDOUT_PATTERN, TIMEOUT_PATTERN, NETWORK_PATTERN, RATE_LIMIT_PATTERN, HTTP_429_PATTERN, combineRegExp } from '../shared/transientErrorPatterns';

const log = createLogger('GoalEvaluator');

// ── Mapa de dependências instaláveis automaticamente ─────────────────────────
// Chave: nome do executável que aparece na mensagem de erro (lowercase)

// Exportado (Sprint 005/5.1, docs/Auditorias/2026-07-26/AUDITORIA_CATALOGOS_FERRAMENTAS_2026-07-26.md): única fonte
// de verdade para metadados de dependência de SO — RiskAnalyzer.ts deriva seu aviso de risco
// pré-execução (bloco "1b") a partir daqui em vez de manter uma cópia própria (KNOWN_SYSTEM_DEPS,
// removida). Nenhum outro consumidor deve reimplementar este mapa.
// Instruções manuais no formato "Windows: X | Linux: Y | macOS: Z" (mesmo padrão já
// estabelecido e testado em KNOWN_DEPS['edge-tts'] e nas skills system-provisioner/skill-manager,
// ver S148_SkillCrossPlatform_WindowsInstructions.test.ts) — IDs de pacote winget confirmados
// via busca (não adivinhados) em 27/07/2026. `installCmd` (legado, só usado em Linux por
// resolveInstallCommand()) permanece intocado; nenhuma entrada abaixo ganhou installByPlatform —
// isso deliberadamente NÃO habilita auto-instalação via winget nesta rodada (ver comentário do
// tesseract mais abaixo para o motivo). `ffmpeg` chegou a ganhar installByPlatform.windows
// brevemente em 2026-07-28 para um teste real — revertido no mesmo dia: o objetivo do teste era
// justamente provar que o agente descobre e instala SEM entrada prévia no catálogo (ciclo de
// Pesquisa da RFC-003, Sprint C parte 2) — hardcoded o comando aqui reproduziria exatamente o
// padrão que essa RFC existe para eliminar.
export const KNOWN_DEPS: Record<string, DependencyInfo> = {
    pandoc:      { name: 'pandoc',                 installCmd: 'sudo apt install pandoc -y',                  manualInstructions: 'Windows: winget install JohnMacFarlane.Pandoc | Linux: sudo apt install pandoc -y | macOS: brew install pandoc',                       type: 'system' },
    // verifyCmd: 'ffmpeg -version' — comando padrão e estável do próprio ffmpeg (funciona
    // idêntico em Windows/Linux/macOS, sem flag específica de plataforma) — único verifyCmd
    // populado nesta Sprint (RFC-003 Sprint D), por ser a entrada com evidência concreta que
    // originou toda a investigação. SEM installByPlatform de propósito: o ciclo de Pesquisa
    // (Sprint C parte 2) é o caminho que deve resolver ffmpeg quando ausente, não uma entrada
    // hardcoded — ver comentário acima da tabela.
    ffmpeg:      { name: 'ffmpeg',                 installCmd: 'sudo apt install ffmpeg -y',                  manualInstructions: 'Windows: winget install Gyan.FFmpeg | Linux: sudo apt install ffmpeg -y | macOS: brew install ffmpeg', verifyCmd: 'ffmpeg -version',              type: 'system' },
    convert:     { name: 'imagemagick',            installCmd: 'sudo apt install imagemagick -y',             manualInstructions: 'Windows: winget install ImageMagick.ImageMagick | Linux: sudo apt install imagemagick -y | macOS: brew install imagemagick',                  type: 'system' },
    magick:      { name: 'imagemagick',            installCmd: 'sudo apt install imagemagick -y',             manualInstructions: 'Windows: winget install ImageMagick.ImageMagick | Linux: sudo apt install imagemagick -y | macOS: brew install imagemagick',                  type: 'system' },
    libreoffice: { name: 'libreoffice',            installCmd: 'sudo apt install libreoffice -y',             manualInstructions: 'Windows: winget install TheDocumentFoundation.LibreOffice | Linux: sudo apt install libreoffice -y | macOS: brew install --cask libreoffice',                  type: 'system' },
    soffice:     { name: 'libreoffice',            installCmd: 'sudo apt install libreoffice -y',             manualInstructions: 'Windows: winget install TheDocumentFoundation.LibreOffice | Linux: sudo apt install libreoffice -y | macOS: brew install --cask libreoffice',                  type: 'system' },
    pdftotext:   { name: 'poppler-utils',          installCmd: 'sudo apt install poppler-utils -y',           manualInstructions: 'Windows: winget install oschwartz10612.Poppler | Linux: sudo apt install poppler-utils -y | macOS: brew install poppler',               type: 'system' },
    pdfimages:   { name: 'poppler-utils',          installCmd: 'sudo apt install poppler-utils -y',           manualInstructions: 'Windows: winget install oschwartz10612.Poppler | Linux: sudo apt install poppler-utils -y | macOS: brew install poppler',               type: 'system' },
    jq:          { name: 'jq',                     installCmd: 'sudo apt install jq -y',                      manualInstructions: 'Windows: winget install jqlang.jq | Linux: sudo apt install jq -y | macOS: brew install jq',                          type: 'system' },
    zip:         { name: 'zip',                    installCmd: 'sudo apt install zip -y',                     manualInstructions: 'Windows: sem "zip" nativo — use Compress-Archive do PowerShell, ou winget install 7zip.7zip (sintaxe de comando diferente) | Linux: sudo apt install zip -y | macOS: já vem no sistema',                         type: 'system' },
    unzip:       { name: 'unzip',                  installCmd: 'sudo apt install unzip -y',                   manualInstructions: 'Windows: sem "unzip" nativo — use Expand-Archive do PowerShell, ou winget install 7zip.7zip (sintaxe de comando diferente) | Linux: sudo apt install unzip -y | macOS: já vem no sistema',                       type: 'system' },
    curl:        { name: 'curl',                   installCmd: 'sudo apt install curl -y',                    manualInstructions: 'Windows: já vem instalado desde o Windows 10 1803+; se ausente: winget install cURL.cURL | Linux: sudo apt install curl -y | macOS: já vem no sistema',                        type: 'system' },
    wget:        { name: 'wget',                   installCmd: 'sudo apt install wget -y',                    manualInstructions: 'Windows: winget install JernejSimoncic.Wget | Linux: sudo apt install wget -y | macOS: brew install wget',                        type: 'system' },
    git:         { name: 'git',                    installCmd: 'sudo apt install git -y',                     manualInstructions: 'Windows: winget install Git.Git | Linux: sudo apt install git -y | macOS: brew install git (ou Xcode Command Line Tools)',                         type: 'system' },
    gs:          { name: 'ghostscript',            installCmd: 'sudo apt install ghostscript -y',             manualInstructions: 'Windows: winget install ArtifexSoftware.GhostScript | Linux: sudo apt install ghostscript -y | macOS: brew install ghostscript',                 type: 'system' },
    ghostscript: { name: 'ghostscript',            installCmd: 'sudo apt install ghostscript -y',             manualInstructions: 'Windows: winget install ArtifexSoftware.GhostScript | Linux: sudo apt install ghostscript -y | macOS: brew install ghostscript',                 type: 'system' },
    exiftool:    { name: 'libimage-exiftool-perl', installCmd: 'sudo apt install libimage-exiftool-perl -y', manualInstructions: 'Windows: winget install OliverBetz.ExifTool | Linux: sudo apt install libimage-exiftool-perl -y | macOS: brew install exiftool',      type: 'system' },
    npm:         { name: 'npm',                    installCmd: 'sudo apt install npm -y',                     manualInstructions: 'Windows: winget install OpenJS.NodeJS (inclui npm) | Linux: sudo apt install npm -y | macOS: brew install node',                         type: 'node'   },
    npx:         { name: 'npm',                    installCmd: 'sudo apt install npm -y',                     manualInstructions: 'Instale npm (inclui npx) — Windows: winget install OpenJS.NodeJS | Linux: sudo apt install npm -y | macOS: brew install node',            type: 'node'   },
    node:        { name: 'nodejs',                 installCmd: 'sudo apt install nodejs npm -y',              manualInstructions: 'Windows: winget install OpenJS.NodeJS | Linux: sudo apt install nodejs npm -y | macOS: brew install node',                  type: 'node'   },
    // marp é a única entrada hoje cujo comando (npm install -g) já é genuinamente cross-platform
    // — migrada para installByPlatform explícito em vez de installCmd legado, para não depender
    // do fallback "só Linux" e não perder a instalação automática em Windows/macOS.
    marp:        { name: '@marp-team/marp-cli',    installByPlatform: { windows: 'npm install -g @marp-team/marp-cli', linux: 'npm install -g @marp-team/marp-cli', macos: 'npm install -g @marp-team/marp-cli' }, manualInstructions: 'Instale o marp-cli globalmente: npm install -g @marp-team/marp-cli', type: 'node' },
    // puppeteer: mesmo padrão do marp acima — `npm install puppeteer` já baixa um Chromium
    // embutido, então é genuinamente cross-platform e não depende de instalar Chrome no SO
    // (evita também o problema conhecido de `apt install chromium` redirecionar para pacote
    // snap no Ubuntu moderno, que costuma falhar em ambiente headless/VPS sem sessão gráfica).
    // Usado por scripts/html2pdf.sh (modo PDF e modo screenshot/PNG da revisão visual).
    // probeVia: 'node-require' — não é binário de PATH, é módulo consumido via
    // require('puppeteer') (scripts/html2pdf.sh:174). Ver EnvironmentProbe.ts.
    puppeteer:   { name: 'puppeteer',              installByPlatform: { windows: 'npm install puppeteer', linux: 'npm install puppeteer', macos: 'npm install puppeteer' }, manualInstructions: 'Instale com: npm install puppeteer (inclui Chromium embutido, sem precisar de Chrome do sistema)', type: 'node', probeVia: 'node-require' },
    // tesseract: fallback de OCR em read_document.ts (extractOcr/pdfOcr). manualInstructions
    // ganhou o comando Windows (UB-Mannheim.TesseractOCR, confirmado por busca) — mas sem
    // installByPlatform: instalação automática via winget costuma pedir confirmação interativa
    // (--accept-package-agreements/--accept-source-agreements) que exec_command não trata hoje;
    // habilitar auto-install fica para quando esse tratamento existir, não nesta rodada.
    tesseract:   { name: 'tesseract-ocr',          installCmd: 'sudo apt install tesseract-ocr tesseract-ocr-por -y', manualInstructions: 'Windows: winget install UB-Mannheim.TesseractOCR | Linux: sudo apt install tesseract-ocr tesseract-ocr-por -y | macOS: brew install tesseract tesseract-lang', type: 'system' },
    pip:         { name: 'python3-pip',            installCmd: 'sudo apt install python3-pip -y',             manualInstructions: 'Windows: winget install --id Python.Python.3 (inclui pip) | Linux: sudo apt install python3-pip -y | macOS: já vem com o Python 3 do Homebrew (brew install python)',                 type: 'python' },
    pip3:        { name: 'python3-pip',            installCmd: 'sudo apt install python3-pip -y',             manualInstructions: 'Windows: winget install --id Python.Python.3 (inclui pip) | Linux: sudo apt install python3-pip -y | macOS: já vem com o Python 3 do Homebrew (brew install python)',                 type: 'python' },
    // edge-tts: SEM installCmd/installByPlatform de propósito nesta rodada. O execution loop
    // (GoalExecutionLoop.ts, needs_dependency) resolve o comando via resolveInstallCommand()
    // e o executa direto via exec_command sem antes checar se o runtime Python (python3/pip3)
    // está presente — declarar aqui um comando "python -m pip install edge-tts" apenas
    // moveria a falha para um segundo ENOENT (agora de 'python'), sem ganho real. Por ora,
    // edge-tts é reconhecido, classificado e vira needs_dependency com instrução manual;
    // auto-install fica para uma rodada futura que valide o runtime antes de auto-instalar.
    'edge-tts':  { name: 'edge-tts',               manualInstructions: 'Instale o edge-tts (requer Python 3 + pip) — Windows: python -m pip install edge-tts | Linux: python3 -m pip install edge-tts | macOS: python3 -m pip install edge-tts', type: 'python' },
};

// ── Padrões de classificação de erro ─────────────────────────────────────────

interface ErrorPattern {
    pattern: RegExp;
    kind: BlockerKind;
    description: (match: RegExpMatchArray, toolName: string) => string;
    suggestedActions: string[];
    isRetryable: boolean;
}

const ERROR_PATTERNS: ErrorPattern[] = [
    // ENOENT de operação de arquivo/diretório (fs: open/scandir/stat/...), NÃO de processo.
    // Precisa vir ANTES do padrão de missing_tool: "ENOENT: no such file or directory, open
    // 'input.mp3'" contém tanto "ENOENT" quanto "no such file" — sem esta exclusão explícita,
    // TODO ENOENT de fs (arquivo de entrada ou diretório ausente) seria confundido com
    // executável ausente. O shape do Node distingue os dois: erro de spawn é "spawn <cmd>
    // ENOENT" (ENOENT no final, sem vírgula); erro de fs é "ENOENT: no such file or directory,
    // <syscall> '<path>'" (ENOENT no início, com o verbo de syscall depois da vírgula).
    {
        pattern: /ENOENT:\s*no such file or directory,\s*(?:open|scandir|lstat|stat|access|unlink|mkdir|rmdir|readdir|rename|copyfile|realpath)/i,
        kind: 'tool_error',
        description: (_, tool) => `Arquivo ou diretório não encontrado ao executar '${tool}'`,
        suggestedActions: [
            'Verificar se o caminho existe com list_workspace',
            'Corrigir o caminho no próximo passo',
        ],
        isRetryable: false,
    },
    // Ferramenta não encontrada — fallback de ÚLTIMO recurso, só alcançado quando nem exitCode
    // estruturado (127) nem extractMissingExecutable() (que já cobre "is not recognized..." em
    // inglês e pt-BR, e o "[exit code: 127]" some daqui porque classifyError() checa exitCode
    // ANTES desta lista) identificaram o caso — mantido só pra texto solto tipo "not found" sem
    // formato reconhecido o bastante pra extrair um nome.
    {
        pattern: /command not found|not found|no such file|ENOENT|which: no|cannot find/i,
        kind: 'missing_tool',
        description: (_, tool) => `Ferramenta '${tool}' não encontrada no sistema`,
        suggestedActions: [
            'Instalar a ferramenta via gerenciador de pacotes',
            'Buscar ferramenta alternativa com a mesma função',
            'Usar abordagem que não dependa desta ferramenta',
        ],
        isRetryable: false,
    },
    // Permissão negada
    {
        pattern: /permission denied|EACCES|access denied|unauthorized|forbidden|403/i,
        kind: 'missing_permission',
        description: (_, tool) => `Permissão negada ao executar '${tool}'`,
        suggestedActions: [
            'Solicitar autorização explícita do usuário',
            'Verificar permissões de arquivo ou diretório',
            'Usar alternativa com permissões adequadas',
        ],
        isRetryable: false,
    },
    // Sem conexão / rede
    {
        pattern: combineRegExp([/ECONNREFUSED/i, ECONNRESET_PATTERN, ETIMEDOUT_PATTERN, NETWORK_PATTERN, /no route/i, /getaddrinfo/i, /fetch failed/i]),
        kind: 'environment_limit',
        description: () => 'Falha de conectividade de rede',
        suggestedActions: [
            'Verificar conexão de internet',
            'Tentar novamente após alguns segundos',
            'Usar fonte local como alternativa',
        ],
        isRetryable: true,
    },
    // Rate limit / quota
    {
        pattern: combineRegExp([RATE_LIMIT_PATTERN, /too many requests/i, HTTP_429_PATTERN, /quota exceeded/i]),
        kind: 'environment_limit',
        description: () => 'Limite de requisições atingido',
        suggestedActions: [
            'Aguardar e tentar novamente',
            'Usar provider ou API alternativa',
        ],
        isRetryable: true,
    },
    // Arquivo protegido / criptografado
    {
        pattern: /encrypted|protected|password.?protected|cannot decrypt/i,
        kind: 'context_insufficient',
        description: () => 'Arquivo protegido por senha ou criptografado',
        suggestedActions: [
            'Usar ferramenta de OCR como fallback',
            'Solicitar senha ao usuário',
            'Tentar extração parcial de texto visível',
        ],
        isRetryable: false,
    },
    // python3-venv não instalado (ensurepip ausente) — venv não pode ser criado
    {
        pattern: /ensurepip is not available|python3-venv|ensurepip/i,
        kind: 'environment_limit',
        description: () => 'python3-venv não instalado — criação de venv bloqueada (ensurepip ausente)',
        suggestedActions: [
            'NÃO tente python3 -m venv — ensurepip não está disponível neste sistema',
            'Usar pandoc para conversão direta: pandoc arquivo.md -o arquivo.pptx',
            'Usar Node.js/Marp para PPTX: npx @marp-team/marp-cli arquivo.md --pptx',
            'Instalar python3-venv: sudo apt install python3-venv (requer sudo)',
        ],
        isRetryable: false,
    },
    // Python PEP 668 — pip bloqueado pelo sistema operacional
    {
        pattern: /externally-managed-environment|PEP 668|This environment is externally managed/i,
        kind: 'environment_limit',
        description: () => 'Python protegido pelo sistema (PEP 668) — pip install bloqueado',
        suggestedActions: [
            'Criar ambiente virtual e instalar: python3 -m venv venv && venv/bin/pip install <pacote> && venv/bin/python script.py',
            'Usar pandoc para conversão direta (sem Python): pandoc arquivo.md -o arquivo.pptx',
            'Usar pipx para ferramentas globais: pipx install <ferramenta>',
        ],
        isRetryable: false,
    },
    // Disco cheio
    {
        pattern: /ENOSPC|no space left|disk full/i,
        kind: 'environment_limit',
        description: () => 'Espaço em disco insuficiente',
        suggestedActions: [
            'Limpar arquivos temporários',
            'Usar diretório alternativo com mais espaço',
        ],
        isRetryable: false,
    },
    // Timeout
    {
        pattern: combineRegExp([TIMEOUT_PATTERN, /timed out/i, /exceeded.*time/i]),
        kind: 'tool_error',
        description: (_, tool) => `Timeout na execução de '${tool}'`,
        suggestedActions: [
            'Tentar com um subconjunto menor dos dados',
            'Aumentar timeout se configurável',
            'Dividir a tarefa em partes menores',
        ],
        isRetryable: true,
    },
    // Conteúdo placeholder gravado no write — blocker content_stub
    // Captura o prefixo emitido pelo CONTENT-STUB-GATE do WriteTool.
    // Orienta o GoalPlanner a usar AgentLoop (sem toolName) no lugar de write+content fixo.
    {
        pattern: /\[CONTENT-STUB\]/,
        kind: 'content_stub',
        description: (_, tool) => `Step '${tool}' gerou conteúdo placeholder — usar AgentLoop para síntese real`,
        suggestedActions: [
            'OMITA toolName no step de síntese — o AgentLoop gerará o conteúdo REAL com os dados dos steps anteriores',
            'Estrutura correta: {"description": "Gere o HTML completo de slides..."} (sem toolName, sem toolArgs)',
            'Não pré-gere content no plano JSON quando ele depende de pesquisa ou síntese',
        ],
        isRetryable: false,
    },
];

// ── GoalEvaluator ─────────────────────────────────────────────────────────────

export class GoalEvaluator {
    /**
     * RFC-003 Sprint C (`docs/decisoes/RFC-003_AQUISICAO_CONHECIMENTO_OPERACIONAL.md`) — opcional,
     * mesmo padrão fail-open já usado em `GoalExecutionLoop`/`GoalPlanner`: sem ela, o
     * comportamento é idêntico ao anterior a esta Sprint (só `KNOWN_DEPS` é consultado).
     */
    constructor(private readonly operationalKnowledge?: OperationalKnowledge) {}

    evaluate(goal: Goal, planStep: PlanStep, toolResult: ToolResult): CycleResult {
        if (toolResult.success) {
            log.debug(`[GoalEvaluator] step=${planStep.id} success`);
            return { outcome: 'success', confidence: 1.0, output: toolResult.output };
        }

        const toolName = planStep.toolName ?? 'unknown';
        const error = toolResult.error ?? toolResult.output ?? '';

        // Item 9: Immediate replan on dedup — se este step+tool+args já falhou antes,
        // bloquear imediatamente sem retry para evitar loop de tentativas idênticas.
        if (this.hasIdenticalFailedAttempt(goal, planStep, toolName)) {
            log.warn(`[GoalEvaluator] dedup step=${planStep.id} tool=${toolName} — replan imediato`);
            return {
                outcome: 'blocked',
                confidence: 0.2,
                blocker: {
                    kind: 'repeated_tool_call',
                    toolName,
                    description: `'${toolName}' já falhou neste step — mesma chamada não vai produzir resultado diferente`,
                    suggestedActions: [
                        'Usar tool diferente para atingir o mesmo objetivo',
                        'Reformular os argumentos da tool',
                        'Dividir o step em passos menores',
                    ],
                    detectedAt: Date.now(),
                },
            };
        }

        // Classificar o tipo de falha — exitCode é dado estruturado (ToolResult.exitCode),
        // checado antes de qualquer regex sobre o texto de error/output.
        const blocker = this.classifyError(error, toolName, toolResult.exitCode);

        log.info(`[GoalEvaluator] step=${planStep.id} tool=${toolName} blocker=${blocker.kind}`);

        // Auth requerida → pausa para confirmação
        if (blocker.kind === 'missing_permission') {
            return { outcome: 'needs_auth', confidence: 0.85, blocker };
        }

        // Dependência ausente → perguntar ao usuário / tentar instalar
        if (blocker.kind === 'missing_tool') {
            // missingDependency já foi extraído uma única vez em classifyError() (mesma chamada de
            // extractMissingExecutable() — sem reextrair aqui, sem duplicar a extração).
            const missingCmd = blocker.missingDependency ?? '';
            log.debug(`[GoalEvaluator] missing_tool extracted="${missingCmd || '(not extracted)'}" from error="${error.slice(0, 80)}"`);
            const dep = KNOWN_DEPS[missingCmd.toLowerCase()];
            if (dep) {
                const installKey = `install_dep_${dep.name}`;
                if (goal.strategiesTried.some(s => s.includes(installKey))) {
                    // Já tentamos instalar e a falha persiste → instrução manual
                    const msg = `'${dep.name}' não pôde ser instalado automaticamente.\n${dep.manualInstructions}`;
                    log.warn(`[GoalEvaluator] dep=${dep.name} install already tried — escalating to failed`);
                    return {
                        outcome: 'failed',
                        confidence: 0.1,
                        output: msg,
                        blocker: { ...blocker, description: msg, suggestedActions: [dep.manualInstructions] },
                        depInfo: dep,
                    };
                }

                // RFC-003 Sprint C — Ajuste (teste real, 2026-07-28): KNOWN_DEPS ter uma entrada
                // não significa ter um comando executável PARA ESTA plataforma — a maioria do
                // catálogo (só installCmd legado/Linux, sem installByPlatform) resolve pra
                // undefined em Windows/macOS via resolveInstallCommand(). Confirmado ao vivo:
                // 'ffmpeg' caía direto em needs_dependency mesmo sem comando pra Windows,
                // nunca chegando ao ramo de Pesquisa abaixo — o mesmo vale hoje pra ~24 das 26
                // entradas do catálogo (só marp/puppeteer têm installByPlatform completo).
                // Só segue no caminho normal (needs_dependency) quando: o comando realmente
                // resolve pra esta plataforma, OU o modo não permite aquisição de qualquer forma
                // (SAFE — comportamento idêntico ao anterior a este ajuste, nada muda pra SAFE).
                const resolvedForThisPlatform = resolveInstallCommand(dep, { platform: currentPlatform() });
                if (resolvedForThisPlatform !== undefined || !permissionRegistry.can('install_dependencies')) {
                    log.info(`[GoalEvaluator] dep='${dep.name}' missing and installable — outcome=needs_dependency`);
                    return { outcome: 'needs_dependency', confidence: 0.8, blocker, depInfo: dep };
                }

                // Conhecido em KNOWN_DEPS, mas sem comando resolvido pra esta plataforma, e o
                // modo permite aquisição: trata como conhecimento insuficiente (mesma categoria
                // que dependência totalmente desconhecida) — cai no MESMO ciclo de
                // OperationalKnowledge→Pesquisa logo abaixo, sem duplicar nenhuma lógica.
                log.info(`[GoalEvaluator] dep='${dep.name}' conhecido em KNOWN_DEPS mas sem comando resolvido para plataforma=${currentPlatform()} — tratando como conhecimento insuficiente`);
            }

            // RFC-003 Sprint C — Research: chega aqui em dois casos (ambos "conhecimento
            // Distribuído insuficiente"): sem entrada nenhuma em KNOWN_DEPS, OU com entrada mas
            // sem comando resolvido pra esta plataforma (ajuste de 2026-07-28). Consulta
            // OperationalKnowledge (conhecimento Aprendido) antes de desistir — ordem de
            // "Reutilização" já definida na RFC (1. Distribuído, 2. Aprendido, 3. novo ciclo).
            // getTacticalCommand() só devolve algo acima do limiar de confiança de RFC-001 §2 —
            // abaixo disso seria só evidência textual fraca (buildEvidenceHint, já consumido em
            // GoalPlanner.replan()), nunca um atalho aqui. O objeto sintetizado usa o mesmo campo
            // `installByPlatform` que `marp`/`puppeteer` já usam em KNOWN_DEPS — resolveInstallCommand()
            // e GoalExecutionLoop.handleNeedsDependencyOutcome() consomem sem precisar de nenhuma
            // mudança própria (decisão de design registrada na auditoria de impacto, Sprint A).
            if (missingCmd) {
                const learnedCommand = this.operationalKnowledge?.getTacticalCommand(missingCmd);
                if (learnedCommand) {
                    const platform = currentPlatform();
                    const learnedDep: DependencyInfo = {
                        name: missingCmd,
                        installByPlatform: { [platform]: learnedCommand },
                        manualInstructions: `Conhecimento aprendido nesta instância: ${learnedCommand}`,
                        type: 'system',
                    };
                    const installKey = `install_dep_${learnedDep.name}`;
                    if (goal.strategiesTried.some(s => s.includes(installKey))) {
                        const msg = `'${learnedDep.name}' não pôde ser instalado automaticamente.\n${learnedDep.manualInstructions}`;
                        log.warn(`[GoalEvaluator] dep=${learnedDep.name} (aprendido) install already tried — escalating to failed`);
                        return {
                            outcome: 'failed',
                            confidence: 0.1,
                            output: msg,
                            blocker: { ...blocker, description: msg, suggestedActions: [learnedDep.manualInstructions] },
                            depInfo: learnedDep,
                        };
                    }
                    log.info(`[GoalEvaluator] dep='${learnedDep.name}' resolvido via OperationalKnowledge (aprendido, plataforma=${platform}) — outcome=needs_dependency`);
                    return { outcome: 'needs_dependency', confidence: 0.75, blocker, depInfo: learnedDep };
                }

                // RFC-003 Sprint C — Research (segunda metade): nem KNOWN_DEPS (Distribuído) nem
                // OperationalKnowledge (Aprendido) resolvem — antes desta Sprint, isso caía direto
                // no blocked/failed genérico abaixo, sem NENHUMA sugestão de pesquisa, e o LLM
                // não tinha motivo pra pensar em usar web_search para uma dependência ausente.
                // Gated pelo mesmo permissionRegistry.can('install_dependencies') que já condiciona
                // as duas resoluções automáticas acima (SAFE: comportamento idêntico a antes desta
                // Sprint) e pelo mesmo replanBudget que já gate o 'blocked' genérico logo abaixo —
                // nenhum orçamento paralelo. Esta função NUNCA decide a hipótese nem chama
                // web_search sozinha — só enriquece blocker.description/suggestedActions, o mesmo
                // texto que buildReplanPrompt() (GoalPlanner.ts) já injeta no prompt de replan
                // ("BLOCKER ATUAL"/"AÇÕES SUGERIDAS") — quem decide pesquisar, com o quê, e qual
                // hipótese formar continua sendo exclusivamente o GoalPlanner/LLM, usando
                // web_search/web_navigate (tools já existentes, nenhuma tool nova).
                if (permissionRegistry.can('install_dependencies') && goal.replanBudget > 0) {
                    const researchDescription = `'${missingCmd}' não é conhecido (sem entrada em KNOWN_DEPS nem conhecimento aprendido nesta instância). Pesquise a documentação oficial antes de propor um comando de instalação.`;
                    log.info(`[GoalEvaluator] dep='${missingCmd}' desconhecido (sem KNOWN_DEPS/OperationalKnowledge) — sugerindo pesquisa via web_search/web_navigate (modo permite aquisição)`);
                    return {
                        outcome: 'blocked',
                        confidence: 0.4,
                        blocker: {
                            ...blocker,
                            description: researchDescription,
                            suggestedActions: [
                                `Usar web_search para localizar a fonte oficial de instalação de '${missingCmd}' (site do projeto, repositório GitHub oficial, ou página do gerenciador de pacotes)`,
                                `Usar web_navigate para confirmar o comando exato na fonte encontrada`,
                                `Formular um step de instalação citando a fonte, apropriado ao sistema operacional detectado — nunca inventar um comando sem fonte`,
                            ],
                        },
                    };
                }
            }
        }

        // Erro retryável E ainda tem retry budget → partial (tenta de novo)
        const matchedPattern = this.findMatchedPattern(error);
        if (matchedPattern?.isRetryable && goal.retryBudget > 0) {
            return { outcome: 'partial', confidence: 0.5, blocker };
        }

        // Sem retry budget ou erro irrecuperável → bloqueado, precisa replan
        if (goal.replanBudget > 0) {
            return { outcome: 'blocked', confidence: 0.35, blocker };
        }

        // Sem budget de nenhum tipo → falha definitiva
        return { outcome: 'failed', confidence: 0.1, blocker };
    }

    /**
     * ARCH-010: responde "esta chamada exata (step, tool, args) já falhou antes neste goal?"
     * por consulta nomeada, em vez de lógica de dedup recomputada inline em `evaluate()`.
     * Chave de args via `computeToolInputKey` (mesma função usada pelo dedup de
     * `AgentLoop.usedToolInputs`) em vez de `JSON.stringify` bruto — evita que duas variações
     * cosméticas do mesmo `send_document` (legenda diferente, mesmo `file_path`) escapem do
     * dedup por terem JSON diferente, o mesmo padrão de bug que `computeToolInputKey` já
     * corrigiu na camada de `AgentLoop` (ver S90).
     */
    private hasIdenticalFailedAttempt(goal: Goal, planStep: PlanStep, toolName: string): boolean {
        const currentKey = computeToolInputKey(toolName, planStep.toolArgs ?? {});
        return goal.attempts.some(a =>
            a.planStepId === planStep.id &&
            a.toolName === toolName &&
            a.result === 'failure' &&
            computeToolInputKey(a.toolName, a.args ?? {}) === currentKey
        );
    }

    /** Avalia se o goal ainda tem progresso real entre ciclos */
    evaluateProgress(goal: Goal): 'progressing' | 'stalled' | 'regressing' {
        const attempts = goal.attempts;
        if (attempts.length < 2) return 'progressing';

        const recent = attempts.slice(-3);
        const hasPositive = recent.some(a => a.result === 'success' || a.result === 'partial');

        // Verifica tendência: todos os recentes falharam?
        const allFailed = recent.every(a => a.result === 'failure');

        if (allFailed && recent.length >= 2) return 'stalled';
        if (!hasPositive && attempts.length > 5) return 'regressing';
        return 'progressing';
    }

    private classifyError(error: string, toolName: string, exitCode?: number): GoalBlocker {
        // Sinal ESTRUTURADO tem prioridade sobre qualquer parsing de texto: exit code 127 é
        // convenção POSIX garantida pelo shell (não pela mensagem que o SO produziu) para "comando
        // não encontrado". Quando disponível (ToolResult.exitCode, propagado por exec_command.ts),
        // decide missing_tool sem depender de nenhuma regex — elimina a dependência de mensagens em
        // inglês para o caso mais comum (Linux/macOS via exec_command).
        const posixCommandNotFound = exitCode === 127;

        // extractMissingExecutable() é a MESMA função usada no lookup de KNOWN_DEPS em evaluate() —
        // uma só fonte de verdade para "este erro indica um executável ausente, e qual é o nome?".
        // Ela já exclui internamente ENOENT de arquivo/diretório (FS_ENOENT_PATTERN), então checá-la
        // aqui não rouba o branch 'tool_error' de fs — e cobre qualquer tool que rode um processo,
        // não só exec_command. Quando ela reconhece um binário, essa classificação prevalece sobre
        // ERROR_PATTERNS — elimina a duplicação de regex que causou o gap: mensagem pt-BR do cmd.exe
        // do Windows ("não é reconhecido como um comando interno ou externo") nunca batia no regex
        // inglês de ERROR_PATTERNS, então o blocker nunca virava missing_tool (achado: validação E2E
        // real, 24/07 — docs/DIRETRIZ_ARQUITETURA_2026-07-13.md, Validação Progressiva).
        const missingBinary = extractMissingExecutable(error);

        if (posixCommandNotFound || missingBinary) {
            if (missingBinary) {
                const binaryLabel = `'${missingBinary}'`;
                return {
                    kind: 'missing_tool',
                    toolName,
                    missingDependency: missingBinary,
                    description: `Binário ${binaryLabel} não encontrado no sistema (chamado via '${toolName}'). Instale-o ou use uma abordagem alternativa que não dependa dele.`,
                    suggestedActions: [
                        `Instalar ${missingBinary} via gerenciador de pacotes`,
                        'Verificar capabilities disponíveis com EnvironmentProbe',
                        'Usar ferramenta nativa do NewClaw em vez de binário externo',
                    ],
                    detectedAt: Date.now(),
                };
            }
            // exit code 127 confirma "comando não encontrado" sem nenhum texto, mas o nome do
            // binário não foi extraível (formato de mensagem que extractMissingExecutable() ainda
            // não reconhece). Ainda assim é missing_tool — evaluate() só não vai achar match em
            // KNOWN_DEPS, e o replan segue para o LLM decidir sem atalho determinístico.
            return {
                kind: 'missing_tool',
                toolName,
                description: `Comando não encontrado ao executar '${toolName}' (exit code 127 — binário ausente do PATH).`,
                suggestedActions: [
                    'Instalar a dependência ausente via gerenciador de pacotes',
                    'Verificar capabilities disponíveis com EnvironmentProbe',
                    'Usar ferramenta nativa do NewClaw em vez de binário externo',
                ],
                detectedAt: Date.now(),
            };
        }

        const matched = this.findMatchedPattern(error);

        if (matched) {
            // exec_command: sem exitCode estruturado disponível pra decidir, o padrão genérico de
            // missing_tool em ERROR_PATTERNS bateu (texto solto) mas extractMissingExecutable() não
            // conseguiu extrair um binário — sinal de que o problema real é um PATH de ARGUMENTO
            // inexistente, não o binário do próprio exec_command.
            if (matched.kind === 'missing_tool' && toolName === 'exec_command') {
                return {
                    kind: 'tool_error',
                    toolName,
                    description: `Caminho não encontrado ao executar '${toolName}': ${error.slice(0, 200)}`,
                    suggestedActions: [
                        'Verificar se o caminho existe com list_workspace',
                        'Listar o workspace: list_workspace',
                        'Corrigir o caminho no próximo passo',
                    ],
                    detectedAt: Date.now(),
                };
            }

            const match = error.match(matched.pattern)!;
            const description = matched.description(match, toolName);
            log.debug(`[GoalEvaluator] classify: tool=${toolName} kind=${matched.kind} pattern=/${matched.pattern.source.slice(0, 60)}/ retryable=${matched.isRetryable}`);
            return {
                kind: matched.kind,
                toolName,
                description,
                suggestedActions: matched.suggestedActions,
                detectedAt: Date.now(),
            };
        }

        // Fallback genérico — sem padrão reconhecido
        log.debug(`[GoalEvaluator] classify: tool=${toolName} kind=tool_error (no pattern matched) error="${error.slice(0, 100)}"`);
        return {
            kind: 'tool_error',
            toolName,
            description: `Erro em '${toolName}': ${error.slice(0, 200)}`,
            suggestedActions: [
                'Tentar com argumentos diferentes',
                'Buscar ferramenta alternativa',
                'Verificar logs para mais detalhes',
            ],
            detectedAt: Date.now(),
        };
    }

    private findMatchedPattern(error: string): ErrorPattern | null {
        for (const pattern of ERROR_PATTERNS) {
            if (pattern.pattern.test(error)) return pattern;
        }
        return null;
    }

    /**
     * Gera texto de explicação para o usuário quando goal falha.
     *
     * Usa goal.toolsTried (nomes de ferramenta limpos), NÃO goal.strategiesTried:
     * strategiesTried guarda descrições de step já enriquecidas com hints internos
     * de replanning (ex: "[ATENÇÃO — tentativa anterior com X retornou output
     * irrelevante: ... Use abordagem diferente...]", ver GoalExecutionLoop.ts
     * mismatchHint) — texto escrito para o PRÓPRIO LLM replanejador consumir no
     * próximo ciclo, não para o usuário final. Juntar essas entradas aqui vazava
     * jargão interno (nomes de step truncados, marcadores [ATENÇÃO —) direto na
     * resposta do Telegram.
     */
    buildFailureExplanation(goal: Goal): string {
        const strategies = goal.toolsTried.length > 0
            ? `Tentei: ${goal.toolsTried.join(', ')}.`
            : '';
        const lastBlocker = goal.blockers[goal.blockers.length - 1];
        const blockerMsg = lastBlocker
            ? `Último bloqueio: ${lastBlocker.description}.`
            : '';

        // goal.sentArtifacts registra arquivos REALMENTE entregues ao usuário durante a
        // execução deste goal (trackArtifact, disparado só após send_document/DELIVERY-GUARD
        // confirmarem o envio) — um goal pode entregar arquivos válidos e só DEPOIS esbarrar
        // num step adicional (ex: uma tentativa de sobrescrita bloqueada, ou um replan que
        // expira o reasoning budget) que o derruba para failed. Sem checar isso aqui, o usuário
        // recebe "Não consegui completar" como se nada tivesse sido feito, mesmo tendo acabado
        // de receber os arquivos corretos segundos antes. Reproduzido ao vivo (09/07 19:32):
        // goal entregou 2 .pptx válidos (19:28, 19:29) e ainda assim reportou falha total no
        // rodapé, sem mencionar os arquivos já enviados.
        const sentArtifacts = goal.sentArtifacts ?? [];
        const deliveredMsg = sentArtifacts.length > 0
            ? `Consegui gerar e enviar: ${sentArtifacts.join(', ')}. Porém não finalizei o restante do pedido.`
            : '';

        return [
            deliveredMsg || `Não consegui completar: "${goal.userIntent.slice(0, 150)}"`,
            strategies,
            blockerMsg,
            'Você pode reformular o pedido ou fornecer mais informações para eu tentar de outra forma.',
        ].filter(Boolean).join(' ');
    }
}
