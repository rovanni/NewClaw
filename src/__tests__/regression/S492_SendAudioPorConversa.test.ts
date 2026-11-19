/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S492 (19/11/2026)
 *
 * `send_audio` é uma instância única para todas as conversas. Achado de 17/11 (caso do áudio repetido na VPS), decisão
 * da operadora em 19/11: provar e corrigir.
 *   1. O `chatId`/canal eram lidos DEPOIS da geração do áudio (TTS + ffmpeg, segundos). Se outra conversa chamasse
 *      `setContext` nesse meio, o áudio da primeira ia para a segunda.
 *   2. O intervalo de 10 s contra envio duplicado era global: um áudio numa conversa fazia o de OUTRA conversa, dentro
 *      dos 10 s, ser pulado (sucesso falso; o áudio nunca saía).
 *
 * REGRESSÃO SE: o áudio de uma conversa for entregue em outra; o intervalo de uma conversa barrar outra; ou o intervalo
 * deixar de barrar o 2º envio na MESMA conversa.
 *
 * Execução: npx ts-node src/__tests__/regression/S492_SendAudioPorConversa.test.ts
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's492-'));
process.env.AUDIO_DIR = dir;

async function main(): Promise<void> {
    const { SendAudioTool } = await import('../../tools/send_audio');
    console.log('\n🧪 S492 — send_audio por conversa\n');

    /** Ferramenta com a geração e a conversão trocadas por stubs controláveis; `enviados` registra canal/chatId reais. */
    function montar() {
        const enviados: Array<{ canal: string; chatId: string }> = [];
        const bus = { sendVoice: async (canal: string, chatId: string) => { enviados.push({ canal, chatId }); } } as any;
        const tool = new SendAudioTool(bus) as any;
        const pendentes: Array<() => void> = [];
        tool.generateAudio = async (_t: string, _v: string, audioDir: string, ts: number) => {
            await new Promise<void>(r => pendentes.push(r));   // o TTS "demora" até o teste liberar
            const f = path.join(audioDir, `raw_${ts}_${Math.random()}.wav`);
            fs.writeFileSync(f, 'x');
            return { file: f, fatos: [] };
        };
        tool.runCommand = async (_c: string, args: string[]) => { fs.writeFileSync(args[args.length - 1], 'ogg'); return { stdout: '', stderr: '' }; };
        const liberar = () => { while (pendentes.length) pendentes.shift()!(); };
        return { tool, enviados, liberar, pendentes };
    }
    const esperar = (ms = 20) => new Promise(r => setTimeout(r, ms));

    console.log('Outra conversa troca o contexto durante a geração do áudio');
    {
        const { tool, enviados, liberar, pendentes } = montar();
        tool.setContext('conversa-A', 'telegram');
        const pA = tool.execute({ text: 'áudio da A' });
        const limite = Date.now() + 10_000;
        while (pendentes.length === 0 && Date.now() < limite) await esperar(5);   // a geração da A começou
        assert(pendentes.length === 1, 'a geração do áudio da A está em curso (stub chamado)', pendentes.length);
        tool.setContext('conversa-B', 'discord');   // turno de outra conversa começa enquanto o TTS da A roda
        liberar();
        const rA = await pA;
        assert(rA.success === true, 'o áudio da A foi gerado', rA);
        assert(enviados.length === 1 && enviados[0].chatId === 'conversa-A' && enviados[0].canal === 'telegram',
            'o áudio da A sai na conversa A, pelo canal dela', enviados);
    }

    console.log('\nO intervalo contra duplicado é por conversa');
    {
        const { tool, enviados, liberar, pendentes } = montar();
        const enviar = async (chat: string) => {
            tool.setContext(chat, 'telegram');
            const p = tool.execute({ text: `áudio ${chat}` });
            const limite = Date.now() + 10_000;
            // Barrado pelo intervalo: a geração nem começa, e o execute já resolveu.
            const pronto = await Promise.race([p.then(() => true), (async () => { while (pendentes.length === 0 && Date.now() < limite) await esperar(5); return false; })()]);
            if (pronto) return p;
            liberar();
            return p;
        };
        await enviar('conversa-A');
        await enviar('conversa-B');
        assert(enviados.filter(e => e.chatId === 'conversa-B').length === 1, 'o áudio da B, logo depois do da A, sai (não é barrado pelo intervalo da A)', enviados);
        tool.setContext('conversa-A', 'telegram');
        const repetido = await tool.execute({ text: 'áudio conversa-A' });
        assert(repetido.success === true && enviados.filter(e => e.chatId === 'conversa-A').length === 1,
            'o 2º áudio na MESMA conversa dentro de 10 s continua barrado (sem envio duplicado)', enviados);
    }

    console.log('\nUm áudio por turno também na conversa direta (decisão da operadora, 19/11/2026)');
    {
        const { AgentLoop } = await import('../../loop/AgentLoop');
        const r = AgentLoop.rastreadorDeAudioDoTurno();
        assert(r.isAudioAlreadySent!() === false, 'turno começa sem áudio entregue');
        r.onArtifactDelivered!('workspace/relatorio.pdf');
        assert(r.isAudioAlreadySent!() === false, 'documento entregue não conta como áudio');
        r.onArtifactDelivered!('__send_audio_delivered__');
        assert(r.isAudioAlreadySent!() === true, 'depois do 1º áudio, o 2º do mesmo turno é barrado pelos guardas que já existiam (S44)');
        assert(AgentLoop.rastreadorDeAudioDoTurno().isAudioAlreadySent!() === false, 'cada turno tem o seu rastreador (o próximo pedido pode ter áudio)');
        assert(r.deferSendDocument === undefined, 'não adia documentos (só o objetivo faz isso)');
        const fonte = fs.readFileSync(path.join(process.cwd(), 'src', 'loop', 'AgentLoop.ts'), 'utf-8');
        const iRun = fonte.indexOf('public async run(conversationId: string');
        const corpo = fonte.slice(iRun, iRun + 400);
        assert(/if \(context && !context\.goalTrace && !context\.deliveryTracking\) \{\s*context = \{ \.\.\.context, deliveryTracking: AgentLoop\.rastreadorDeAudioDoTurno\(\) \};/.test(corpo),
            'run() dá o rastreador só à conversa direta e não troca o do objetivo', corpo.slice(0, 300));
    }

    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`\n${passed} passaram, ${failed} falharam\n`);
    if (failed > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
