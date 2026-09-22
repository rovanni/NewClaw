/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S281 (issue 033, Sprint 3)
 *
 * `send_document.ts` roteava qualquer canal fora de discord/web para um `sendToTelegram()`
 * hardcoded — um documento pedido no WhatsApp/Signal era despachado com canal `'telegram'` fixo, o
 * chatId real (JID/número) ia parar num adapter errado, e `MessageBus.sendDocument()` não lançava
 * quando o adapter de destino não suportava a operação: **reportava sucesso sem nada ter sido
 * entregue**. O mesmo defeito já foi corrigido para áudio (`MessageBus.sendVoice`, comentário
 * próprio no código) e nunca tinha sido replicado para documento.
 *
 * Este teste usa um `MessageBus` REAL (não um stub) — a estrutura do defeito estava nele e em
 * `send_document.ts`, não only em algum ponto isolável por mock.
 *
 *   S281.1 — estrutural: nenhum canal cai mais num `sendToTelegram` fixo; `bus.sendDocument` é
 *            chamado com `this.channel`, nunca um literal
 *   S281.2 — `MessageBus.sendDocument()` LANÇA quando o adapter não suporta (paridade com
 *            `sendVoice`, já corrigido antes)
 *   S281.3 — WhatsApp: roteamento correto (chatId/canal certos chegam ao adapter certo) e falha
 *            real vira `success:false` com o erro verdadeiro — nunca sucesso mentiroso
 *   S281.4 — Signal: mesma cobertura de S281.3
 *   S281.5 — `WhatsAppAdapter.sendDocument`/`SignalAdapter.sendDocument` não engolem exceção
 *            (comportamento real, sem mock de rede)
 *
 * CONTROLE NEGATIVO (feito interativamente ao validar esta mudança, não é código deste arquivo):
 * uma cópia patchada de `send_document.ts` com o `sendToTelegram` hardcoded reintroduzido, e uma
 * cópia de `MessageBus.ts` com o warn+return silencioso de volta, fizeram S281.1/.2/.3 falharem —
 * provando que o teste detecta a regressão, não só o formato do texto de sucesso.
 *
 * Execução: npx ts-node src/__tests__/regression/S281_SendDocument_ChannelRoutingAndTruthfulFailure.test.ts
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MessageBus } from '../../channels/MessageBus';
import { SendDocumentTool } from '../../tools/send_document';
import { WhatsAppAdapter } from '../../channels/WhatsAppAdapter';
import { SignalAdapter } from '../../channels/SignalAdapter';
import type { ChannelAdapter, ChannelType, NormalizedResponse } from '../../channels/ChannelAdapter';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  OK ${message}`); passed++; }
    else { console.error(`  FALHOU: ${message}`, detail ?? ''); failed++; }
}

function makeBus(): MessageBus {
    // MessageBus real — agentLoop/sessionManager nunca são tocados por registerAdapter()/sendDocument().
    return new MessageBus({} as any, {} as any);
}

/** Adapter fake mínimo, registra o que recebeu — para provar que o roteamento chegou ao lugar certo. */
function makeRecordingAdapter(channelType: ChannelType, behavior: 'succeed' | 'throw'): ChannelAdapter & { received?: { chatId: string; filename: string } } {
    const adapter: ChannelAdapter & { received?: { chatId: string; filename: string } } = {
        channelType,
        displayName: channelType,
        isConnected: true,
        async start() {},
        async stop() {},
        async send(_r: NormalizedResponse, _c: unknown) {},
        async healthCheck() { return { ok: true }; },
        async sendDocument(chatId: string, _buffer: Buffer, filename: string) {
            adapter.received = { chatId, filename };
            if (behavior === 'throw') throw new Error(`falha real de transporte em ${channelType}`);
        },
    };
    return adapter;
}

function makeTmpFile(content = 'conteúdo de teste S281'): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'newclaw-s281-'));
    const p = path.join(dir, 'documento.txt');
    fs.writeFileSync(p, content);
    return p;
}

async function main(): Promise<void> {
    const src = fs.readFileSync(path.resolve(__dirname, '../../tools/send_document.ts'), 'utf8');
    const busSrc = fs.readFileSync(path.resolve(__dirname, '../../channels/MessageBus.ts'), 'utf8');

    console.log('\n=== S281.1 [estrutural] — nenhum canal cai mais num sendToTelegram fixo ===');
    {
        assert(!/private async sendToTelegram\(/.test(src), 'o método sendToTelegram (hardcoded) não existe mais — só sendToChannel, genérico', src);
        assert(/sendToChannel\(this\.channel as ChannelType/.test(src),
            'o ramo genérico passa this.channel (o canal real), não um literal', src);
        assert(!/bus\.sendDocument\(\s*'telegram'/.test(src), "nenhuma chamada bus.sendDocument('telegram', ...) hardcoded sobrevive", src);
    }

    console.log("\n=== S281.2 — MessageBus.sendDocument() LANÇA quando o adapter não suporta (paridade com sendVoice) ===");
    {
        assert(/sendDocument[\s\S]{0,300}throw new Error\(`Adapter "\$\{channel\}" does not support sendDocument`\)/.test(busSrc),
            'MessageBus.ts: sendDocument lança para adapter sem suporte (não é mais warn+return)', busSrc.includes('send_document_unsupported'));

        const bus = makeBus();
        let threw = false;
        try {
            await bus.sendDocument('whatsapp', 'x', Buffer.from('a'), 'f.txt');
        } catch { threw = true; }
        assert(threw, 'chamada real: sem NENHUM adapter whatsapp registrado, sendDocument lança (não resolve em silêncio)');
    }

    console.log('\n=== S281.3 — WhatsApp: roteamento correto e falha real vira success:false verdadeiro ===');
    {
        // (a) sucesso: o adapter certo recebe o chatId certo (não o de outro canal).
        const bus = makeBus();
        const wa = makeRecordingAdapter('whatsapp', 'succeed');
        bus.registerAdapter(wa);
        const tool = new SendDocumentTool(bus);
        tool.setContext('5511999999999@s.whatsapp.net', 'whatsapp');
        const filePath = makeTmpFile();
        const r = await tool.execute({ file_path: filePath });
        assert(r.success === true, 'sucesso real reportado quando o adapter de fato aceita', r);
        assert(wa.received?.chatId === '5511999999999@s.whatsapp.net', 'o JID do WhatsApp chegou ao adapter do WhatsApp — não a algum outro canal', wa.received);

        // (b) falha real: o adapter lança, e o resultado é success:false com o erro verdadeiro —
        // nunca "✅ enviado" (o defeito original).
        const bus2 = makeBus();
        const waFail = makeRecordingAdapter('whatsapp', 'throw');
        bus2.registerAdapter(waFail);
        const tool2 = new SendDocumentTool(bus2);
        tool2.setContext('5511999999999@s.whatsapp.net', 'whatsapp');
        const r2 = await tool2.execute({ file_path: filePath });
        assert(r2.success === false, 'falha real do transporte vira success:false, nunca sucesso mentiroso', r2);
        assert(!!r2.error && /falha real de transporte em whatsapp/.test(r2.error), 'o erro reportado é o erro REAL, não um texto genérico', r2.error);

        // (c) o defeito original: NENHUM adapter registrado para whatsapp — antes desta correção,
        // isso reportava "✅ Documento enviado ao Telegram." mesmo sem nada ter sido enviado.
        const bus3 = makeBus();
        const tool3 = new SendDocumentTool(bus3);
        tool3.setContext('5511999999999@s.whatsapp.net', 'whatsapp');
        const r3 = await tool3.execute({ file_path: filePath });
        assert(r3.success === false, 'sem adapter whatsapp registrado, o resultado é FALHA — não mais um sucesso falso', r3);
        assert(!/Telegram/i.test(r3.error ?? ''), 'o erro não menciona Telegram — o canal nunca foi trocado por baixo', r3.error);
    }

    console.log('\n=== S281.4 — Signal: mesma cobertura ===');
    {
        const bus = makeBus();
        const sg = makeRecordingAdapter('signal', 'succeed');
        bus.registerAdapter(sg);
        const tool = new SendDocumentTool(bus);
        tool.setContext('+5511999999999', 'signal');
        const filePath = makeTmpFile();
        const r = await tool.execute({ file_path: filePath });
        assert(r.success === true, 'sucesso real quando o adapter aceita', r);
        assert(sg.received?.chatId === '+5511999999999', 'o número do Signal chegou ao adapter do Signal', sg.received);

        const bus2 = makeBus();
        const tool2 = new SendDocumentTool(bus2);
        tool2.setContext('+5511999999999', 'signal');
        const r2 = await tool2.execute({ file_path: filePath });
        assert(r2.success === false, 'sem adapter signal registrado, falha de verdade (não sucesso falso)', r2);
        assert(!/Telegram/i.test(r2.error ?? ''), 'erro não menciona Telegram', r2.error);
    }

    console.log('\n=== S281.5 — WhatsAppAdapter/SignalAdapter.sendDocument não engolem exceção (comportamento real) ===');
    {
        const wa = new WhatsAppAdapter({ enabled: false }); // sem start(): this.sock fica null
        let waThrew = false;
        try { await wa.sendDocument('x', Buffer.from('a'), 'f.txt'); } catch { waThrew = true; }
        assert(waThrew, 'WhatsAppAdapter.sendDocument lança quando não há socket (não resolve calado)');

        // Signal: sem phoneNumber configurado, execSignalCli tentaria rodar o binário — se ele não
        // existir no PATH deste ambiente de teste, também deve lançar (nunca engolir).
        const sg = new SignalAdapter({ enabled: false, phoneNumber: '' });
        let sgThrew = false;
        try { await sg.sendDocument('x', Buffer.from('a'), 'f.txt'); } catch { sgThrew = true; }
        assert(sgThrew, 'SignalAdapter.sendDocument lança quando a chamada real falha (signal-cli ausente/config vazia), não resolve calado');
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S281 RESULTADO: ${passed} passou | ${failed} falhou`);
    if (failed > 0) process.exit(1);
    process.exit(0);
}

main().catch(err => { console.error('S281 erro inesperado:', err); process.exit(1); });
