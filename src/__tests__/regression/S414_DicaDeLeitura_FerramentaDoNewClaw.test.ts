/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S414 (regra 11 do AGENTS.md)
 * Quando um arquivo binário não pode ser lido como texto, a dica aponta a ferramenta do PRÓPRIO NewClaw que o lê (read_document) —
 * nunca um programa externo que pode não existir na máquina.
 *
 * ORIGEM (Windows, 15/10/2026, 23:47): o erro da ferramenta read para PDF dizia "use exec_command com pdftotext ou pandoc". Num Windows
 * sem pdftotext, o agente não leu o calendário — e o juiz de qualidade, ao reprovar a resposta, repetiu a mesma dica errada como fato.
 * O bloqueio de leitura binária do AgentLoop repetia a receita ("python-pptx, pandoc, pdftotext").
 *
 * REGRESSÃO SE: a dica voltar a citar programa externo; ou deixar de apontar read_document para os formatos que ela lê.
 *
 * Execução: npx ts-node src/__tests__/regression/S414_DicaDeLeitura_FerramentaDoNewClaw.test.ts
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ferramentaQueLe, FORMATOS_DO_READ_DOCUMENT } from '../../tools/formatosDeDocumento';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

async function main(): Promise<void> {
    const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'newclaw-s414-'));
    process.env.WORKSPACE_DIR = pasta;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { ReadTool } = require('../../tools/read_tool') as typeof import('../../tools/read_tool');
    try {
        console.log('\n=== S414-1 — a ferramenta read, num PDF, aponta read_document ===');
        fs.writeFileSync(path.join(pasta, 'Calendario Academico 2026.pdf'), '%PDF-1.4 binário');
        const r = await new ReadTool().execute({ path: 'Calendario Academico 2026.pdf' });
        assert(r.success === false && /use read_document/.test(r.error ?? ''), 'PDF: "Para extrair o conteúdo, use read_document."', r.error);
        assert(!/pdftotext|pandoc|python-pptx/.test(r.error ?? ''), 'sem programa externo na dica', r.error);
        fs.writeFileSync(path.join(pasta, 'pacote.zip'), 'PK');
        const z = await new ReadTool().execute({ path: 'pacote.zip' });
        assert(z.success === false && !/read_document|pdftotext/.test(z.error ?? ''), 'formato que nenhuma ferramenta do NewClaw lê: só o fato, sem dica inventada', z.error);

        console.log('\n=== S414-2 — fonte única dos formatos (dispatch de read_document e dicas) ===');
        assert(['x.pdf', 'x.DOCX', 'x.odt', 'x.png'].every(n => ferramentaQueLe(n) === 'read_document') && ferramentaQueLe('x.zip') === '', 'PDF, DOCX, ODT, PNG → read_document; ZIP → nenhuma');
        const rd = fs.readFileSync(path.join(__dirname, '../../tools/read_document.ts'), 'utf-8');
        assert(/const FORMATOS = FORMATOS_DO_READ_DOCUMENT/.test(rd) && /FORMATOS\.pdf\.includes\(ext\)/.test(rd), 'read_document decide pelos mesmos formatos', FORMATOS_DO_READ_DOCUMENT);
        const al = fs.readFileSync(path.join(__dirname, '../../loop/AgentLoop.ts'), 'utf-8');
        // Os dois avisos de binário do AgentLoop: a 1ª leitura ([ARQUIVO BINÁRIO]) e a repetida ([BINARY-READ-BLOCK]).
        for (const marca of ['[ARQUIVO BINÁRIO]', '[BINARY-READ-BLOCK]']) {
            const ini = al.indexOf(marca);
            const trecho = al.slice(Math.max(0, ini - 600), ini + 700);
            assert(ini > 0 && /ferramentaQueLe\(/.test(trecho) && !/\(python-pptx|com python-pptx|pandoc, pdftotext/.test(trecho.replace(/\/\/[^\n]*/g, '')), `${marca}: usa a mesma dica, sem receita externa`, trecho.slice(0, 200));
        }
    } finally {
        fs.rmSync(pasta, { recursive: true, force: true });
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S414 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    process.exit(failed > 0 ? 1 : 0);
}
main().catch(err => { console.error('S414 erro inesperado:', err); process.exit(1); });
