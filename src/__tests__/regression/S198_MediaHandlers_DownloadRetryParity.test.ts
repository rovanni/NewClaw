/// <reference types="node" />
/**
 * S198 — Foto e documento tentam baixar com a mesma persistência que o áudio.
 *
 * BUG REAL (incidente de 04/08/2026, RFC-004 Correção 3): das 12 imagens enviadas, três nunca
 * produziram resposta nenhuma. O log mostra o motivo, em três linhas consecutivas:
 *
 *     10:32:31  [VisionHandler] telegram_photo_download_failed  fetch failed
 *     10:32:34  [VisionHandler] telegram_photo_download_failed  Network request for 'getFile' failed!
 *     10:32:38  [VisionHandler] telegram_photo_download_failed  fetch failed
 *
 * Três falhas de rede transitórias, três imagens perdidas — porque `handlePhotoAttachment` e
 * `handleDocumentAttachment` tentavam o download UMA vez. No mesmo arquivo,
 * `transcribeAttachment` já tentava três vezes com backoff progressivo para o mesmo tipo de
 * falha e no mesmo canal. A política existia; só não tinha sido aplicada aos outros dois
 * caminhos — assimetria silenciosa, do tipo que só aparece quando a rede oscila.
 *
 * Este teste trava a paridade: os três handlers persistem igual diante de falha transitória, e
 * desistem no mesmo ponto diante de falha permanente.
 *
 * Execução: npx ts-node src/__tests__/regression/S198_MediaHandlers_DownloadRetryParity.test.ts
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), 'newclaw-s198-'));
process.env.WORKSPACE_DIR = WORKSPACE;

import { handlePhotoAttachment, handleDocumentAttachment } from '../../core/agentMediaHandlers';
import type { MessageBus } from '../../channels/MessageBus';
import type { NormalizedMessage, ChannelAttachment } from '../../channels/ChannelAdapter';

let failures = 0;
function check(ok: boolean, label: string, detail = '') {
    if (ok) {
        console.log(`  OK   ${label}`);
    } else {
        failures++;
        console.error(`  FALHOU: ${label}${detail ? ' → ' + detail : ''}`);
    }
}

/** MessageBus falso: falha nas `failTimes` primeiras chamadas, depois entrega bytes. */
function busThatFails(failTimes: number): { bus: MessageBus; attempts: () => number } {
    let attempts = 0;
    const bus = {
        async downloadFile(): Promise<Buffer> {
            attempts++;
            if (attempts <= failTimes) throw new Error('fetch failed');
            return Buffer.from('conteudo-de-teste');
        },
    } as unknown as MessageBus;
    return { bus, attempts: () => attempts };
}

function telegramMsg(): NormalizedMessage {
    return {
        messageId: 'm1', channel: 'telegram', userId: 'u1', type: 'photo',
        text: 'olha essa foto', attachments: [], rawContext: 'ctx', chatId: 'c1',
    };
}

const photoAttachment: ChannelAttachment = { type: 'photo', fileId: 'file-abc' };
const docAttachment: ChannelAttachment = { type: 'document', fileId: 'file-def', fileName: 'notas.txt' };

async function main() {
    console.log('S198 — Paridade de retry no download de anexos\n');

    // ── 1. Foto: falha transitória (2x) deve ser superada na 3ª tentativa ──────
    {
        const { bus, attempts } = busThatFails(2);
        const msg = telegramMsg();
        // visionProfile null → processVision devolve "(Visão não configurada)" sem chamar LLM.
        const failure = await handlePhotoAttachment(msg, photoAttachment, bus, null);

        check(attempts() === 3, 'foto: tentou 3 vezes diante de falha transitória', `tentativas=${attempts()}`);
        check(failure === null, 'foto: sucesso na 3ª tentativa não vira falha', String(failure));
        check(msg.text.includes('IMAGEM RECEBIDA'), 'foto: o fato foi anexado ao texto da mensagem');
    }

    // ── 2. Documento: mesma persistência ──────────────────────────────────────
    {
        const { bus, attempts } = busThatFails(2);
        const msg = telegramMsg();
        const failure = await handleDocumentAttachment(msg, docAttachment, bus);

        check(attempts() === 3, 'documento: tentou 3 vezes diante de falha transitória', `tentativas=${attempts()}`);
        check(failure === null, 'documento: sucesso na 3ª tentativa não vira falha', String(failure));
        check(msg.text.includes('notas.txt'), 'documento: o fato cita o arquivo salvo');
    }

    // ── 3. Falha permanente: desiste depois de 3 e reporta motivo ─────────────
    {
        const { bus, attempts } = busThatFails(99);
        const msg = telegramMsg();
        const failure = await handlePhotoAttachment(msg, photoAttachment, bus, null);

        check(attempts() === 3, 'foto: falha permanente desiste após 3 tentativas', `tentativas=${attempts()}`);
        check(
            typeof failure === 'string' && failure.length > 0,
            'foto: falha permanente devolve motivo (que o MessageBus transforma em fato)',
            String(failure),
        );
    }

    // ── 4. Paridade declarada: os três handlers usam o mesmo limite ───────────
    {
        const source = fs.readFileSync(
            path.join(__dirname, '..', '..', 'core', 'agentMediaHandlers.ts'), 'utf-8',
        );
        const helperUses = (source.match(/downloadWithRetry\(/g) || []).length;
        check(
            helperUses >= 3,
            'os três caminhos de download usam o mesmo auxiliar de retry',
            `ocorrências de downloadWithRetry(: ${helperUses}`,
        );
        check(
            (source.match(/MAX_DOWNLOAD_ATTEMPTS\s*=/g) || []).length === 1,
            'existe um único lugar declarando o número de tentativas',
        );
    }

    try { fs.rmSync(WORKSPACE, { recursive: true, force: true }); } catch { /* limpeza best-effort */ }

    console.log(failures === 0 ? '\n✅ S198 passou' : `\n❌ S198: ${failures} falha(s)`);
    process.exit(failures === 0 ? 0 : 1);
}

main();
