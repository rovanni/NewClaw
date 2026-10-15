/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S405
 * "placeholder" dentro de CÓDIGO é vocabulário do formato, não conteúdo-molde: a última defesa do `write` não bloqueia mais
 * scripts python-pptx, páginas HTML com campos de formulário ou geradores pptxgenjs — e continua pegando a marca de conteúdo
 * faltando onde ela é marca.
 *
 * ORIGEM (Telegram, 15/10/2026, aula de sistemas de armazenamento): o agente escreveu `gerar_aula.py` (python-pptx,
 * 4.782 chars); o classificador de molde (LLM) julgou "conteúdo real, completo e livre de placeholders"; 27 s depois o
 * CONTENT-STUB-GATE do write bloqueou o mesmo arquivo pelo padrão literal /placeholder/ — que casa `slide.placeholders`,
 * a API normal da biblioteca. O goal replanejou do zero e terminou abandonado após 34 minutos.
 *
 * REGRESSÃO SE: código legítimo com "placeholder" voltar a ser bloqueado; ou a marca de molde ("PLACEHOLDER", "texto
 * placeholder", "[TODO: …]") deixar de ser bloqueada em texto e, em maiúsculas soltas, em código.
 *
 * Execução: npx ts-node src/__tests__/regression/S405_ConteudoMolde_PlaceholderEmCodigo.test.ts
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'newclaw-s405-'));
process.env.WORKSPACE_DIR = pasta;   // antes de carregar o write: nunca grava no workspace real

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { WriteTool } = require('../../tools/write_tool') as typeof import('../../tools/write_tool');

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

const PYTHON_PPTX = [
    'from pptx import Presentation',
    'from pptx.enum.shapes import MSO_SHAPE_TYPE, PP_PLACEHOLDER',
    '',
    'prs = Presentation()',
    'slide = prs.slides.add_slide(prs.slide_layouts[1])',
    'slide.shapes.title.text = "Sistemas de armazenamento secundário"',
    'corpo = slide.placeholders[1]',
    'corpo.text = "HD (CMR e SMR), SSD SATA e SSD NVMe"',
    'for placeholder in slide.placeholders:',
    '    print(placeholder.placeholder_format.idx, placeholder.placeholder_format.type == PP_PLACEHOLDER.BODY)',
    'for shape in slide.shapes:',
    '    if shape.shape_type == MSO_SHAPE_TYPE.PLACEHOLDER:',
    '        print(shape.name)',
    'prs.save("aula_sistemas_armazenamento.pptx")',
].join('\n');

const HTML_COM_FORMULARIO = '<!doctype html><html><head><style>input::placeholder { color: #888; }</style></head>' +
    '<body><h1>Inscrição na aula</h1><input type="text" placeholder="Seu nome completo"></body></html>';

const PPTXGENJS = "const pptxgen = require('pptxgenjs');\nconst pptx = new pptxgen();\n" +
    "pptx.defineSlideMaster({ title: 'AULA', objects: [{ placeholder: { options: { name: 'body', type: 'body' }, text: '' } }] });\n" +
    "const s = pptx.addSlide({ masterName: 'AULA' });\ns.addText('HD x SSD x NVMe', { placeholder: 'body' });\npptx.writeFile({ fileName: 'aula.pptx' });\n";

async function gravar(nome: string, conteudo: string) {
    return new WriteTool().execute({ path: nome, content: conteudo });
}

async function main(): Promise<void> {
    try {
        console.log('\n=== S405-1 — código legítimo com "placeholder" é gravado ===');
        for (const [nome, conteudo, oQue] of [
            ['gerar_aula.py', PYTHON_PPTX, 'script python-pptx (slide.placeholders, placeholder_format, MSO_SHAPE_TYPE.PLACEHOLDER)'],
            ['inscricao.html', HTML_COM_FORMULARIO, 'HTML com placeholder="…" e ::placeholder'],
            ['gerar_aula.js', PPTXGENJS, "pptxgenjs com { placeholder: 'body' }"],
        ] as const) {
            const r = await gravar(nome, conteudo);
            assert(r.success === true && fs.existsSync(path.join(pasta, nome)), `${oQue} → gravado`, r.error);
        }

        console.log('\n=== S405-2 — a marca de conteúdo faltando continua bloqueada ===');
        for (const [nome, conteudo, oQue] of [
            ['aula.md', '# Aula\n\nPLACEHOLDER', 'texto: "PLACEHOLDER"'],
            ['notas.txt', 'Aqui vai um texto placeholder sobre HDs.', 'texto: "texto placeholder"'],
            ['resumo.txt', 'PLACEHOLDER_GERADO_EM_RUNTIME', 'texto: identificador PLACEHOLDER_… (caso histórico do S76)'],
            ['sem_extensao', 'placeholder', 'sem extensão: vale a regra de texto'],
            ['slides.html', '<!doctype html><html><body><section><h2>HD x SSD</h2><p>PLACEHOLDER</p></section></body></html>', 'código: "PLACEHOLDER" solto em maiúsculas'],
            ['gerar.py', 'from pptx import Presentation\n# [TODO: adicionar os slides aqui]\n', 'código: os demais padrões de molde continuam valendo'],
        ] as const) {
            const r = await gravar(nome, conteudo);
            assert(r.success === false && /\[CONTENT-STUB\]/.test(r.error || '') && !fs.existsSync(path.join(pasta, nome)), `${oQue} → bloqueado`, r);
        }
    } finally {
        fs.rmSync(pasta, { recursive: true, force: true });
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S405 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error('S405 erro inesperado:', err); process.exit(1); });
