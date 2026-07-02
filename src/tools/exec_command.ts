/**
 * exec_command — Execute shell commands (modelo OpenClaw)
 * 
 * Acesso total ao shell com workspace como cwd padrão.
 * Bloqueia apenas comandos explicitamente destrutivos.
 * Suporta execução remota via ssh://host/command.
 */

import { ToolExecutor, ToolResult } from '../loop/AgentLoop';
import { exec } from 'child_process';
import { resolveHost, isDestructive } from './server_config';
import path from 'path';
import { errorMessage } from '../shared/errors';
import { createLogger } from '../shared/AppLogger';

const log = createLogger('ExecCommandTool');

// Cmdlets do PowerShell seguem a convenção Verbo-Substantivo (Get-ChildItem, Where-Object,
// Remove-Item...). child_process.exec usa cmd.exe como shell padrão no Windows (ComSpec) —
// cmd.exe não reconhece cmdlets do PowerShell, causando "'X' não é reconhecido como um
// comando interno" mesmo quando PowerShell ESTÁ instalado no SO (só não é o shell usado aqui).
const POWERSHELL_CMDLET_PATTERN = /\b[A-Z][a-zA-Z]*-[A-Z][a-zA-Z]+\b/;

export function needsPowerShellWrap(command: string): boolean {
    if (/^\s*(powershell|pwsh)(\.exe)?\b/i.test(command)) return false; // já encaminhado
    return POWERSHELL_CMDLET_PATTERN.test(command);
}

/**
 * Encaminha o comando para powershell.exe via -EncodedCommand (Base64 UTF-16LE).
 * Evita o inferno de escaping de aspas entre cmd.exe (shell externo) e PowerShell
 * (shell alvo) — Base64 não precisa de escaping algum.
 */
export function wrapForWindowsPowerShell(command: string): string {
    const encoded = Buffer.from(command, 'utf16le').toString('base64');
    return `powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`;
}

// ── Marp/pandoc — validação e auto-fix de comandos ──────────────────────────
// Movido de RiskAnalyzer.ts: essas checagens só rodavam quando isComplexPlan() no
// GoalExecutionLoop acionava o Q2 (>=3 steps, ou exec_command+write/send juntos). Um plano
// de 1 step só com "exec_command: marp arquivo.md" (o caso mais comum) pulava o Q2 inteiro e
// as correções nunca eram aplicadas — mesma classe de bug do PowerShell acima. exec_command.ts
// roda incondicionalmente pra toda chamada, então é o único lugar que garante a correção sempre.

/**
 * Detecta comandos marp/pandoc sem arquivo de entrada posicionado ANTES das flags.
 * Causa clássica do erro "waiting data from stdin stream" no marp — o processo FICA PRESO
 * esperando stdin até o timeout (60s) em vez de falhar rápido. Por isso este caso vira erro
 * imediato (fail-fast) em vez de auto-fix: não há como adivinhar qual arquivo o LLM queria.
 * Marp aceita apenas .md como entrada; pandoc aceita múltiplos formatos.
 *
 * Regra: o arquivo de entrada deve ser o primeiro argumento não-flag após o binário.
 * Ex correto:   marp entrada.md --no-stdin -o saida.html
 * Ex errado:    marp --no-stdin -o saida.html          (sem arquivo)
 *               marp --pdf slides.md                   (flag antes do arquivo)
 *               npx @marp-team/marp-cli -o output.html (sem arquivo .md)
 */
export function isMarpWithoutInputFile(command: string): boolean {
    if (!/\bmarp\b/.test(command)) return false;
    const tokens = command.trim().split(/\s+/);
    const marpIdx = tokens.findIndex(t => /^(npx|marp)$/.test(t));
    if (marpIdx < 0) return false;
    const start = tokens[marpIdx] === 'npx' ? marpIdx + 2 : marpIdx + 1;
    let beforeFirstFlag = true;
    for (const t of tokens.slice(start)) {
        if (t.startsWith('-')) { beforeFirstFlag = false; continue; }
        if (beforeFirstFlag && (t.endsWith('.md') || t.endsWith('.marp'))) return false;
    }
    return true; // sem arquivo .md antes de qualquer flag
}

/**
 * Detecta marp com arquivo de entrada mas sem --no-stdin.
 * Sem --no-stdin, marp bloqueia esperando stdin mesmo quando recebe um arquivo .md.
 * Deve ser verificado APÓS isMarpWithoutInputFile (que cobre o caso mais grave).
 */
export function isMarpWithoutNoStdin(command: string): boolean {
    if (!/\bmarp\b/.test(command)) return false;
    return !/--no-stdin/.test(command);
}

/**
 * Injeta --no-stdin APÓS o arquivo .md de entrada.
 * REGRA ABSOLUTA (pptx-generator SKILL.md §Passo 3): o arquivo deve preceder qualquer flag.
 * Correto:  marp entrada.md --no-stdin -o saida.pptx
 * ERRADO:   marp --no-stdin entrada.md -o saida.pptx
 */
export function addMarpNoStdin(command: string): string {
    return command.replace(/(\S+\.(?:md|marp))(\s|$)/, '$1 --no-stdin$2');
}

/** Mesma lógica para pandoc: requer arquivo de entrada antes das flags. */
export function isPandocWithoutInputFile(command: string): boolean {
    if (!/\bpandoc\b/.test(command)) return false;
    const tokens = command.trim().split(/\s+/);
    const pandocIdx = tokens.findIndex(t => /^pandoc$/.test(t));
    if (pandocIdx < 0) return false;
    const start = pandocIdx + 1;
    let beforeFirstFlag = true;
    for (const t of tokens.slice(start)) {
        if (t.startsWith('-')) { beforeFirstFlag = false; continue; }
        if (beforeFirstFlag && /\.(md|docx|tex|html|rst|odt|rtf)$/.test(t)) return false;
    }
    return true;
}

/**
 * Detecta pandoc com a flag --no-stdin (que é exclusiva do marp, não existe no pandoc).
 * O GoalPlanner pode generalizar incorretamente o fix de marp para pandoc.
 */
export function hasPandocInvalidNoStdin(command: string): boolean {
    return /\bpandoc\b/.test(command) && /--no-stdin/.test(command);
}

/** Remove --no-stdin do comando pandoc. */
export function removePandocNoStdin(command: string): string {
    return command.replace(/\s*--no-stdin\b/g, '').replace(/\s{2,}/g, ' ').trim();
}

export class ExecCommandTool implements ToolExecutor {
    name = 'exec_command';
    description = 'Execute shell commands. Workspace como cwd padrão. Suporta ssh://host/command para remoto. Timeout padrão: 30s.';
    parameters = {
        type: 'object',
        properties: {
            command: { type: 'string', description: 'Shell command. Use ssh://HOST/cmd para execução remota' },
            timeout: { type: 'number', description: 'Timeout em ms (padrão: 30000)' },
            workdir: { type: 'string', description: 'Diretório de trabalho (padrão: workspace)' }
        },
        required: ['command']
    };

    async execute(args: Record<string, any>): Promise<ToolResult> {
        let command = args.command as string;
        const timeout = (args.timeout as number) || 60000;
        const workdir = args.workdir as string;

        if (!command) {
            return { success: false, output: '', error: 'Command not provided' };
        }

        // Block destructive commands
        if (isDestructive(command)) {
            return { success: false, output: '', error: 'Comando destrutivo bloqueado por segurança' };
        }

        // Handle SSH remote execution: ssh://host/command
        const isSsh = command.startsWith('ssh://');
        if (isSsh) {
            const match = command.match(/^ssh:\/\/([a-zA-Z0-9_-]+)\/(.*)/);
            if (!match) {
                return { success: false, output: '', error: 'Formato SSH inválido. Use: ssh://host/command' };
            }
            const hostAlias = match[1];
            const remoteCmd = match[2];
            const sshTarget = resolveHost(hostAlias);
            // Aspas simples impedem TODA expansão de shell local ($(), backticks, $VAR).
            // Aspas duplas só escapavam ", mas $() continuava sendo interpretado localmente.
            // Se remoteCmd contém ', usamos o idioma '"'"' para escape dentro de single-quote.
            const escapedCmd = remoteCmd.replace(/'/g, "'\\''");
            command = `ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new ${sshTarget} '${escapedCmd}'`;
        }

        // ── Path Resolution ──
        const workspaceDir = path.resolve(process.env.WORKSPACE_DIR || path.join(process.cwd(), 'workspace'));

        // Se workdir for absoluto, resolve em relação ao root; se relativo, em relação ao workspace
        const effectiveWorkdir = workdir ? path.resolve(workspaceDir, workdir) : workspaceDir;

        // Normaliza paths absolutos de outro servidor para o workspace local.
        // O GoalPlanner pode gerar comandos com paths de outra instalação que falham no ambiente atual.
        // Exemplo: "python /home/<user>/<repo>/workspace/script.py" → "python C:/Users/.../workspace/script.py"
        // Lookahead (?=[\/\s]|$) em vez de exigir "/" literal depois de "workspace": cobre também
        // referências ao próprio diretório sem conteúdo depois (ex: "mkdir /home/user/repo/workspace",
        // "cd /home/user/repo/workspace"). Sem isso, um "mkdir /home/x/y/workspace" passava intocado e,
        // no Windows, criava fisicamente a árvore de pastas home\x\y\workspace dentro do workspace local
        // (path.isAbsolute('/home/...') é true no win32 — resolve como raiz do drive atual, não rejeitado).
        // workspaceDir já vem no separador nativo do SO via path.resolve (barra invertida no
        // Windows, barra normal no POSIX). Testado ao vivo no Windows: builtins do cmd.exe
        // (mkdir/md, type) rejeitam QUALQUER barra normal no argumento — "A sintaxe do comando
        // está incorreta" — inclusive num path MISTO tipo "D:\ws\pasta/arquivo.txt" (só a parte
        // depois de "workspace" ficando com barra normal já é suficiente pra falhar). Por isso o
        // sufixo capturado (o que vem depois de "workspace/", ex: "/sanitize_memory.py") também
        // precisa ter suas barras convertidas — não basta trocar só o prefixo "workspace".
        // (?!\w) depois de "workspace": sem isso, "/home/x/y/workspace2/..." casava só o
        // prefixo "workspace" (o "2" sobra fora do grupo opcional) e virava
        // "<workspaceDir>2/..." — um path errado apontando pra uma pasta "workspace2" que
        // nada tem a ver com o workspace real.
        command = command.replace(
            /\/home\/[^/]+\/[^/]+\/workspace(?!\w)(\/[^\s]*)?/g,
            (_m, suffix?: string) => workspaceDir + (suffix ? suffix.split('/').join(path.sep) : '')
        );

        // Strip "workspace/" apenas quando aparece no INÍCIO do comando (path relativo),
        // nunca no meio de caminhos absolutos (ex: /home/user/newclaw/workspace/jogos).
        // A regex anterior usava \b que fazia match em /…/workspace/ causando truncamento.
        if (!workdir) {
            command = command.replace(/(?:^|\s)workspace\//g, (m) => m.replace('workspace/', ''));
        }

        // marp/pandoc: falha rápido quando não há arquivo de entrada (evita ficar preso
        // esperando stdin até o timeout), e corrige automaticamente a flag --no-stdin
        // (obrigatória no marp, inválida no pandoc — LLM às vezes generaliza errado entre os dois).
        if (isMarpWithoutInputFile(command)) {
            return {
                success: false, output: '',
                error: 'marp invocado sem arquivo .md de entrada antes das flags — isso trava esperando stdin. ' +
                       'Formato correto: marp entrada.md --no-stdin -o saida.html',
            };
        }
        if (isMarpWithoutNoStdin(command)) {
            const original = command;
            command = addMarpNoStdin(command);
            log.info(`[AUTO-FIX] fix=add_marp_no_stdin original="${original.slice(0, 120)}"`);
        }
        if (isPandocWithoutInputFile(command)) {
            return {
                success: false, output: '',
                error: 'pandoc invocado sem arquivo de entrada antes das flags. ' +
                       'Formato correto: pandoc entrada.md -o saida.html',
            };
        }
        if (hasPandocInvalidNoStdin(command)) {
            const original = command;
            command = removePandocNoStdin(command);
            log.info(`[AUTO-FIX] fix=remove_pandoc_no_stdin original="${original.slice(0, 120)}"`);
        }

        const execOptions: { timeout: number; cwd?: string } = { timeout };
        execOptions.cwd = effectiveWorkdir;

        // Comandos de busca retornam exit code 1 quando não há resultados — isso é um
        // resultado válido ("nenhum match"), não um erro. grep, rg, find -quit, etc.
        const isSearchCommand = /^\s*(grep|rg|find)\b/.test(command.replace(/^ssh[^\s]+\s+/, ''));

        // Encaminha cmdlets PowerShell para powershell.exe quando o processo local é Windows.
        // Roda por ÚLTIMO, depois de toda normalização de path acima — o comando final (já com
        // paths corrigidos) é o que vira Base64, não o texto original ainda com paths errados.
        // Não se aplica a ssh:// — o shell remoto não é necessariamente Windows, e o cmdlet
        // ali dentro pertence ao ambiente remoto, não a este processo local.
        // process.platform é sempre conhecido de forma síncrona, sem depender de nenhum probe
        // cacheado — diferente de uma versão anterior deste fix que vivia no RiskAnalyzer e só
        // rodava para planos "complexos" (isComplexPlan(): >=3 steps, ou exec_command+write/send
        // juntos). Um plano de 1 step só com exec_command — o caso mais comum — pulava essa
        // análise inteira e o fix nunca era aplicado.
        if (!isSsh && process.platform === 'win32' && needsPowerShellWrap(command)) {
            const original = command;
            command = wrapForWindowsPowerShell(command);
            log.info(`[AUTO-FIX] fix=wrap_powershell original="${original.slice(0, 120)}"`);
        }

        try {
            const output = await new Promise<string>((resolve, reject) => {
                exec(command, execOptions, (error, stdout, stderr) => {
                    const combined = (stdout ? stdout.toString() : '') + (stderr ? stderr.toString() : '');
                    if (error) {
                        const exitCode = error.code ?? 'unknown';
                        // Exit code 1 em comandos de busca = "nenhum resultado encontrado" (válido).
                        // Apenas exit code 2+ indica erro real no grep/rg/find.
                        if (isSearchCommand && exitCode === 1) {
                            resolve('Nenhum resultado encontrado.');
                            return;
                        }
                        // Non-zero exit is a failure — reject so the caller sees success: false.
                        // Preserve stdout/stderr in combinedOutput so GoalEvaluator can classify it.
                        const fullOutput = (combined.trim() || error.message) + `\n[exit code: ${exitCode}]`;
                        reject(Object.assign(error, { combinedOutput: fullOutput.trim() }));
                    } else {
                        resolve(combined);
                    }
                });
            });

            return { success: true, output: output.trim().slice(0, 16000) };
        } catch (err) {
            const e = err as NodeJS.ErrnoException & { combinedOutput?: string };
            const msg = (e.combinedOutput || errorMessage(err)).slice(0, 16000);
            return { success: false, output: msg, error: msg };
        }
    }
}