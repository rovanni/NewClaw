/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S311
 *
 * Contexto: `send_audio.ts` ganhou uma camada 0 — servidor TTS do operador, compatível com a API
 * OpenAI (`POST /v1/audio/speech`, ex.: Kokoro-FastAPI), declarado por `KOKORO_TTS_URL`. Ordem da
 * cadeia: servidor declarado → Piper → edge-tts. Mesma regra do Whisper: nenhum endereço padrão;
 * quem não declarou nada não muda de comportamento (`SOBERANIA_DA_CONFIGURACAO.md` §1.1).
 *
 * Cobre (com servidor HTTP real em loopback, sem rede externa):
 *   1. Controle negativo: sem `KOKORO_TTS_URL` não há endpoint — a camada não existe.
 *   2. Declarado: POST no caminho certo, corpo OpenAI (model/input/response_format), voz vinda de
 *      `KOKORO_TTS_VOICE`, arquivo `.wav` escrito, nenhum fato (o texto não saiu da máquina).
 *   3. URL com barra final funciona; sem `KOKORO_TTS_VOICE` o campo `voice` é omitido (nada presumido).
 *   4. Falha (HTTP 500, Content-Type não-áudio, corpo vazio, servidor fora do ar): cai para a
 *      próxima engine E produz o fato de que o texto saiu da máquina (Soberania §1.2).
 *   5. Ordem no código-fonte: Kokoro é tentado antes da sondagem do Piper.
 *
 * Execução: npx ts-node src/__tests__/regression/S311_SendAudio_KokoroDeclaredLayer.test.ts
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { AddressInfo } from 'net';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

type Mode = 'ok' | 'http500' | 'json' | 'empty';
interface Seen { method?: string; url?: string; body?: Record<string, unknown> }

function startServer(mode: Mode, seen: Seen): Promise<http.Server> {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            let raw = '';
            req.on('data', (c) => { raw += c; });
            req.on('end', () => {
                seen.method = req.method;
                seen.url = req.url;
                try { seen.body = JSON.parse(raw); } catch { seen.body = undefined; }
                if (mode === 'http500') { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end('{"error":"x"}'); return; }
                if (mode === 'json') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); return; }
                if (mode === 'empty') { res.writeHead(200, { 'Content-Type': 'audio/wav' }); res.end(); return; }
                res.writeHead(200, { 'Content-Type': 'audio/wav' });
                res.end(Buffer.from('RIFF0000WAVEfake-audio-bytes'));
            });
        });
        server.listen(0, '127.0.0.1', () => resolve(server));
    });
}

const src = fs.readFileSync(path.join(__dirname, '..', '..', 'tools', 'send_audio.ts'), 'utf-8');

async function main(): Promise<void> {
    const { SendAudioTool } = await import('../../tools/send_audio');
    const fakeBus = {} as unknown as import('../../channels/MessageBus').MessageBus;
    const tool = new SendAudioTool(fakeBus) as unknown as {
        resolveKokoroEndpoint(): string | null;
        generateViaNodeEdgeTts(text: string, voice: string, out: string): Promise<void>;
        generateAudio(text: string, voice: string, dir: string, ts: number): Promise<{ file: string; fatos: string[] }>;
    };
    // Substitui só a engine remota final: o teste não pode depender da rede da Microsoft.
    tool.generateViaNodeEdgeTts = async (_t, _v, out) => { fs.writeFileSync(out, 'edge-stub'); };

    delete process.env.PIPER_MODELS_DIR;
    delete process.env.PIPER_BIN;
    const dir = os.tmpdir();
    const cleanup: string[] = [];

    console.log('\n=== S311-1 — controle negativo: sem KOKORO_TTS_URL a camada não existe ===');
    {
        delete process.env.KOKORO_TTS_URL;
        assert(tool.resolveKokoroEndpoint() === null, 'sem a variável não há endpoint');
        process.env.KOKORO_TTS_URL = '   ';
        assert(tool.resolveKokoroEndpoint() === null, 'variável só com espaços também não declara nada');
        delete process.env.KOKORO_TTS_URL;
        const g = await tool.generateAudio('texto', 'pt-BR-AntonioNeural', dir, Date.now());
        cleanup.push(g.file);
        assert(g.file.endsWith('.mp3') && g.fatos.length === 0, 'cadeia inalterada: vai ao edge-tts, sem fatos', g);
    }

    console.log('\n=== S311-2 — declarado: contrato OpenAI, voz do .env, .wav, sem fatos ===');
    {
        const seen: Seen = {};
        const server = await startServer('ok', seen);
        const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        process.env.KOKORO_TTS_URL = base;
        process.env.KOKORO_TTS_VOICE = 'voz_teste';
        const g = await tool.generateAudio('Olá mundo', 'pt-BR-AntonioNeural', dir, Date.now());
        cleanup.push(g.file);
        assert(g.file.endsWith('.wav'), 'arquivo bruto é .wav', g.file);
        assert(fs.existsSync(g.file) && fs.statSync(g.file).size > 0, 'áudio do servidor foi gravado');
        assert(g.fatos.length === 0, 'texto não saiu da máquina — nenhum fato');
        assert(seen.method === 'POST' && seen.url === '/v1/audio/speech', 'POST /v1/audio/speech', seen);
        assert(seen.body?.input === 'Olá mundo' && seen.body?.model === 'kokoro' && seen.body?.response_format === 'wav', 'corpo no formato OpenAI', seen.body);
        assert(seen.body?.voice === 'voz_teste', 'voz vem de KOKORO_TTS_VOICE, não do parâmetro do edge-tts', seen.body);

        console.log('\n=== S311-3 — barra final aceita; sem KOKORO_TTS_VOICE o campo voice é omitido ===');
        process.env.KOKORO_TTS_URL = `${base}///`;
        delete process.env.KOKORO_TTS_VOICE;
        const seen2: Seen = {};
        server.removeAllListeners('request');
        server.on('request', (req, res) => {
            let raw = ''; req.on('data', (c) => { raw += c; });
            req.on('end', () => { seen2.url = req.url; seen2.body = JSON.parse(raw); res.writeHead(200, { 'Content-Type': 'audio/wav' }); res.end(Buffer.from('x')); });
        });
        const g2 = await tool.generateAudio('oi', 'pt-BR-AntonioNeural', dir, Date.now() + 1);
        cleanup.push(g2.file);
        assert(seen2.url === '/v1/audio/speech', 'barras finais não duplicam o caminho', seen2.url);
        assert(seen2.body !== undefined && !('voice' in seen2.body), 'sem voz declarada nada é presumido', seen2.body);
        await new Promise((r) => server.close(r));
    }

    console.log('\n=== S311-4 — falhas caem para a próxima engine e produzem o fato de saída da máquina ===');
    for (const mode of ['http500', 'json', 'empty'] as Mode[]) {
        const seen: Seen = {};
        const server = await startServer(mode, seen);
        process.env.KOKORO_TTS_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        const g = await tool.generateAudio('texto', 'pt-BR-AntonioNeural', dir, Date.now() + 2);
        cleanup.push(g.file);
        assert(g.file.endsWith('.mp3'), `[${mode}] cai para a engine seguinte`, g.file);
        assert(g.fatos.length === 1 && /saiu da máquina/.test(g.fatos[0]), `[${mode}] fato de que o texto saiu da máquina`, g.fatos);
        await new Promise((r) => server.close(r));
    }
    {
        // Porta que acabou de ser fechada: servidor declarado fora do ar.
        const server = await startServer('ok', {});
        const port = (server.address() as AddressInfo).port;
        await new Promise((r) => server.close(r));
        process.env.KOKORO_TTS_URL = `http://127.0.0.1:${port}`;
        const g = await tool.generateAudio('texto', 'pt-BR-AntonioNeural', dir, Date.now() + 3);
        cleanup.push(g.file);
        assert(g.file.endsWith('.mp3') && g.fatos.length === 1, '[fora do ar] cai para a engine seguinte com fato', g);
    }
    delete process.env.KOKORO_TTS_URL;

    console.log('\n=== S311-5 — ordem no código: Kokoro antes do Piper antes do edge-tts ===');
    {
        const body = src.slice(src.indexOf('private async generateAudio'), src.indexOf('private async generateViaNodeEdgeTts'));
        const k = body.indexOf('generateViaKokoro(');
        const p = body.indexOf('findPiperInstallation()');
        const e = body.indexOf('generateViaNodeEdgeTts(text, voice, mp3File)');
        assert(k !== -1 && p !== -1 && e !== -1 && k < p && p < e, 'Kokoro < Piper < edge-tts', { k, p, e });
        assert(!/https?:\/\/\d/.test(src), 'nenhum endereço IP embutido no código-fonte');
    }

    for (const f of cleanup) { try { fs.unlinkSync(f); } catch { /* já removido */ } }
    console.log(`\n${'─'.repeat(60)}`);
    console.log(failed === 0 ? `✅ S311 passou (${passed} verificações)` : `❌ S311: ${failed} falha(s) de ${passed + failed}`);
    process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((err) => {
    console.error('S311 erro inesperado:', err);
    process.exitCode = 1;
});
