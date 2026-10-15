/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S410
 * read_document lê PDF com o Python 3 que FUNCIONA nesta máquina (py -3, python ou python3) e, quando falha, ensina a instalar
 * os leitores com os comandos DESTE sistema.
 *
 * ORIGEM (Windows, 15/10/2026, dois testes reais): o Plano de Ensino e o Calendário Acadêmico (PDFs com texto) não eram lidos.
 * O fallback do pdfminer chamava `python3` fixo — no Windows, o atalho da Microsoft Store, que não roda Python — embora o
 * pdfminer estivesse instalado no `py -3`. A mensagem de erro ainda mandava instalar com apt-get. Sem o plano de ensino, o goal
 * da aula adotou "Aula 1" por padrão; no do calendário, o agente deu voltas tentando instalar o que já existia.
 *
 * REGRESSÃO SE: read_document voltar a chamar um Python fixo; ou a dica de instalação voltar a ser a de outro sistema.
 *
 * Execução: npx ts-node src/__tests__/regression/S410_LeituraDePdf_PythonCerto.test.ts
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ReadDocumentTool } from '../../tools/read_document';
import { resolvePython3Runtime, defaultPython3Candidates, runPython3Import } from '../../utils/crossPlatform';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

/** PDF mínimo e válido, com uma linha de texto — para exercitar a extração real sem depender de arquivo de fora. */
function pdfMinimo(texto: string): Buffer {
    const conteudo = `BT /F1 12 Tf 72 720 Td (${texto}) Tj ET`;
    const objetos = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
        `<< /Length ${conteudo.length} >>\nstream\n${conteudo}\nendstream`,
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ];
    let pdf = '%PDF-1.4\n';
    const offsets: number[] = [];
    objetos.forEach((o, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
    const xref = pdf.length;
    pdf += `xref\n0 ${objetos.length + 1}\n0000000000 65535 f \n` + offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
    pdf += `trailer\n<< /Size ${objetos.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(pdf, 'latin1');
}

async function main(): Promise<void> {
    console.log('\n=== S410-1 — o Python da extração é o que funciona, não um nome fixo ===');
    {
        const src = fs.readFileSync(path.join(__dirname, '../../tools/read_document.ts'), 'utf-8');
        assert(!/execFileAsync\(\s*'python3?'/.test(src), 'nenhuma chamada a um Python de nome fixo (antes: execFileAsync(\'python3\', …))');
        assert(/const candidatos = defaultPython3Candidates\(\)/.test(src) && /resolvePython3Runtime\(candidatos\)/.test(src), 'usa o resolvedor do projeto (py -3 → python → python3 no Windows, testados por execução)');
    }

    console.log('\n=== S410-2 — a falha relata o que foi tentado e o erro real de cada tentativa (sem receita de instalação) ===');
    {
        const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'newclaw-s410b-'));
        try {
            const falso = path.join(pasta, 'nao e pdf.pdf');
            fs.writeFileSync(falso, 'isto nao e um pdf');
            const r = await new ReadDocumentTool().execute({ filename: falso });
            const e = String(r.error ?? '');
            assert(r.success === false && /Tentativas: /.test(e) && /pdftotext — /.test(e) && /pdfminer — /.test(e) && /OCR \(pdftoppm \+ tesseract\) — /.test(e),
                'lista cada tentativa com o que ela respondeu', e);
            assert(!/apt-get|brew install|pip install|Instale/.test(e), 'nenhuma receita de instalação escrita no código — quem decide é o agente, com o ambiente medido', e);
        } finally {
            fs.rmSync(pasta, { recursive: true, force: true });
        }
    }

    console.log('\n=== S410-3 — extração real de um PDF com texto ===');
    {
        const py = await resolvePython3Runtime(defaultPython3Candidates());
        const temPdfminer = !!py && await runPython3Import(py, 'pdfminer');
        if (!temPdfminer) {
            console.log('  ⏭️ sem Python 3 com pdfminer nesta máquina — a extração real fica para onde ele existe (declarado, não falha)');
        } else {
            const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'newclaw-s410-'));
            try {
                const arquivo = path.join(pasta, 'Calendario Academico 2026.pdf');   // com espaços, como os arquivos reais
                fs.writeFileSync(arquivo, pdfMinimo('Feriado de teste S410: 12 de outubro, Nossa Senhora Aparecida'));
                const r = await new ReadDocumentTool().execute({ filename: arquivo });
                assert(r.success === true && /Feriado de teste S410/.test(r.output) && /12 de outubro/.test(r.output), `o texto do PDF é extraído (Python resolvido: ${py!.command} ${py!.argsPrefix.join(' ')})`, r.error ?? r.output.slice(0, 200));
            } finally {
                fs.rmSync(pasta, { recursive: true, force: true });
            }
        }
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S410 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    process.exit(failed > 0 ? 1 : 0);
}
main().catch(err => { console.error('S410 erro inesperado:', err); process.exit(1); });
