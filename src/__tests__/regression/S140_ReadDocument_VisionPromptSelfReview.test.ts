/**
 * TESTE DE REGRESSÃO — S140
 *
 * Self Review Visual: extensão de `processVision()` (agentMediaHandlers.ts) para aceitar um
 * prompt customizável, e extensão de `read_document.ts` para rotear imagens pro modelo de visão
 * quando um `prompt` é fornecido (usado pela skill content-validator para revisão visual de
 * screenshots gerados pelo próprio agente — docs/DIRETRIZ_ARQUITETURA_2026-07-13.md, gate
 * "Extensão antes de Criação": 0 arquivos novos, só extensão de read_document/processVision já
 * existentes).
 *
 * Verifica:
 * 1. processVision() usa o customPrompt quando fornecido, e o prompt default (comportamento
 *    original) quando omitido — backward compatible com o único caller pré-existente
 *    (handlePhotoAttachment).
 * 2. ReadDocumentTool: imagem + prompt + providerFactory/profileRegistry configurados → chama o
 *    modelo de visão (não tesseract) e devolve o texto da crítica.
 * 3. ReadDocumentTool: imagem SEM prompt, mesmo com providerFactory/profileRegistry configurados
 *    → NÃO chama o modelo de visão (comportamento de OCR original intocado para todo caller que
 *    não passar prompt explicitamente).
 * 4. ReadDocumentTool: imagem + prompt, mas sem perfil de visão configurado (getProfileByCategory
 *    devolve undefined) → cai para OCR sem lançar exceção.
 * 5. ReadDocumentTool: construtor sem argumentos (equivalente a `new ReadDocumentTool()`, forma
 *    usada por todo caller anterior a esta mudança) + imagem + prompt → não lança exceção, cai
 *    para OCR (proteção contra chamada sem providerFactory/profileRegistry injetados).
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { processVision, VisionProfile } from '../../core/agentMediaHandlers';
import { ReadDocumentTool } from '../../tools/read_document';
import type { ProviderFactory } from '../../core/ProviderFactory';
import type { ModelProfileRegistry } from '../../loop/ModelProfileRegistry';

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string, detail?: unknown): void {
    if (cond) { console.log(`  ✅ ${msg}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${msg}`, detail ?? ''); failed++; }
}

// PNG 1x1 válido (transparente) — suficiente pra passar pelos checks de arquivo existente.
const TINY_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64'
);

function makeTempPng(): string {
    const p = path.join(os.tmpdir(), `s140_${Date.now()}_${Math.random().toString(36).slice(2)}.png`);
    fs.writeFileSync(p, TINY_PNG);
    return p;
}

function makeFakeProviderFactory(recorder: { calls: any[] }, responseText = 'CRITICA: parece ok') {
    return {
        getProviderWithModel: () => ({
            chat: async (messages: any[]) => {
                recorder.calls.push(messages);
                return { content: responseText };
            }
        })
    } as unknown as ProviderFactory;
}

function makeFakeProfileRegistry(hasVisionProfile: boolean) {
    return {
        getProfileByCategory: (category: string) =>
            hasVisionProfile && category === 'vision'
                ? { id: 'vision-primary', model: 'gemma4:31b-cloud', server: 'http://localhost:11434', provider: 'ollama', category: 'vision', description: 'x' }
                : undefined
    } as unknown as ModelProfileRegistry;
}

async function main() {
    console.log('\n=== S140 — Self Review Visual: processVision(prompt) + read_document vision branch ===');

    // 1. processVision — prompt customizado vs default
    {
        const recorder = { calls: [] as any[] };
        const factory = makeFakeProviderFactory(recorder);
        const profile: VisionProfile = { server: 'http://localhost:11434', model: 'gemma4:31b-cloud', provider: 'ollama' };

        await processVision(TINY_PNG, 'screenshot.png', profile, factory, 'Critique esta interface.');
        const sentPrompt1 = recorder.calls[0]?.[0]?.content;
        assert(sentPrompt1 === 'Critique esta interface.', 'processVision usa o customPrompt quando fornecido', sentPrompt1);

        await processVision(TINY_PNG, 'foto.jpg', profile, factory);
        const sentPrompt2 = recorder.calls[1]?.[0]?.content;
        assert(
            typeof sentPrompt2 === 'string' && sentPrompt2.includes('Descreva esta imagem'),
            'processVision usa o prompt default (comportamento original) quando customPrompt é omitido',
            sentPrompt2
        );
    }

    // 2. read_document: imagem + prompt + vision configurado → chama modelo de visão
    {
        const recorder = { calls: [] as any[] };
        const factory = makeFakeProviderFactory(recorder, 'APROVADO: layout limpo, sem problemas.');
        const registry = makeFakeProfileRegistry(true);
        const tool = new ReadDocumentTool(factory, registry);
        const imgPath = makeTempPng();

        const result = await tool.execute({ filename: imgPath, prompt: 'Critique a qualidade visual desta página.' });

        assert(result.success === true, 'read_document com prompt+vision configurado retorna success', result);
        assert(result.output.includes('APROVADO'), 'read_document devolve o texto da crítica do modelo de visão', result.output);
        assert(recorder.calls.length === 1, 'modelo de visão foi chamado exatamente 1 vez', recorder.calls.length);
        assert(recorder.calls[0]?.[0]?.content === 'Critique a qualidade visual desta página.', 'prompt do tool arg chegou ao modelo de visão sem alteração', recorder.calls[0]?.[0]?.content);

        fs.unlinkSync(imgPath);
    }

    // 3. read_document: imagem SEM prompt, mesmo com vision configurado → NÃO chama visão (comportamento original preservado)
    {
        const recorder = { calls: [] as any[] };
        const factory = makeFakeProviderFactory(recorder);
        const registry = makeFakeProfileRegistry(true);
        const tool = new ReadDocumentTool(factory, registry);
        const imgPath = makeTempPng();

        await tool.execute({ filename: imgPath });

        assert(recorder.calls.length === 0, 'sem prompt explícito, read_document NÃO chama o modelo de visão (OCR continua o caminho padrão)', recorder.calls.length);

        fs.unlinkSync(imgPath);
    }

    // 4. read_document: prompt fornecido, mas sem perfil de visão (getProfileByCategory → undefined) → cai pra OCR sem exceção
    {
        const recorder = { calls: [] as any[] };
        const factory = makeFakeProviderFactory(recorder);
        const registry = makeFakeProfileRegistry(false);
        const tool = new ReadDocumentTool(factory, registry);
        const imgPath = makeTempPng();

        let threw = false;
        let result: any = null;
        try {
            result = await tool.execute({ filename: imgPath, prompt: 'Critique isso.' });
        } catch { threw = true; }

        assert(!threw, 'sem perfil de visão configurado, read_document não lança exceção — cai para OCR', result);
        assert(recorder.calls.length === 0, 'sem perfil de visão, modelo de visão não é chamado', recorder.calls.length);

        fs.unlinkSync(imgPath);
    }

    // 5. read_document: construtor legado sem argumentos (`new ReadDocumentTool()`) + prompt → não lança exceção
    {
        const tool = new ReadDocumentTool(); // forma usada por todo caller anterior a esta mudança
        const imgPath = makeTempPng();

        let threw = false;
        let result: any = null;
        try {
            result = await tool.execute({ filename: imgPath, prompt: 'Critique isso.' });
        } catch { threw = true; }

        assert(!threw, 'construtor sem argumentos (compatibilidade retroativa) não lança exceção mesmo com prompt', result);

        fs.unlinkSync(imgPath);
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S140 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    if (failed > 0) process.exit(1);
    process.exit(0);
}

main().catch(err => {
    console.error('Erro no teste S140:', err);
    process.exit(1);
});
