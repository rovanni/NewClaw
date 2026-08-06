/// <reference types="node" />
/**
 * S200 — Álbum do Telegram vira UMA mensagem com N anexos.
 *
 * BUG REAL (incidente de 04/08/2026, RFC-004 Correção 4): o usuário enviou 12 imagens de uma vez,
 * com a pergunta "Poderia explicar cada projeto?" na legenda. O log mostra o que o Core recebeu:
 *
 *     10:08:25  message_received "Poderia explicar cada projeto?"  type=photo
 *     10:08:25  message_received (sem texto)                       type=photo
 *     10:08:25  message_received (sem texto)                       type=photo
 *     … 12 mensagens no mesmo segundo
 *
 * O Telegram entrega um update por item de álbum e anexa a legenda apenas ao primeiro. Como o
 * adapter tratava cada update isoladamente, a pergunta do usuário chegou junto de UMA imagem e as
 * outras onze chegaram sem pergunta nenhuma — cada uma abrindo seu próprio objetivo, do zero. O
 * processamento levou 27 minutos e produziu nove respostas desconexas.
 *
 * Agrupar é responsabilidade do adapter, não do Core: Discord e Web já entregam N anexos numa
 * única mensagem, e o Telegram é a única plataforma que fragmenta. É tradução de formato da
 * plataforma — a diferença que ARCHITECTURE.md autoriza ao adapter.
 *
 * Invariantes travadas:
 *   1. mídias do mesmo media_group_id viram UMA mensagem com todos os anexos;
 *   2. a legenda da primeira mídia é preservada como texto da mensagem;
 *   3. mídia avulsa (sem media_group_id) não espera nada;
 *   4. o messageId da primeira mídia é preservado (a deduplicação do MessageBus continua válida);
 *   5. ao atingir o teto de anexos, o álbum é despachado sem esperar o resto da janela;
 *   6. parar o adapter despacha álbum em montagem — mídia recebida não se perde no desligamento;
 *   7. álbuns de chats diferentes não se misturam.
 *
 * Execução: npx ts-node src/__tests__/regression/S200_TelegramAlbum_SingleMessage.test.ts
 */
import { TelegramAdapter } from '../../channels/TelegramAdapter';
import { MessageBus } from '../../channels/MessageBus';
import type { NormalizedMessage } from '../../channels/ChannelAdapter';

const WINDOW_MS = parseInt(process.env.TELEGRAM_ALBUM_WINDOW_MS || '1500', 10);

let failures = 0;
function check(ok: boolean, label: string, detail = '') {
    if (ok) {
        console.log(`  OK   ${label}`);
    } else {
        failures++;
        console.error(`  FALHOU: ${label}${detail ? ' → ' + detail : ''}`);
    }
}

/** Bus falso: só registra o que foi despachado. */
function makeSpyBus(): { bus: MessageBus; sent: NormalizedMessage[] } {
    const sent: NormalizedMessage[] = [];
    const bus = {
        async processMessage(msg: NormalizedMessage) { sent.push(msg); },
    } as unknown as MessageBus;
    return { bus, sent };
}

function makeAdapter() {
    const adapter = new TelegramAdapter({
        enabled: false,                     // não conecta: nenhum polling, nenhuma chamada de API
        botToken: '000000:test-token-fake',
        allowedUserIds: [],
    });
    const { bus, sent } = makeSpyBus();
    adapter.setBus(bus);
    return { adapter, sent };
}

/** dispatchOrGroup é privado — o teste exercita a unidade diretamente. */
function feed(adapter: TelegramAdapter, groupId: string | undefined, msg: NormalizedMessage): void {
    (adapter as unknown as {
        dispatchOrGroup(id: string | undefined, m: NormalizedMessage): void;
    }).dispatchOrGroup(groupId, msg);
}

function photoMsg(messageId: string, caption: string, fileId: string, chatId = 'chat-1'): NormalizedMessage {
    return {
        messageId, channel: 'telegram', userId: 'user-1', userName: 'Tester',
        type: 'photo', text: caption,
        attachments: [{ type: 'photo', fileId }],
        rawContext: { fake: 'ctx' }, chatId, metadata: {},
    };
}

const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function main() {
    console.log('S200 — Álbum do Telegram vira uma única mensagem\n');

    // ── 1, 2 e 4. O álbum inteiro numa mensagem só ─────────────────────────────
    {
        const { adapter, sent } = makeAdapter();
        feed(adapter, 'grupo-A', photoMsg('101', 'Poderia explicar cada projeto?', 'file-1'));
        feed(adapter, 'grupo-A', photoMsg('102', '', 'file-2'));
        feed(adapter, 'grupo-A', photoMsg('103', '', 'file-3'));

        check(sent.length === 0, 'nada é despachado antes de a janela fechar', `despachou ${sent.length}`);

        await wait(WINDOW_MS + 300);

        check(sent.length === 1, 'o álbum vira UMA mensagem', `mensagens=${sent.length}`);
        check(sent[0]?.attachments?.length === 3, 'com os três anexos juntos', `anexos=${sent[0]?.attachments?.length}`);
        check(
            sent[0]?.text === 'Poderia explicar cada projeto?',
            'a legenda da primeira mídia é a pergunta da mensagem',
            sent[0]?.text,
        );
        check(sent[0]?.messageId === '101', 'o messageId da primeira mídia é preservado (dedup segue válida)', sent[0]?.messageId);
        check(
            sent[0]?.attachments?.map(a => a.fileId).join(',') === 'file-1,file-2,file-3',
            'os anexos mantêm a ordem de chegada',
            sent[0]?.attachments?.map(a => a.fileId).join(','),
        );
        await adapter.stop();
    }

    // ── 3. Mídia avulsa não espera ────────────────────────────────────────────
    {
        const { adapter, sent } = makeAdapter();
        feed(adapter, undefined, photoMsg('200', 'foto solta', 'file-x'));

        check(sent.length === 1, 'mídia sem media_group_id é despachada na hora', `mensagens=${sent.length}`);
        check(sent[0]?.attachments?.length === 1, 'com o único anexo dela');
        await adapter.stop();
    }

    // ── 5. Teto de anexos fecha o álbum sem esperar ───────────────────────────
    {
        const { adapter, sent } = makeAdapter();
        const limite = MessageBus.MAX_ATTACHMENTS_PER_MESSAGE;
        for (let i = 0; i < limite; i++) {
            feed(adapter, 'grupo-cheio', photoMsg(String(300 + i), i === 0 ? 'explique' : '', `file-${i}`));
        }

        check(
            sent.length === 1,
            'ao atingir o teto, o álbum é despachado sem esperar o resto da janela',
            `mensagens=${sent.length}`,
        );
        check(sent[0]?.attachments?.length === limite, `com os ${limite} anexos`, `anexos=${sent[0]?.attachments?.length}`);
        await adapter.stop();
    }

    // ── 6. stop() não perde álbum em montagem ─────────────────────────────────
    {
        const { adapter, sent } = makeAdapter();
        feed(adapter, 'grupo-B', photoMsg('400', 'olha isso', 'file-a'));
        feed(adapter, 'grupo-B', photoMsg('401', '', 'file-b'));
        check(sent.length === 0, 'álbum ainda em montagem antes do stop');

        await adapter.stop();

        check(sent.length === 1, 'stop() despacha o álbum pendente', `mensagens=${sent.length}`);
        check(sent[0]?.attachments?.length === 2, 'com as mídias já recebidas', `anexos=${sent[0]?.attachments?.length}`);
    }

    // ── 7. Álbuns de chats diferentes não se misturam ─────────────────────────
    {
        const { adapter, sent } = makeAdapter();
        feed(adapter, 'grupo-C', photoMsg('500', 'chat um', 'file-c1', 'chat-1'));
        feed(adapter, 'grupo-C', photoMsg('600', 'chat dois', 'file-c2', 'chat-2'));

        await wait(WINDOW_MS + 300);

        check(sent.length === 2, 'mesmo media_group_id em chats distintos produz duas mensagens', `mensagens=${sent.length}`);
        check(
            sent.every(m => m.attachments?.length === 1),
            'cada uma com o anexo do seu próprio chat',
        );
        await adapter.stop();
    }

    console.log(failures === 0 ? '\n✅ S200 passou' : `\n❌ S200: ${failures} falha(s)`);
    process.exitCode = failures === 0 ? 0 : 1;
}

main();
