/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S123
 * Investigação 2026-07-14 (docs/INVESTIGACAO_POWERPOINT_ADDIN_2026-07-14.md):
 *
 * RC1 — o contexto do suplemento PowerPoint (metadata.hostApp/slideContext) só era injetado
 *       no caminho AgentLoop (SessionContext); o GoalPlanner planejava cego ao host e caçava
 *       a apresentação aberta como arquivo no workspace (chegou a rodar
 *       Presentation('apresentacao.pptx') sobre um arquivo de 0 bytes).
 * RC2 — o planner não conhecia o schema de powerpoint_control (buildToolContracts hardcoded
 *       ignora tool.parameters) e detectMissingRequiredArgs não validava 'action' → step sem
 *       action explodiu na tool com "Ação 'undefined' não é suportada".
 *
 * Execução: npx ts-node src/__tests__/regression/S123_PowerPointPlannerHostContext.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { buildHostAppContextBlock } from '../../shared/hostAppContext';
import { buildToolContracts, detectMissingRequiredArgs } from '../../loop/GoalPlanner';
import { ToolRegistry } from '../../core/ToolRegistry';
import { powerpointControlTool } from '../../tools/powerpoint_control';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ OK ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

function readSource(relPath: string): string {
    return fs.readFileSync(path.join(__dirname, '..', '..', relPath), 'utf-8');
}

async function main(): Promise<void> {
    console.log('=== S123 — Contexto do host no GoalPlanner + schemas dinâmicos de tools ===');

    // --- Caso 1: buildHostAppContextBlock é no-op para canais comuns ---
    console.log('\n--- Caso 1: canais sem hostApp não ganham bloco ---');
    assert(buildHostAppContextBlock(undefined) === '', 'metadata undefined → bloco vazio');
    assert(buildHostAppContextBlock({}) === '', 'metadata sem hostApp → bloco vazio');
    assert(buildHostAppContextBlock({ hostApp: 'desconhecido' }) === '', 'hostApp desconhecido → bloco vazio');

    // --- Caso 2: bloco do PowerPoint contém as orientações críticas ---
    console.log('\n--- Caso 2: bloco do PowerPoint (conteúdo) ---');
    const block = buildHostAppContextBlock({
        hostApp: 'powerpoint',
        slideContext: {
            presentationTitle: 'aula_exemplo.pptx',
            totalSlides: 4,
            activeSlideIndex: 2,
            slideTitles: ['Capa', 'Introdução', 'Ameaças', 'Conclusão'],
        },
    });
    assert(block.includes('Canal: Suplemento Microsoft PowerPoint'), 'identifica o host');
    assert(block.includes('Arquivo: aula_exemplo.pptx'), 'injeta presentationTitle');
    assert(block.includes('Slide ativo: 2 de 4'), 'injeta slide ativo/total');
    assert(block.includes('powerpoint_control'), 'orienta a usar powerpoint_control para ler a apresentação aberta');
    assert(/getPresentation/.test(block) && /getSlide/.test(block), 'menciona as actions de leitura');
    assert(/python-pptx/i.test(block), 'exige geração estrutural editável via python-pptx');
    assert(/Marp/i.test(block), 'alerta contra Marp CLI (slides-imagem não editáveis)');
    assert(/NUNCA procure a apresentacao aberta como arquivo/i.test(block), 'proíbe caçar a apresentação aberta no workspace');

    // --- Caso 3: fonte única — SessionContext e GoalExecutionLoop consomem a mesma função ---
    console.log('\n--- Caso 3: fonte única (sem duplicação do bloco) ---');
    const sessionSrc = readSource(path.join('session', 'SessionContext.ts'));
    const loopSrc = readSource(path.join('loop', 'GoalExecutionLoop.ts'));
    const plannerSrc = readSource(path.join('loop', 'GoalPlanner.ts'));
    assert(sessionSrc.includes('buildHostAppContextBlock(channelMetadata)'), 'SessionContext usa a função compartilhada');
    assert(!sessionSrc.includes('HOST_APP_HINTS'), 'SessionContext não mantém cópia local do hint');
    assert(loopSrc.includes('buildHostAppContextBlock(channelContext.metadata)'), 'GoalExecutionLoop deriva hostContext do ChannelContext');
    assert(/planner\.plan\([^)]*hostContext\)/.test(loopSrc), 'GoalExecutionLoop passa hostContext ao plan()');
    assert(/planner\.replan\([^)]*hostContext\)/.test(loopSrc), 'GoalExecutionLoop passa hostContext ao replan()');
    // Seção própria do prompt — NÃO dentro do runtimeContext (que passa por enforceMemoryBudget)
    assert(plannerSrc.includes('function buildHostContextSection'), 'GoalPlanner tem seção própria para o host');
    assert(/AMBIENTE DA CONVERSA/.test(plannerSrc), 'seção nomeada no prompt do planner');

    // --- Caso 4: schemas dinâmicos a partir de tool.parameters ---
    console.log('\n--- Caso 4: buildToolContracts expõe schema de tools registradas ---');
    ToolRegistry.register(powerpointControlTool); // no-op se já registrada
    const contracts = buildToolContracts(['powerpoint_control', 'read', 'write']);
    assert(contracts.includes('powerpoint_control:'), 'linha de schema gerada para powerpoint_control');
    assert(contracts.includes('addTextBox | getPresentation | getSlide'), 'enum de action visível ao planner');
    assert(/"action":[^}]*\(obrigatório\)/.test(contracts), 'action marcada como obrigatória');
    assert(contracts.includes('read:            {"path": "arquivo.html"}'), 'schemas hardcoded preservados');

    // --- Caso 5: validação genérica de args obrigatórios via schema ---
    console.log('\n--- Caso 5: detectMissingRequiredArgs genérico (schema-driven) ---');
    const missing = detectMissingRequiredArgs('powerpoint_control', {});
    assert(missing === "sem 'action' obrigatório", 'action ausente detectada ANTES do dispatch', missing);
    const invalid = detectMissingRequiredArgs('powerpoint_control', { action: 'recolorSlides' });
    assert(invalid !== null && /inválido/.test(invalid), 'action fora do enum rejeitada', invalid);
    const ok = detectMissingRequiredArgs('powerpoint_control', { action: 'getPresentation' });
    assert(ok === null, 'action válida passa');
    // Comportamento existente preservado (casos hardcoded)
    assert(detectMissingRequiredArgs('read', {}) === "sem 'path' obrigatório", 'read sem path continua detectado');
    assert(detectMissingRequiredArgs('web_navigate', { action: 'zzz' }) !== null, 'web_navigate continua validada pelo caso explícito');

    console.log(`\n=== Resultados S123: ${passed} passaram, ${failed} falharam ===`);
    if (failed > 0) {
        process.exit(1);
    }
}

main().catch((err) => {
    console.error('Falha inesperada no teste:', err);
    process.exit(1);
});
