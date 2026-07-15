/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S122
 * Modelo Estrutural do PowerPoint: slideContext leve e consultas getPresentation / getSlide.
 * 
 * Execução: npx ts-node src/__tests__/regression/S122_PowerPointStructuralReading.test.ts
 */

import { powerpointBroker } from '../../dashboard/routes/powerpointBroker';
import { powerpointControlTool } from '../../tools/powerpoint_control';
import { buildHostAppContextBlock } from '../../shared/hostAppContext';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ OK ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

async function main(): Promise<void> {
    console.log('=== S122 — Teste de Integração: Modelo Estrutural do PowerPoint ===');

    const chatId = 'powerpoint-addin-test-session';

    // Configura o contexto do canal na Tool
    powerpointControlTool.setContext(chatId);

    // --- Caso 1: Testar a lógica de formatação do slideContext leve ---
    console.log('\n--- Caso 1: Injeção do slideContext leve no prompt ---');

    const slideContext = {
        presentationTitle: 'aula_seguranca.pptx',
        totalSlides: 4,
        activeSlideIndex: 2,
        slideTitles: ['Capa', 'Introdução', 'Ameaças', 'Conclusão']
    };

    // Usa a função REAL compartilhada (shared/hostAppContext.ts) — a mesma consumida por
    // SessionContext (caminho AgentLoop) e GoalExecutionLoop (caminho do planner). Antes
    // este teste duplicava a lógica copiada de SessionContext e validava a cópia, não o código.
    const stateBlock = buildHostAppContextBlock({ hostApp: 'powerpoint', slideContext });

    assert(stateBlock.includes('Canal: Suplemento Microsoft PowerPoint'), 'Deve conter hostApp do PowerPoint');
    assert(stateBlock.includes('Arquivo: aula_seguranca.pptx'), 'Deve injetar o presentationTitle leve');
    assert(stateBlock.includes('Slide ativo: 2 de 4'), 'Deve injetar activeSlideIndex e totalSlides');
    assert(stateBlock.includes('1. Capa') && stateBlock.includes('3. Ameaças'), 'Deve listar os slideTitles formatados com índices');
    assert(!stateBlock.includes('slideTexts'), 'Não deve conter slideTexts no prompt (contexto leve)');

    // --- Caso 2: Executar getPresentation e simular Polling / ACK ---
    console.log('\n--- Caso 2: Executar getPresentation via Tool ---');

    // Executamos a tool de forma assíncrona para simular o round-trip
    const getPresentationPromise = powerpointControlTool.execute({
        action: 'getPresentation'
    });

    // Simulamos o polling do broker no Add-in
    const polledCmd = powerpointBroker.poll(chatId);
    assert(polledCmd !== null, 'O broker deve conter o comando getPresentation enfileirado');
    assert(polledCmd?.action === 'getPresentation', 'O comando enfileirado deve ser getPresentation');

    // Add-in envia o resultado do ACK de slides estruturados
    const mockPresentationData = {
        slides: [
            { slideId: '{SLIDE-1}', index: 1, title: 'Capa' },
            { slideId: '{SLIDE-2}', index: 2, title: 'Introdução' }
        ]
    };
    
    powerpointBroker.ack(polledCmd!.commandId, chatId, 'executed', undefined, mockPresentationData);

    const resPresentation = await getPresentationPromise;
    assert(resPresentation.success === true, 'O comando getPresentation deve retornar sucesso');
    assert(resPresentation.output.includes('Dados estruturados:'), 'O output deve conter o cabeçalho de dados estruturados');
    assert(resPresentation.output.includes('{SLIDE-2}'), 'O output de texto deve serializar a lista de slides');

    // --- Caso 3: Executar getSlide e simular Polling / ACK ---
    console.log('\n--- Caso 3: Executar getSlide via Tool ---');

    const getSlidePromise = powerpointControlTool.execute({
        action: 'getSlide',
        index: 2
    });

    const polledSlideCmd = powerpointBroker.poll(chatId);
    assert(polledSlideCmd !== null, 'O comando getSlide deve estar na fila do broker');
    assert(polledSlideCmd?.action === 'getSlide', 'A ação deve ser getSlide');
    assert(polledSlideCmd?.args.index === 2, 'O argumento de index 2 deve ser transmitido');

    // Add-in envia os dados estruturados do slide
    const mockSlideData = {
        slideId: '{SLIDE-2}',
        slideIndex: 2,
        layoutName: 'Normal',
        shapes: [
            { shapeId: '{SHP-1}', name: 'Title', type: 'text', placeholder: true, text: 'Introdução' },
            { shapeId: '{SHP-2}', name: 'TabelaDados', type: 'table', placeholder: false, cells: [['Col1', 'Col2'], ['Val1', 'Val2']] }
        ]
    };

    powerpointBroker.ack(polledSlideCmd!.commandId, chatId, 'executed', undefined, mockSlideData);

    const resSlide = await getSlidePromise;
    assert(resSlide.success === true, 'O comando getSlide deve retornar sucesso');
    assert(resSlide.output.includes('Introdução'), 'O output do slide deve conter o texto de shapes');
    assert(resSlide.output.includes('TabelaDados'), 'O output do slide deve conter a tabela com células');

    // --- Caso 4: Tratar incompatibilidade de Requirement Set ---
    console.log('\n--- Caso 4: Tratar status unsupported de compatibilidade ---');

    const incompatiblePromise = powerpointControlTool.execute({
        action: 'getSlide',
        index: 3
    });

    const polledIncompatible = powerpointBroker.poll(chatId);
    assert(polledIncompatible !== null, 'Comando enfileirado no broker');

    // Simulando Add-in respondendo status=unsupported
    powerpointBroker.ack(polledIncompatible!.commandId, chatId, 'unsupported', 'PowerPointApi 1.1 não suportada');

    const resIncompatible = await incompatiblePromise;
    assert(resIncompatible.success === false, 'Tool deve falhar quando não suportado');
    assert(resIncompatible.output.includes('Falha na execução: PowerPointApi 1.1 não suportada'), 'Mensagem de erro deve ser propagada');

    console.log(`\n=== Resultados S122: ${passed} passaram, ${failed} falharam ===`);
    if (failed > 0) {
        process.exit(1);
    }
}

main().catch((err) => {
    console.error('Falha inesperada no teste:', err);
    process.exit(1);
});
