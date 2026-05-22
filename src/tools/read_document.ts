/**
 * read_document — Extrai texto de documentos (PDF, DOCX, ODT, etc.)
 *
 * Fallback chain:
 *   1. pdftotext (poppler-utils) — melhor para PDFs digitais
 *   2. python3 + pdfminer.six    — fallback para PDFs complexos
 *   3. tesseract (OCR)           — fallback para PDFs digitalizados/imagens
 *   4. strings + grep            — último recurso para extrair texto bruto
 */

import { ToolExecutor, ToolResult } from '../loop/AgentLoop';
import { exec } from 'child_process';
import path from 'path';
import fs from 'fs';
import { promisify } from 'util';
import { errorMessage } from '../shared/errors';
import { createLogger } from '../shared/AppLogger';

const execAsync = promisify(exec);
const log = createLogger('ReadDocumentTool');

const WORKSPACE = process.env.WORKSPACE_DIR || './workspace';
const TIMEOUT_MS = 60_000;

export class ReadDocumentTool implements ToolExecutor {
    name = 'read_document';
    description = 'Extrai e retorna o conteúdo textual de um documento (PDF, DOCX, ODT, TXT, etc.) salvo no workspace. Use quando o usuário enviar um arquivo e você precisar ler seu conteúdo. Tenta pdftotext → pdfminer → tesseract (OCR) automaticamente.';
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
            }
        },
        required: ['filename']
    };

    async execute(args: Record<string, any>): Promise<ToolResult> {
        const rawFilename = (args.filename as string || '').trim();
        if (!rawFilename) {
            return { success: false, output: '', error: 'filename é obrigatório.' };
        }

        // Resolve path: absolute or relative to workspace
        const filePath = path.isAbsolute(rawFilename)
            ? rawFilename
            : path.join(WORKSPACE, rawFilename);

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
            return this.extractText(found, args.pages as string | undefined);
        }

        return this.extractText(filePath, args.pages as string | undefined);
    }

    private findInWorkspace(name: string): string | null {
        try {
            const files = fs.readdirSync(WORKSPACE);
            const match = files.find(f => f.toLowerCase() === name.toLowerCase());
            return match ? path.join(WORKSPACE, match) : null;
        } catch { return null; }
    }

    private async extractText(filePath: string, pages?: string): Promise<ToolResult> {
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
            return this.extractOcr(filePath);
        }

        // Fallback: try strings
        return this.extractStrings(filePath);
    }

    private async extractPdf(filePath: string, pages?: string): Promise<ToolResult> {
        const pageArg = pages ? `-f ${pages.split('-')[0]} -l ${pages.split('-')[1] || pages.split('-')[0]}` : '';

        // 1. pdftotext (best for digital PDFs)
        try {
            const { stdout, stderr } = await execAsync(
                `pdftotext ${pageArg} "${filePath}" -`,
                { timeout: TIMEOUT_MS }
            );
            const text = stdout.trim();
            if (text.length > 50) {
                log.info(`read_document: pdftotext OK (${text.length} chars)`);
                return { success: true, output: this.formatOutput(text, filePath, 'pdftotext') };
            }
            if (stderr && !stderr.includes('pdftotext: command not found')) {
                log.warn(`read_document: pdftotext produced short output (${text.length} chars), trying fallback`);
            }
        } catch (e) {
            log.info(`read_document: pdftotext not available or failed: ${errorMessage(e)}`);
        }

        // 2. python3 + pdfminer
        try {
            const script = `from pdfminer.high_level import extract_text; print(extract_text('${filePath.replace(/'/g, "\\'")}'))`;
            const { stdout } = await execAsync(
                `python3 -c "${script}"`,
                { timeout: TIMEOUT_MS }
            );
            const text = stdout.trim();
            if (text.length > 50) {
                log.info(`read_document: pdfminer OK (${text.length} chars)`);
                return { success: true, output: this.formatOutput(text, filePath, 'pdfminer') };
            }
        } catch (e) {
            log.info(`read_document: pdfminer not available: ${errorMessage(e)}`);
        }

        // 3. tesseract OCR (for scanned PDFs)
        const ocrResult = await this.pdfOcr(filePath);
        if (ocrResult.success) return ocrResult;

        // 4. strings (raw binary text extraction as last resort)
        return this.extractStrings(filePath);
    }

    private async pdfOcr(filePath: string): Promise<ToolResult> {
        try {
            // Convert PDF pages to PNG then OCR with tesseract
            const tmpBase = `/tmp/newclaw_ocr_${Date.now()}`;
            await execAsync(`pdftoppm -png -r 150 "${filePath}" "${tmpBase}"`, { timeout: 30_000 });
            const pngs = fs.readdirSync('/tmp').filter(f => f.startsWith(path.basename(tmpBase)));
            if (pngs.length === 0) return { success: false, output: '', error: 'pdftoppm não produziu imagens' };

            const texts: string[] = [];
            for (const png of pngs.slice(0, 10)) {
                try {
                    const { stdout } = await execAsync(
                        `tesseract /tmp/${png} stdout -l por+eng`,
                        { timeout: 30_000 }
                    );
                    texts.push(stdout.trim());
                } catch { /* skip page */ }
            }
            // Cleanup
            pngs.forEach(f => { try { fs.unlinkSync(`/tmp/${f}`); } catch { /* ignore */ } });

            const combined = texts.join('\n\n').trim();
            if (combined.length > 50) {
                log.info(`read_document: OCR OK (${combined.length} chars from ${pngs.length} pages)`);
                return { success: true, output: this.formatOutput(combined, filePath, 'tesseract-ocr') };
            }
        } catch (e) {
            log.info(`read_document: OCR failed: ${errorMessage(e)}`);
        }
        return { success: false, output: '', error: 'OCR não disponível ou falhou' };
    }

    private async extractOffice(filePath: string): Promise<ToolResult> {
        // Try pandoc first
        try {
            const { stdout } = await execAsync(`pandoc "${filePath}" -t plain`, { timeout: TIMEOUT_MS });
            const text = stdout.trim();
            if (text.length > 50) {
                return { success: true, output: this.formatOutput(text, filePath, 'pandoc') };
            }
        } catch { /* fallthrough */ }

        // Try LibreOffice headless text export
        try {
            const outDir = '/tmp';
            await execAsync(`libreoffice --headless --convert-to txt "${filePath}" --outdir "${outDir}"`, { timeout: TIMEOUT_MS });
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
                { timeout: TIMEOUT_MS }
            );
            const text = stdout.trim();
            if (text.length > 10) {
                return { success: true, output: this.formatOutput(text, filePath, 'tesseract-ocr') };
            }
        } catch (e) {
            log.info(`read_document: tesseract failed: ${errorMessage(e)}`);
        }
        return { success: false, output: '', error: 'Tesseract não disponível. Instale com: apt-get install tesseract-ocr tesseract-ocr-por' };
    }

    private async extractStrings(filePath: string): Promise<ToolResult> {
        try {
            const { stdout } = await execAsync(
                `strings "${filePath}" | grep -E '.{20,}' | head -200`,
                { timeout: 15_000 }
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
            error: `Não foi possível extrair texto de "${path.basename(filePath)}". ` +
                'Instale as ferramentas necessárias:\n' +
                '  • PDF: apt-get install poppler-utils\n' +
                '  • OCR: apt-get install tesseract-ocr tesseract-ocr-por\n' +
                '  • DOCX: apt-get install pandoc'
        };
    }

    private formatOutput(text: string, filePath: string, method: string): string {
        const name = path.basename(filePath);
        const preview = text.length > 40_000 ? text.slice(0, 40_000) + '\n\n[... conteúdo truncado para 40.000 caracteres]' : text;
        return `📄 ${name} (extraído via ${method}):\n\n${preview}`;
    }
}
