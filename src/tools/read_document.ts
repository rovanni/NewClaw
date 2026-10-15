/**
 * read_document — Extrai texto de documentos (PDF, DOCX, ODT, etc.)
 *
 * Fallback chain:
 *   1. pdftotext (poppler-utils) — melhor para PDFs digitais
 *   2. Python 3 + pdfminer.six   — fallback para PDFs complexos (o Python que funciona: py -3, python ou python3)
 *   3. tesseract (OCR)           — fallback para PDFs digitalizados/imagens
 *   4. strings + grep            — último recurso para extrair texto bruto
 */

import { ToolExecutor, ToolResult } from '../loop/agentLoopTypes';
import { exec, execFile } from 'child_process';
import path from 'path';
import fs from 'fs';
import { promisify } from 'util';
import { errorMessage } from '../shared/errors';
import { createLogger } from '../shared/AppLogger';
import { processVision } from '../core/agentMediaHandlers';
import { resolvePython3Runtime, defaultPython3Candidates } from '../utils/crossPlatform';
import type { ProviderFactory } from '../core/ProviderFactory';
import type { ModelProfileRegistry } from '../loop/ModelProfileRegistry';

const execAsync = promisify(exec);
// execFile não passa pelo shell — elimina risco de injeção de comandos via args
const execFileAsync = promisify(execFile);

/**
 * O erro REAL de uma tentativa (primeira linha do stderr, senão da mensagem), para a falha final relatar fatos — o que foi tentado
 * e o que cada tentativa respondeu. Antes a falha dava uma receita fixa (apt-get), errada no Windows (15/10/2026); quem decide como
 * instalar é o agente, que recebe o ambiente medido (shared/ambienteDeExecucao).
 */
function motivoDaFalha(e: unknown): string {
    const err = e as { stderr?: unknown; message?: unknown };
    const linhas = [String(err?.stderr ?? ''), String(err?.message ?? e ?? '')].join('\n').split(/\r?\n/).map(l => l.trim())
        .filter(l => l && !/^Command failed:/i.test(l));
    return (linhas[0] ?? 'falhou sem mensagem').slice(0, 160);
}
const log = createLogger('ReadDocumentTool');

const WORKSPACE = process.env.WORKSPACE_DIR || './workspace';
const TIMEOUT_MS = 60_000;

export class ReadDocumentTool implements ToolExecutor {
    name = 'read_document';
    description = 'Extrai e retorna o conteúdo textual de um documento (PDF, DOCX, ODT, TXT, etc.) salvo no workspace. Use quando o usuário enviar um arquivo e você precisar ler seu conteúdo. Tenta pdftotext → pdfminer → tesseract (OCR) automaticamente. Para imagens (.png/.jpg/etc), forneça "prompt" para pedir uma análise/crítica do modelo de visão em vez de OCR simples — útil para revisar visualmente um screenshot que você mesmo gerou.';
    parameters = {
        type: 'object',
        properties: {
            filename: {
                type: 'string',
                description: 'Nome do arquivo no workspace (ex: documento.pdf). Pode ser o caminho completo ou apenas o nome.'
            },
            pages: {
                type: 'string',
                description: 'Intervalo de páginas para extrair (ex: "1-5"). Opcional — padrão: todas as páginas.'
            },
            prompt: {
                type: 'string',
                description: 'Somente para imagens: instrução customizada para o modelo de visão (ex: "critique a qualidade visual e o layout desta página"). Opcional — sem isso, imagens passam por OCR simples.'
            }
        },
        required: ['filename']
    };

    constructor(
        private providerFactory?: ProviderFactory,
        private profileRegistry?: ModelProfileRegistry
    ) {}

    async execute(args: Record<string, any>): Promise<ToolResult> {
        const rawFilename = (args.filename as string || '').trim();
        if (!rawFilename) {
            return { success: false, output: '', error: 'filename é obrigatório.' };
        }
        const prompt = (args.prompt as string || '').trim() || undefined;

        // Resolve path: absolute or relative to workspace
        const filePath = path.isAbsolute(rawFilename)
            ? rawFilename
            : path.join(WORKSPACE, rawFilename);
        log.info(`[ARTIFACT-PATH] tool=read_document requested="${rawFilename}" resolved="${filePath}" workspace_dir="${WORKSPACE}" canonical=${filePath.startsWith(WORKSPACE)} exists=${fs.existsSync(filePath)}`);

        if (!fs.existsSync(filePath)) {
            // Try to find in workspace by name only
            const basename = path.basename(rawFilename);
            const found = this.findInWorkspace(basename);
            if (!found) {
                return {
                    success: false, output: '',
                    error: `Arquivo "${rawFilename}" não encontrado no workspace (${WORKSPACE}). Verifique se o arquivo foi enviado corretamente.`
                };
            }
            return this.extractText(found, args.pages as string | undefined, prompt);
        }

        return this.extractText(filePath, args.pages as string | undefined, prompt);
    }

    private findInWorkspace(name: string): string | null {
        try {
            const files = fs.readdirSync(WORKSPACE);
            const match = files.find(f => f.toLowerCase() === name.toLowerCase());
            return match ? path.join(WORKSPACE, match) : null;
        } catch { return null; }
    }

    private async extractText(filePath: string, pages?: string, prompt?: string): Promise<ToolResult> {
        const ext = path.extname(filePath).toLowerCase();
        log.info(`read_document: extracting "${filePath}" (${ext})`);

        // Plain text files — read directly
        if (['.txt', '.md', '.csv', '.json', '.xml', '.html', '.htm', '.log'].includes(ext)) {
            try {
                const content = fs.readFileSync(filePath, 'utf-8');
                return { success: true, output: content.slice(0, 50_000) };
            } catch (e) {
                return { success: false, output: '', error: `Erro ao ler arquivo: ${errorMessage(e)}` };
            }
        }

        if (ext === '.pdf') {
            return this.extractPdf(filePath, pages);
        }

        if (['.docx', '.odt', '.rtf'].includes(ext)) {
            return this.extractOffice(filePath);
        }

        if (['.png', '.jpg', '.jpeg', '.tiff', '.bmp', '.gif'].includes(ext)) {
            // Prompt explícito (ex: crítica visual de um screenshot) → modelo de visão.
            // Sem prompt → comportamento original (OCR), não muda para nenhum caller existente.
            if (prompt) {
                return this.extractVision(filePath, prompt);
            }
            return this.extractOcr(filePath);
        }

        // Fallback: try strings
        return this.extractStrings(filePath);
    }

    private async extractVision(filePath: string, prompt: string): Promise<ToolResult> {
        const visionProfile = this.profileRegistry?.getProfileByCategory('vision') ?? null;
        if (visionProfile && this.providerFactory) {
            try {
                const buffer = fs.readFileSync(filePath);
                const description = await processVision(buffer, path.basename(filePath), visionProfile, this.providerFactory, prompt);
                if (!description.startsWith('(Visão não configurada)') && !description.startsWith('Erro ao processar visão:')) {
                    return { success: true, output: this.formatOutput(description, filePath, `vision:${visionProfile.model}`) };
                }
                log.warn(`read_document: vision falhou ("${description}"), caindo para OCR`);
            } catch (e) {
                log.warn(`read_document: vision falhou (${errorMessage(e)}), caindo para OCR`);
            }
        }
        return this.extractOcr(filePath);
    }

    private async extractPdf(filePath: string, pages?: string): Promise<ToolResult> {
        // Valida formato de páginas antes de injetar no comando shell (ex: "1-5" ou "3")
        const safePages = pages && /^\d+(-\d+)?$/.test(pages.trim()) ? pages.trim() : null;
        const pageArg = safePages
            ? `-f ${safePages.split('-')[0]} -l ${safePages.split('-')[1] || safePages.split('-')[0]}`
            : '';

        const tentativas: string[] = [];

        // 1. pdftotext (best for digital PDFs)
        try {
            const { stdout, stderr } = await execAsync(
                `pdftotext ${pageArg} "${filePath}" -`,
                { timeout: TIMEOUT_MS, windowsHide: true }
            );
            const text = stdout.trim();
            if (text.length > 50) {
                log.info(`read_document: pdftotext OK (${text.length} chars)`);
                return { success: true, output: this.formatOutput(text, filePath, 'pdftotext') };
            }
            tentativas.push(`pdftotext — saída curta (${text.length} caracteres)`);
            if (stderr && !stderr.includes('pdftotext: command not found')) {
                log.warn(`read_document: pdftotext produced short output (${text.length} chars), trying fallback`);
            }
        } catch (e) {
            tentativas.push(`pdftotext — ${motivoDaFalha(e)}`);
            log.info(`read_document: pdftotext not available or failed: ${errorMessage(e)}`);
        }

        // 2. Python 3 + pdfminer
        let pythonUsado = '';
        // O filepath é passado como sys.argv[1] — nunca interpolado no código Python,
        // eliminando risco de injeção de comandos via nome de arquivo malicioso.
        try {
            const script = [
                'import sys',
                'from pdfminer.high_level import extract_text',
                'print(extract_text(sys.argv[1]))',
            ].join('; ');
            // O Python 3 que FUNCIONA nesta máquina (testado por execução): no Windows, "python3" costuma ser o atalho da
            // Microsoft Store, que não roda Python — o pdfminer instalado no `py -3` nunca era alcançado (15/10/2026).
            const candidatos = defaultPython3Candidates();
            const py = await resolvePython3Runtime(candidatos);
            if (!py) throw new Error(`nenhum Python 3 executável entre: ${candidatos.map(c => [c.command, ...c.argsPrefix].join(' ')).join(', ')}`);
            pythonUsado = [py.command, ...py.argsPrefix].join(' ');
            const { stdout } = await execFileAsync(py.command, [...py.argsPrefix, '-c', script, filePath], { timeout: TIMEOUT_MS, windowsHide: true });
            const text = stdout.trim();
            if (text.length > 50) {
                log.info(`read_document: pdfminer OK (${text.length} chars)`);
                return { success: true, output: this.formatOutput(text, filePath, 'pdfminer') };
            }
            tentativas.push(`Python 3 (${pythonUsado}) + pdfminer — saída curta (${text.length} caracteres)`);
        } catch (e) {
            tentativas.push(`Python 3${pythonUsado ? ` (${pythonUsado})` : ''} + pdfminer — ${motivoDaFalha(e)}`);
            log.info(`read_document: pdfminer not available: ${errorMessage(e)}`);
        }

        // 3. tesseract OCR (for scanned PDFs)
        const ocrResult = await this.pdfOcr(filePath);
        if (ocrResult.success) return ocrResult;
        tentativas.push(`OCR (pdftoppm + tesseract) — ${ocrResult.error ?? 'falhou'}`);

        // 4. strings (raw binary text extraction as last resort)
        return this.extractStrings(filePath, tentativas);
    }

    private async pdfOcr(filePath: string): Promise<ToolResult> {
        try {
            // Convert PDF pages to PNG then OCR with tesseract
            const osTmp  = require('os').tmpdir() as string;
            const tmpBase = path.join(osTmp, `newclaw_ocr_${Date.now()}`);
            await execAsync(`pdftoppm -png -r 150 "${filePath}" "${tmpBase}"`, { timeout: 30_000, windowsHide: true });
            const pngs = fs.readdirSync(osTmp).filter(f => f.startsWith(path.basename(tmpBase)));
            if (pngs.length === 0) return { success: false, output: '', error: 'pdftoppm não produziu imagens' };

            const texts: string[] = [];
            for (const png of pngs.slice(0, 10)) {
                try {
                    // execFile passa o path como argumento direto ao processo —
                    // nomes de arquivo com caracteres especiais não chegam ao shell.
                    const { stdout } = await execFileAsync(
                        'tesseract',
                        [path.join(osTmp, png), 'stdout', '-l', 'por+eng'],
                        { timeout: 30_000, windowsHide: true },
                    );
                    texts.push(stdout.trim());
                } catch { /* skip page */ }
            }
            // Cleanup
            pngs.forEach(f => { try { fs.unlinkSync(path.join(osTmp, f)); } catch { /* ignore */ } });

            const combined = texts.join('\n\n').trim();
            if (combined.length > 50) {
                log.info(`read_document: OCR OK (${combined.length} chars from ${pngs.length} pages)`);
                return { success: true, output: this.formatOutput(combined, filePath, 'tesseract-ocr') };
            }
        } catch (e) {
            log.info(`read_document: OCR failed: ${errorMessage(e)}`);
            return { success: false, output: '', error: motivoDaFalha(e) };
        }
        return { success: false, output: '', error: 'OCR não extraiu texto' };
    }

    private async extractOffice(filePath: string): Promise<ToolResult> {
        // Try pandoc first
        try {
            const { stdout } = await execAsync(`pandoc "${filePath}" -t plain`, { timeout: TIMEOUT_MS, windowsHide: true });
            const text = stdout.trim();
            if (text.length > 50) {
                return { success: true, output: this.formatOutput(text, filePath, 'pandoc') };
            }
        } catch { /* fallthrough */ }

        // Try LibreOffice headless text export
        try {
            const outDir = require('os').tmpdir() as string;
            await execAsync(`libreoffice --headless --convert-to txt "${filePath}" --outdir "${outDir}"`, { timeout: TIMEOUT_MS, windowsHide: true });
            const txtPath = path.join(outDir, path.basename(filePath, path.extname(filePath)) + '.txt');
            if (fs.existsSync(txtPath)) {
                const text = fs.readFileSync(txtPath, 'utf-8').trim();
                fs.unlinkSync(txtPath);
                if (text.length > 50) return { success: true, output: this.formatOutput(text, filePath, 'libreoffice') };
            }
        } catch { /* fallthrough */ }

        return this.extractStrings(filePath);
    }

    private async extractOcr(filePath: string): Promise<ToolResult> {
        try {
            const { stdout } = await execAsync(
                `tesseract "${filePath}" stdout -l por+eng`,
                { timeout: TIMEOUT_MS, windowsHide: true }
            );
            const text = stdout.trim();
            if (text.length > 10) {
                return { success: true, output: this.formatOutput(text, filePath, 'tesseract-ocr') };
            }
        } catch (e) {
            log.info(`read_document: tesseract failed: ${errorMessage(e)}`);
        }
        return { success: false, output: '', error: 'Tesseract não disponível ou não extraiu texto (ver o log para o erro).' };
    }

    private async extractStrings(filePath: string, tentativas: string[] = []): Promise<ToolResult> {
        try {
            const { stdout } = await execAsync(
                `strings "${filePath}" | grep -E '.{20,}' | head -200`,
                { timeout: 15_000, windowsHide: true }
            );
            const text = stdout.trim();
            if (text.length > 50) {
                return {
                    success: true,
                    output: this.formatOutput(text, filePath, 'strings (extração parcial)') +
                        '\n\n⚠️ Extração via strings — instale pdftotext (poppler-utils) para melhor qualidade.'
                };
            }
        } catch { /* ignore */ }

        return {
            success: false, output: '',
            error: `Não foi possível extrair texto de "${path.basename(filePath)}".` +
                (tentativas.length ? ` Tentativas: ${tentativas.join('; ')}.` : ''),
        };
    }

    private formatOutput(text: string, filePath: string, method: string): string {
        const name = path.basename(filePath);
        const preview = text.length > 40_000 ? text.slice(0, 40_000) + '\n\n[... conteúdo truncado para 40.000 caracteres]' : text;
        return `📄 ${name} (extraído via ${method}):\n\n${preview}`;
    }
}
