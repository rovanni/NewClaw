/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S263 (D-07, campanha de consolidação de duplicidades)
 *
 * `docs/ARCHITECTURE/INVENTARIO_DUPLICACAO_2026-08-24.md`, caso D-07: `DeepSeekProvider` e
 * `GroqProvider` reimplementavam `chat()`/`discoverModels()` quase verbatim em relação a
 * `OpenAIProvider` — e a cópia carecia da conversão de imagem (`toOpenAIContent`/
 * `sniffImageMime`) que corrigiu um bug real (`S192`, 04/08/2026: imagem enviada a um provider
 * OpenAI-Compatible era silenciosamente ignorada, o modelo "inventava" o que via). Como
 * `visionProfile.provider` é livremente configurável pelo operador (`ModelProfileRegistry`), e a
 * Groq expõe modelos `llama-3.2-*-vision` no catálogo OpenAI-Compatible, o mesmo bug podia
 * reaparecer silenciosamente em qualquer um dos dois.
 *
 * Correção: `DeepSeekProvider`/`GroqProvider` passam a `extends OpenAIProvider` — mesmo padrão já
 * usado por `OpenRouterProvider` (`OpenAIProvider.ts:281`) — herdando `chat()`/`discoverModels()`
 * inteiros em vez de reimplementá-los. Comparação estrutural feita antes de escolher herança
 * direta em vez de uma abstração neutra nova (`OpenAICompatibleProvider`): nenhum comportamento
 * herdado (proteção SSRF, probe de liveness, auth, tool-calling) é ilegítimo para os dois —
 * detalhes no comentário de cada arquivo.
 *
 * REGRESSÃO SE: `DeepSeekProvider`/`GroqProvider` deixarem de ser `instanceof OpenAIProvider`
 * (reintroduz a duplicação); ou se uma imagem enviada via `DeepSeekProvider`/`GroqProvider` não
 * chegar ao formato multimodal esperado pela API (reabre o bug classe-S192 nestes dois).
 *
 * Execução: npx ts-node src/__tests__/regression/S263_OpenAICompatibleProviders_D07_SharedHierarchy.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { OpenAIProvider } from '../../core/OpenAIProvider';
import { DeepSeekProvider } from '../../core/DeepSeekProvider';
import { GroqProvider } from '../../core/GroqProvider';

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string, detail?: unknown): void {
    if (cond) { console.log(`  ✅ ${msg}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${msg}`, detail ?? ''); failed++; }
}

function readSrc(relPath: string): string {
    return fs.readFileSync(path.join(process.cwd(), 'src', relPath), 'utf-8');
}

/** Captura o corpo que o provider realmente envia ao servidor — mesma técnica do S192. */
function captureBody(): { get: () => any; url: () => string } {
    let body: any = null;
    let url = '';
    globalThis.fetch = (async (u: any, init?: any) => {
        url = String(u);
        if (init?.body) body = JSON.parse(init.body);
        return { ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) } as any;
    }) as any;
    return { get: () => body, url: () => url };
}

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function main(): Promise<void> {

console.log('\n=== S263-1 [estrutural] — DeepSeekProvider e GroqProvider são instanceof OpenAIProvider (herança, não cópia) ===');
{
    const deepseek = new DeepSeekProvider('fake-key');
    const groq = new GroqProvider('fake-key');
    assert(deepseek instanceof OpenAIProvider, 'DeepSeekProvider extends OpenAIProvider', deepseek);
    assert(groq instanceof OpenAIProvider, 'GroqProvider extends OpenAIProvider', groq);
}

console.log('\n=== S263-2 [estrutural] — os dois arquivos não reimplementam chat()/discoverModels() (sem fetch próprio) ===');
{
    const deepseekSrc = readSrc('core/DeepSeekProvider.ts');
    const groqSrc = readSrc('core/GroqProvider.ts');
    assert(!deepseekSrc.includes('async chat('), 'DeepSeekProvider.ts não reimplementa chat() — herda de OpenAIProvider', null);
    assert(!groqSrc.includes('async chat('), 'GroqProvider.ts não reimplementa chat() — herda de OpenAIProvider', null);
    assert(!deepseekSrc.includes('fetch('), 'DeepSeekProvider.ts não faz fetch próprio', null);
    assert(!groqSrc.includes('fetch('), 'GroqProvider.ts não faz fetch próprio', null);
}

console.log('\n=== S263-3 [funcional] — DeepSeekProvider: imagem chega no formato multimodal (fecha a classe de bug do S192) ===');
{
    const cap = captureBody();
    const p = new DeepSeekProvider('fake-key');
    await p.chat([{ role: 'user', content: 'Descreva esta imagem', images: [PNG_B64] }]);
    const content = cap.get()?.messages?.[0]?.content;
    assert(Array.isArray(content), 'DeepSeekProvider: content vira array de partes quando há imagem (ANTES: images era descartado)', content);
    const img = Array.isArray(content) ? content.find((c: any) => c.type === 'image_url') : null;
    assert(!!img, 'DeepSeekProvider: existe uma parte image_url na mensagem enviada', content);
    assert(cap.get()?.messages?.[0]?.images === undefined, 'DeepSeekProvider: campo `images` solto não é enviado (a API o ignoraria)', cap.get()?.messages?.[0]);
}

console.log('\n=== S263-4 [funcional] — GroqProvider: imagem chega no formato multimodal (fecha a classe de bug do S192) ===');
{
    const cap = captureBody();
    const p = new GroqProvider('fake-key');
    await p.chat([{ role: 'user', content: 'Descreva esta imagem', images: [PNG_B64] }]);
    const content = cap.get()?.messages?.[0]?.content;
    assert(Array.isArray(content), 'GroqProvider: content vira array de partes quando há imagem (ANTES: images era descartado)', content);
    const img = Array.isArray(content) ? content.find((c: any) => c.type === 'image_url') : null;
    assert(!!img, 'GroqProvider: existe uma parte image_url na mensagem enviada', content);
}

console.log('\n=== S263-5 [funcional] — endpoint e modelo default preservados após a migração para herança ===');
{
    const capDs = captureBody();
    const deepseek = new DeepSeekProvider('fake-key');
    await deepseek.chat([{ role: 'user', content: 'oi' }]);
    assert(capDs.url() === 'https://api.deepseek.com/v1/chat/completions', 'DeepSeekProvider ainda bate no endpoint oficial (baseUrl preservado via super())', capDs.url());
    assert(capDs.get()?.model === 'deepseek-chat', 'DeepSeekProvider: modelo default preservado (deepseek-chat)', capDs.get());

    const capGroq = captureBody();
    const groq = new GroqProvider('fake-key');
    await groq.chat([{ role: 'user', content: 'oi' }]);
    assert(capGroq.url() === 'https://api.groq.com/openai/v1/chat/completions', 'GroqProvider ainda bate no endpoint oficial', capGroq.url());
    assert(capGroq.get()?.model === 'llama-3.3-70b-versatile', 'GroqProvider: modelo default preservado', capGroq.get());
}

console.log('\n=== S263-6 [funcional] — name/label identificam corretamente cada provider (não herdam "openai") ===');
{
    const deepseek = new DeepSeekProvider('fake-key');
    const groq = new GroqProvider('fake-key');
    assert(deepseek.name === 'deepseek', 'DeepSeekProvider.name === "deepseek" (não herda "openai" do OpenAIProvider)', deepseek.name);
    assert(groq.name === 'groq', 'GroqProvider.name === "groq"', groq.name);
    assert(deepseek.getLabel() === 'deepseek', 'DeepSeekProvider.getLabel() === "deepseek" (herdado de OpenAIProvider, configurado via super())', deepseek.getLabel());
    assert(groq.getLabel() === 'groq', 'GroqProvider.getLabel() === "groq"', groq.getLabel());
}

console.log('\n=== S263-7 [funcional] — erro HTTP agora inclui o corpo da resposta (mudança de comportamento intencional e documentada) ===');
{
    globalThis.fetch = (async () => ({ ok: false, status: 429, text: async () => 'rate limit exceeded' })) as any;
    const deepseek = new DeepSeekProvider('fake-key');
    let threw = false;
    let message = '';
    try {
        await deepseek.chat([{ role: 'user', content: 'oi' }]);
    } catch (err) {
        threw = true;
        message = String(err);
    }
    assert(threw, 'erro HTTP ainda propaga como exceção', message);
    assert(message.includes('429') && message.includes('rate limit exceeded'), 'mensagem de erro agora inclui status E corpo da resposta (herdado de OpenAIProvider — antes: só "DeepSeek API error: 429", sem corpo)', message);
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S263 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;

}

main().catch((err) => {
    console.error('S263 erro inesperado:', err);
    process.exitCode = 1;
});
