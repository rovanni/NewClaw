/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S29
 * Hotfix E: MessageBus.sendVoice() e WebChannelAdapter.sendVoice()/sendDocument() não devem
 * mais resolver silenciosamente quando não existe caminho real de entrega — devem lançar.
 *
 * BUG REAL (achado durante auditoria da conversa de 04/07/2026, log_conversa_newclaw.txt):
 * `MessageBus.sendVoice()` fazia `log.warn(...); return;` quando o adapter do canal não
 * implementava `sendVoice` — retorno normal, sem exceção. `WebChannelAdapter.sendVoice()` e
 * `sendDocument()` faziam o mesmo quando não havia requisição HTTP pendente para o chatId.
 * Em ambos os casos, `send_audio.ts`/`send_document.ts` (que envolvem a chamada em try/catch)
 * nunca viam o catch disparar — o ToolResult final era `success:true` sem nenhum áudio/documento
 * ter de fato chegado a algum canal real.
 *
 * FIX: as três lacunas passaram a lançar Error em vez de retornar silenciosamente. Nenhuma
 * assinatura pública mudou (Promise<void> continua Promise<void>) — os chamadores existentes
 * (send_audio.ts, send_document.ts) já envolvem essas chamadas em try/catch, então a exceção
 * é capturada sem precisar tocar nesses arquivos.
 *
 * ATUALIZADO 10/07/2026: WebChannelAdapter.sendDocument() deixou de lançar quando não há
 * pending. Lançar evitava a falsa entrega, mas também descartava o anexo pra sempre mesmo já
 * pronto no workspace — agora ele fica em espera e é entregue na próxima mensagem da mesma
 * sessão (ver S14 e WebChannelAdapter.ts). Não é uma volta ao bug original: o anexo não é
 * perdido, só adiado — e fica logado (`send_document_queued_orphaned`), não silencioso.
 *
 * ATUALIZADO 11/07/2026: WebChannelAdapter.sendVoice() ganhou a MESMA generalização (item B
 * abaixo) — a fila de entrega órfã (antes só `orphanedAttachments`, agora `orphanedDeliveries`,
 * capaz de texto+anexos) passou a cobrir texto, documento e áudio com um único mecanismo,
 * fechando também a lacuna de `send()` (resposta final de texto) descartada quando o
 * `waitForResponse` da requisição HTTP original já tinha estourado o timeout antes do Goal
 * terminar (causa raiz auditada do "Timeout aguardando resposta do agente" recorrente,
 * 10-11/07/2026). `MessageBus.sendVoice()` (item A) continua lançando quando o ADAPTER não
 * implementa `sendVoice` — cenário diferente (canal sem suporte a voz), inalterado.
 *
 * Execução: npx ts-node src/__tests__/regression/S29_MessageBus_SilentDeliveryNoOps.test.ts
 */

process.env.WORKSPACE_DIR = process.env.WORKSPACE_DIR || 'D:/IA/newclaw/workspace';

import { MessageBus } from '../../channels/MessageBus';
import { WebChannelAdapter } from '../../channels/WebChannelAdapter';
import type { ChannelAdapter } from '../../channels/ChannelAdapter';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

async function assertThrows(fn: () => Promise<unknown>, message: string): Promise<unknown> {
    try {
        await fn();
        console.error(`  ❌ FALHOU: ${message} (não lançou)`);
        failed++;
        return undefined;
    } catch (err) {
        console.log(`  ✅ ${message}`);
        passed++;
        return err;
    }
}

// Adapter mínimo, sem sendVoice — simula um canal real (ex.: Discord) que não suporta voz.
class AdapterSemSendVoice implements Partial<ChannelAdapter> {
    channelType = 'discord' as const;
    displayName = 'Discord (sem voz)';
    isConnected = true;
    async start() {}
    async stop() {}
    async healthCheck() { return { ok: true }; }
    async send() {}
}

// Adapter que IMPLEMENTA sendVoice e sempre resolve — simula o caminho feliz do Telegram
// (grammY resolve normalmente quando a API aceita o envio).
class AdapterComSendVoiceOk implements Partial<ChannelAdapter> {
    channelType = 'telegram' as const;
    displayName = 'Telegram (fake, sempre ok)';
    isConnected = true;
    calls: Array<{ chatId: string; bytes: number }> = [];
    async start() {}
    async stop() {}
    async healthCheck() { return { ok: true }; }
    async send() {}
    async sendVoice(chatId: string, buffer: Buffer): Promise<void> {
        this.calls.push({ chatId, bytes: buffer.length });
        // resolve normalmente — não lança, como o TelegramAdapter real no caminho feliz.
    }
}

// Constructor só armazena as referências (nunca chamadas nos caminhos testados aqui) —
// stubs vazios bastam, mesmo padrão já usado em outros testes de regressão do projeto.
function makeBus(): MessageBus {
    return new MessageBus(
        {} as unknown as import('../../loop/AgentLoop').AgentLoop,
        {} as unknown as import('../../session/SessionManager').SessionManager,
    );
}

async function main() {
    // ── A. adapter sem sendVoice → MessageBus.sendVoice deve lançar ─────────────
    console.log('\n=== S29-A — MessageBus.sendVoice lança quando o adapter não suporta voz ===');
    {
        const bus = makeBus();
        // @ts-expect-error — acesso ao Map interno só para registrar o adapter fake no teste
        bus.adapters.set('discord', new AdapterSemSendVoice());
        await assertThrows(
            () => bus.sendVoice('discord', 'chat-1', Buffer.from('audio-fake')),
            'sendVoice lança Error quando adapter.sendVoice não existe',
        );
    }

    // ── B. WebChannelAdapter sem pending em sendVoice → generalizado em 11/07/2026 ──────
    // ATUALIZADO: sendVoice deixou de lançar quando não há pending, mesma generalização
    // aplicada a sendDocument no item C abaixo (ver WebChannelAdapter.ts, nota de classe
    // "Entrega órfã"). Lançar evitava a "falsa entrega" original desta suíte, mas descartava
    // um áudio já pronto pra sempre — agora fica em espera e é entregue na próxima mensagem.
    console.log('\n=== S29-B — WebChannelAdapter.sendVoice sem pending fica em espera (não lança, não descarta) ===');
    {
        const web = new WebChannelAdapter();
        let threw = false;
        try {
            await web.sendVoice('chat-sem-pending', Buffer.from('audio-fake'));
        } catch {
            threw = true;
        }
        assert(!threw, 'sendVoice NÃO lança quando não há pending (fica em espera pra próxima mensagem)');

        const responsePromise = web.waitForResponse('req-b-depois', 'chat-sem-pending', 5000);
        await web.send({ text: 'próxima mensagem dessa sessão', format: 'plain' }, 'req-b-depois');
        const response = await responsePromise;
        assert(
            response.attachments?.[0]?.type === 'audio',
            'áudio que ficou em espera chega na próxima resposta da mesma sessão — não foi descartado',
            response.attachments
        );
    }

    // ── C. WebChannelAdapter sem pending em sendDocument → NÃO lança mais (contrato
    //      atualizado em 10/07/2026, ver S14) ──────────────────────────────────────────
    // Lançar aqui resolvia a "falsa entrega" (S29 original), mas trocava por outro problema
    // real: o anexo era descartado pra sempre, mesmo já pronto no workspace — reproduzido ao
    // vivo com um goal de 21min que gerou o .pptx com sucesso mas nunca conseguiu entregá-lo
    // (dashboard sem polling, diferente do suplemento PowerPoint). Agora fica em espera
    // (orphanedAttachments) e é entregue assim que a MESMA sessão mandar a próxima
    // mensagem — não é "silencioso": o log `send_document_queued_orphaned` registra a
    // situação, e a entrega de fato acontece depois, não é descartada. sendVoice (item B
    // acima) continua lançando — não afetado por este fix.
    console.log('\n=== S29-C — WebChannelAdapter.sendDocument sem pending fica em espera (não lança, não descarta) ===');
    {
        const web = new WebChannelAdapter();
        let threw = false;
        try {
            await web.sendDocument('chat-sem-pending', Buffer.from('doc-fake'), 'arquivo.txt');
        } catch {
            threw = true;
        }
        assert(!threw, 'sendDocument NÃO lança quando não há pending (fica em espera pra próxima mensagem)');

        const responsePromise = web.waitForResponse('req-c-depois', 'chat-sem-pending', 5000);
        await web.send({ text: 'próxima mensagem dessa sessão', format: 'plain' }, 'req-c-depois');
        const response = await responsePromise;
        assert(
            response.attachments?.[0]?.fileName === 'arquivo.txt',
            'anexo que ficou em espera chega na próxima resposta da mesma sessão — não foi descartado',
            response.attachments
        );
    }

    // ── D. Reprodução fiel do catch de send_audio.ts ao redor de bus.sendVoice() ──
    // NOTA METODOLÓGICA: rodar SendAudioTool.execute() de ponta a ponta exigiria edge-tts real
    // instalado (ausente nesta máquina de dev, mesma causa raiz documentada na auditoria) — o
    // que essa etapa especificamente testa é upload, não geração de TTS. Em vez de forjar um
    // binário substituto de edge-tts (frágil entre SOs), reproduzimos aqui o EXATO bloco
    // try/catch de send_audio.ts:135-145 (mesma estrutura, mesmo texto de erro), provando que
    // uma exceção de bus.sendVoice() vira ToolResult{success:false} sem precisar de TTS real.
    console.log('\n=== S29-D — catch de send_audio.ts ao redor de bus.sendVoice() vira success:false ===');
    {
        const bus = makeBus();
        // @ts-expect-error — mesmo acesso interno do teste A, adapter sem sendVoice
        bus.adapters.set('telegram', new AdapterSemSendVoice());

        async function reproducaoDoUploadDeSendAudio(): Promise<{ success: boolean; output: string; error?: string }> {
            try {
                await bus.sendVoice('telegram', 'chat-1', Buffer.from('audio-fake'), 'voice.ogg');
                return { success: true, output: '🔊 Áudio enviado com sucesso!' };
            } catch (uploadError) {
                return { success: false, output: '', error: `Upload failed: ${(uploadError as Error).message}` };
            }
        }

        const result = await reproducaoDoUploadDeSendAudio();
        assert(result.success === false, `resultado é success:false (obtido: ${JSON.stringify(result)})`, result);
        assert(!!result.error?.startsWith('Upload failed:'), 'mensagem de erro identifica falha de upload', result);
    }

    // ── E. Caminho Telegram normal (adapter com sendVoice funcional) não regride ──
    console.log('\n=== S29-E — MessageBus.sendVoice não lança quando o adapter suporta e confirma voz ===');
    {
        const bus = makeBus();
        const adapter = new AdapterComSendVoiceOk();
        // @ts-expect-error — mesmo acesso interno dos testes anteriores
        bus.adapters.set('telegram', adapter);

        let threw = false;
        try {
            await bus.sendVoice('telegram', 'chat-1', Buffer.from('audio-real'), 'voice.ogg');
        } catch {
            threw = true;
        }
        assert(!threw, 'sendVoice NÃO lança quando o adapter suporta e confirma o envio (sem regressão)');
        assert(adapter.calls.length === 1 && adapter.calls[0].chatId === 'chat-1', 'adapter recebeu a chamada com o chatId correto', adapter.calls);
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S29 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    if (failed > 0) process.exit(1);
}

main().catch(err => { console.error('ERRO NÃO TRATADO:', err); process.exit(1); });
