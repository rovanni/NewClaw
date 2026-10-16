/**
 * Os formatos que a ferramenta read_document extrai de verdade — fonte única: o dispatch de read_document e as dicas da ferramenta
 * read e do AgentLoop leem daqui. Módulo-folha (sem dependências), para read_tool e AgentLoop não importarem read_document.
 */
import path from 'path';

export const FORMATOS_DO_READ_DOCUMENT = {
    pdf: ['.pdf'],
    escritorio: ['.docx', '.odt', '.rtf'],
    imagem: ['.png', '.jpg', '.jpeg', '.tiff', '.bmp', '.gif'],
};

/**
 * Regra 11 do AGENTS.md: quando um arquivo binário não pode ser lido como texto, a dica aponta a ferramenta do PRÓPRIO NewClaw que o
 * lê — nunca um programa externo que pode não existir. Antes: "use exec_command com pdftotext ou pandoc"; num Windows sem pdftotext
 * o agente não leu o PDF e o juiz repetiu a dica errada (15/10/2026). '' quando nenhuma ferramenta do NewClaw lê o formato.
 */
export function ferramentaQueLe(nomeDoArquivo: string): string {
    const ext = path.extname(nomeDoArquivo).toLowerCase();
    const f = FORMATOS_DO_READ_DOCUMENT;
    return [...f.pdf, ...f.escritorio, ...f.imagem].includes(ext) ? 'read_document' : '';
}
