/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S192
 *
 * Achado em teste de uso como usuário leigo (04/08/2026): anexar uma imagem no chat e perguntar
 * "o que está escrito nessa imagem?".
 *
 * Imagem real (gerada para o teste): `NOTA FISCAL 12345` / `Total: R$ 247,90`.
 *
 * | Provider usado | Resposta entregue ao usuário |
 * |---|---|
 * | nuvem (via OllamaProvider) | "NOTA FISCAL ELETRÔNICA, N° 12345678901234567890, Data: 27/10/2023, Valor: R$ 150,00, Emissor: Empresa Teste…" |
 * | local (via OpenAIProvider) | "O conteúdo da imagem deve ser lido e extraído." |
 *
 * Nos dois casos o texto vinha rotulado como **"extraído via vision:<modelo>"** — conteúdo
 * fabricado apresentado como extração. Num recibo ou nota fiscal, é dado financeiro inventado
 * com aparência de leitura.
 *
 * Causa (a do caso local, que é estrutural): `processVision()` monta a mensagem com
 * `images: [base64]` — formato interno herdado do campo `images` do Ollama. `OllamaProvider`
 * repassa esse campo; `OpenAIProvider` jogava `messages` direto no corpo, e `images` não existe
 * na API da OpenAI. Resultado: o modelo recebia só o texto "Descreva esta imagem..." SEM imagem
 * nenhuma, em TODO provider compatível com OpenAI — llamafile local, LM Studio, vLLM e a própria
 * OpenAI oficial. Falha silenciosa: nunca deu erro, sempre "funcionou".
 *
 * Depois da correção, o mesmo modelo local leu a imagem corretamente:
 * "NOTA FISCAL 12345 / Total: R$ 247,90".
 *
 * Execução: npx ts-node src/__tests__/regression/S192_VisionImageReachesOpenAIProvider.test.ts
 */

import { OpenAIProvider } from '../../core/OpenAIProvider';

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string, detail?: unknown): void {
    if (cond) { console.log(`  OK ${msg}`); passed++; }
    else { console.error(`  FALHOU: ${msg}`, detail ?? ''); failed++; }
}

const realFetch = globalThis.fetch;

/** Captura o corpo que o provider realmente envia ao servidor. */
function captureBody(): { get: () => any } {
    let body: any = null;
    globalThis.fetch = (async (_url: any, init?: any) => {
        if (init?.body) body = JSON.parse(init.body);
        return { ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) } as any;
    }) as any;
    return { get: () => body };
}

// Assinaturas base64 reais (primeiros bytes de cada formato).
const PNG_B64  = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const JPEG_B64 = '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';

async function main() {
    console.log('\n=== S192 — a imagem precisa CHEGAR ao provider compatível com OpenAI ===');

    console.log('\n--- S192.1 — imagem viaja dentro de content, no formato da API ---');
    {
        const cap = captureBody();
        const p = new OpenAIProvider('', 'modelo-visao', 'http://127.0.0.1:8080/v1', 'Modelo local');
        await p.chat([{ role: 'user', content: 'Descreva esta imagem', images: [PNG_B64] }]);
        const body = cap.get();
        const content = body?.messages?.[0]?.content;

        assert(Array.isArray(content), 'content vira array de partes quando há imagem', content);
        assert(Array.isArray(content) && content.some((c: any) => c.type === 'text' && c.text === 'Descreva esta imagem'),
            'o texto do prompt é preservado como parte de texto', content);
        const img = Array.isArray(content) ? content.find((c: any) => c.type === 'image_url') : null;
        assert(!!img, 'existe uma parte image_url — sem ela o modelo responde sobre nada', content);
        assert(!!img && String(img.image_url?.url || '').includes(PNG_B64),
            'a imagem em base64 vai completa na data URL', img);
        assert(body?.messages?.[0]?.images === undefined,
            'o campo interno `images` não é enviado solto (a API o ignoraria, foi essa a falha original)', body?.messages?.[0]);
    }

    console.log('\n--- S192.2 — o tipo vem dos BYTES, não do nome do arquivo ---');
    {
        const cap = captureBody();
        const p = new OpenAIProvider('', 'modelo-visao', 'http://127.0.0.1:8080/v1', 'Modelo local');
        await p.chat([{ role: 'user', content: 'foto', images: [JPEG_B64] }]);
        const url = String(cap.get()?.messages?.[0]?.content?.find((c: any) => c.type === 'image_url')?.image_url?.url || '');
        assert(url.startsWith('data:image/jpeg;base64,'), 'JPEG é reconhecido pela assinatura dos bytes', url.slice(0, 40));

        const cap2 = captureBody();
        const p2 = new OpenAIProvider('', 'modelo-visao', 'http://127.0.0.1:8080/v1', 'Modelo local');
        await p2.chat([{ role: 'user', content: 'captura', images: [PNG_B64] }]);
        const url2 = String(cap2.get()?.messages?.[0]?.content?.find((c: any) => c.type === 'image_url')?.image_url?.url || '');
        assert(url2.startsWith('data:image/png;base64,'), 'PNG é reconhecido pela assinatura dos bytes', url2.slice(0, 40));
    }

    console.log('\n--- S192.3 — conversa sem imagem não muda de forma ---');
    {
        const cap = captureBody();
        const p = new OpenAIProvider('', 'modelo', 'http://127.0.0.1:8080/v1', 'Modelo local');
        await p.chat([
            { role: 'system', content: 'você é um assistente' },
            { role: 'user', content: 'oi' },
        ]);
        const msgs = cap.get()?.messages;
        assert(msgs?.[0]?.content === 'você é um assistente' && msgs?.[1]?.content === 'oi',
            'mensagens de texto seguem como string simples — nenhum servidor precisa lidar com formato novo à toa', msgs);
    }

    console.log('\n--- S192.4 — múltiplas imagens na mesma mensagem ---');
    {
        const cap = captureBody();
        const p = new OpenAIProvider('', 'modelo-visao', 'http://127.0.0.1:8080/v1', 'Modelo local');
        await p.chat([{ role: 'user', content: 'compare as duas', images: [PNG_B64, JPEG_B64] }]);
        const partes = cap.get()?.messages?.[0]?.content?.filter((c: any) => c.type === 'image_url') || [];
        assert(partes.length === 2, 'as duas imagens são enviadas, não só a primeira', partes.length);
    }

    globalThis.fetch = realFetch;
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S192 RESULTADO: ${passed} passou | ${failed} falhou`);
    if (failed > 0) process.exit(1);
    process.exit(0);
}

main().catch(err => { globalThis.fetch = realFetch; console.error('Erro no teste S192:', err); process.exit(1); });
