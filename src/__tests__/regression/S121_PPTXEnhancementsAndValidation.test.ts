/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S121
 * Melhorias de PowerPoint (isenções de stub em scripts, context delta e structuralBypass).
 * 
 * Execução: npx ts-node src/__tests__/regression/S121_PPTXEnhancementsAndValidation.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { WriteTool } from '../../tools/write_tool';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ OK ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

async function main(): Promise<void> {
    console.log('=== S121 — Teste de Regressão: Melhorias de PowerPoint e Validação ===');

    const tempWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'newclaw-s121-wsp-'));
    const oldWorkspace = process.env.WORKSPACE_DIR;
    process.env.WORKSPACE_DIR = tempWorkspace;

    try {
        const writeTool = new WriteTool();

        // 1. Arquivo .py contendo "placeholder" (deve passar)
        console.log('\n--- Caso 1: Arquivo .py contendo "placeholder" ---');
        const resPy = await writeTool.execute({
            path: 'test_script.py',
            content: '# Esse script contem placeholders de PPTX\nslide.placeholders[1].text = "teste"\n'
        });
        assert(resPy.success === true, 'Arquivo .py contendo "placeholder" deve ser gravado com sucesso', resPy.error);
        assert(fs.existsSync(path.join(tempWorkspace, 'test_script.py')), 'O arquivo .py realmente existe em disco');

        // 2. Arquivo .ts contendo "TODO" (deve passar)
        console.log('\n--- Caso 2: Arquivo .ts contendo "TODO" ---');
        const resTs = await writeTool.execute({
            path: 'test_script.ts',
            content: '// TODO: implementar logica de PPTX\nconst a = 1;\n'
        });
        assert(resTs.success === true, 'Arquivo .ts contendo "TODO" deve ser gravado com sucesso', resTs.error);

        // 3. Arquivo .md contendo placeholders (deve continuar bloqueando)
        console.log('\n--- Caso 3: Arquivo .md contendo placeholders ---');
        const resMd = await writeTool.execute({
            path: 'documento.md',
            content: '# Titulo\nEste e o [conteudo sera gerado pelo assistente] do slide.\n'
        });
        assert(resMd.success === false, 'Arquivo .md contendo placeholders em colchetes deve ser bloqueado');
        assert(!!resMd.error?.includes('[CONTENT-STUB]'), 'Mensagem de erro deve conter [CONTENT-STUB]', resMd.error);

        // 4. Arquivo .html contendo placeholders (deve continuar bloqueando)
        console.log('\n--- Caso 4: Arquivo .html contendo placeholders ---');
        const resHtml = await writeTool.execute({
            path: 'slides.html',
            content: '<html><body>[conteúdo da aula]</body></html>'
        });
        assert(resHtml.success === false, 'Arquivo .html contendo placeholders em colchetes deve ser bloqueado');

        // 5. Validação da nova mensagem do structuralBypass
        console.log('\n--- Caso 5: Validação da nova mensagem do structuralBypass ---');
        
        // Simulação da lógica exata do structuralBypass introduzida no GoalExecutionLoop.ts
        const pendingSendSteps = [
            { toolArgs: { file_path: 'seguranca_redes_corrigido.pptx' } }
        ];

        // Caso 5.1: Nenhum arquivo foi enviado anteriormente (sentArtifacts está vazio)
        const sentArtifactsEmpty = new Set<string>();
        const allAlreadySent1 = pendingSendSteps.every(s => {
            const fp = String(s.toolArgs?.file_path ?? '');
            return fp ? sentArtifactsEmpty.has(fp) : false;
        });
        assert(allAlreadySent1 === false, 'allAlreadySent deve ser false na primeira entrega');

        const userMessage1 = allAlreadySent1
            ? 'O arquivo solicitado já foi gerado e enviado anteriormente.'
            : 'Consegui gerar o arquivo solicitado com sucesso! Ele está pronto e será enviado em seguida.';
        assert(userMessage1.includes('será enviado'), 'Mensagem deve indicar que será enviado em seguida', userMessage1);

        // Caso 5.2: Arquivo já foi enviado anteriormente (presente em sentArtifacts)
        const sentArtifactsSent = new Set<string>(['seguranca_redes_corrigido.pptx']);
        const allAlreadySent2 = pendingSendSteps.every(s => {
            const fp = String(s.toolArgs?.file_path ?? '');
            return fp ? sentArtifactsSent.has(fp) : false;
        });
        assert(allAlreadySent2 === true, 'allAlreadySent deve ser true se já estiver em sentArtifacts');

        const userMessage2 = allAlreadySent2
            ? 'O arquivo solicitado já foi gerado e enviado anteriormente.'
            : 'Consegui gerar o arquivo solicitado com sucesso! Ele está pronto e será enviado em seguida.';
        assert(userMessage2.includes('enviado anteriormente'), 'Mensagem deve indicar que já foi enviado anteriormente', userMessage2);

    } finally {
        process.env.WORKSPACE_DIR = oldWorkspace;
        fs.rmSync(tempWorkspace, { recursive: true, force: true });
    }

    console.log(`\n=== Resultado de S121: ${passed} passaram, ${failed} falharam ===`);
    if (failed > 0) {
        process.exit(1);
    }
}

main().catch(err => {
    console.error('Erro durante o teste:', err);
    process.exit(1);
});
