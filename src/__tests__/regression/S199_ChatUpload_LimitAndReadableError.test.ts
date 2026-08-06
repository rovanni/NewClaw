/// <reference types="node" />
/**
 * S199 — Excesso de anexos devolve JSON traduzível, não página HTML de erro.
 *
 * BUG REAL (incidente de 04/08/2026, RFC-004 Correção 5): enviar mais arquivos do que o limite
 * derrubava a requisição inteira com `HTTP 500` e corpo `<!DOCTYPE html>…MulterError: Too many
 * files…`. A interface faz `res.json()` nessa resposta, o parse explode e o usuário vê
 * "Unexpected token '<'" — mensagem sem nenhuma relação com o que ele fez.
 *
 * Havia ainda dois números literais independentes para a mesma regra (o limite do multer na rota
 * e o limite da interface), que podiam divergir numa edição sem ninguém perceber, e as mensagens
 * de anexo eram texto fixo em português dentro de um arquivo que tem sistema de tradução — um
 * usuário en-US/es-ES recebia português.
 *
 * Invariantes travadas:
 *   1. o limite da rota vem da MESMA constante da ingestão (MessageBus.MAX_ATTACHMENTS_PER_MESSAGE);
 *   2. excesso de arquivos → HTTP 400 com JSON {error:'too_many_files', max}, nunca HTML;
 *   3. dentro do limite, a requisição passa normalmente;
 *   4. a interface não repete o número do limite como literal;
 *   5. as chaves de anexo usadas em index.html existem nos três idiomas (S147 cobre apenas
 *      config/*.js — index.html ficava de fora).
 *
 * Execução: npx ts-node src/__tests__/regression/S199_ChatUpload_LimitAndReadableError.test.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import express from 'express';
import type { AddressInfo } from 'net';
import { uploadFiles, MAX_UPLOAD_FILES } from '../../dashboard/routes/chat';
import { MessageBus } from '../../channels/MessageBus';

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'dashboard', 'public');

let failures = 0;
function check(ok: boolean, label: string, detail = '') {
    if (ok) {
        console.log(`  OK   ${label}`);
    } else {
        failures++;
        console.error(`  FALHOU: ${label}${detail ? ' → ' + detail : ''}`);
    }
}

function loadTranslations(): Record<string, Record<string, string>> {
    const source = fs.readFileSync(path.join(PUBLIC_DIR, 'shared.js'), 'utf-8');
    const sandbox: Record<string, unknown> = {
        localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
        document: { addEventListener: () => {}, documentElement: {}, querySelectorAll: () => [], getElementById: () => null },
        window: {},
        console: { log: () => {}, warn: () => {}, error: () => {} },
        fetch: () => Promise.reject(new Error('no network in test')),
    };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    return vm.runInContext(source + '\n;TRANSLATIONS;', sandbox, { timeout: 5000 });
}

async function main() {
    console.log('S199 — Limite de anexos: fonte única e erro legível\n');

    // ── 1. Uma constante só para todo o sistema ────────────────────────────────
    check(
        MAX_UPLOAD_FILES === MessageBus.MAX_ATTACHMENTS_PER_MESSAGE,
        'o limite da rota de upload é o mesmo da ingestão',
        `rota=${MAX_UPLOAD_FILES} ingestão=${MessageBus.MAX_ATTACHMENTS_PER_MESSAGE}`,
    );

    // ── 2 e 3. Comportamento real do middleware, via HTTP ──────────────────────
    const app = express();
    app.post('/api/chat', uploadFiles, (req, res) => {
        res.json({ ok: true, files: ((req.files as unknown[]) || []).length });
    });
    const server = app.listen(0);
    await new Promise<void>(resolve => server.once('listening', () => resolve()));
    const port = (server.address() as AddressInfo).port;

    async function post(fileCount: number) {
        const form = new FormData();
        form.append('message', 'teste');
        for (let i = 0; i < fileCount; i++) {
            form.append('files', new Blob([`conteudo-${i}`], { type: 'image/jpeg' }), `img-${i}.jpg`);
        }
        const res = await fetch(`http://127.0.0.1:${port}/api/chat`, { method: 'POST', body: form });
        const text = await res.text();
        return { status: res.status, text, contentType: res.headers.get('content-type') || '' };
    }

    {
        const excesso = await post(MAX_UPLOAD_FILES + 2);
        check(excesso.status === 400, 'excesso de arquivos responde 400 (não 500)', `status=${excesso.status}`);
        check(
            excesso.contentType.includes('application/json'),
            'a resposta de excesso é JSON, não HTML',
            excesso.contentType,
        );
        check(
            !excesso.text.includes('<!DOCTYPE html>') && !excesso.text.includes('MulterError'),
            'a resposta não vaza página de erro nem stack trace do multer',
            excesso.text.slice(0, 60),
        );
        let parsed: { error?: string; max?: number } = {};
        try { parsed = JSON.parse(excesso.text); } catch { /* fica vazio e a checagem abaixo falha */ }
        check(parsed.error === 'too_many_files', 'código de erro estável para a interface traduzir', String(parsed.error));
        check(parsed.max === MAX_UPLOAD_FILES, 'o limite acompanha o erro, para a mensagem citar o número certo', String(parsed.max));
    }

    {
        const dentro = await post(2);
        const parsed = JSON.parse(dentro.text) as { ok?: boolean; files?: number };
        check(dentro.status === 200 && parsed.ok === true, 'requisição dentro do limite passa normalmente', `status=${dentro.status}`);
        check(parsed.files === 2, 'os arquivos chegam ao handler', `files=${parsed.files}`);
    }

    // O fetch do Node (undici) mantém conexões keep-alive no pool. Sem derrubá-las antes de
    // fechar o servidor, o processo aborta no encerramento com um assert do libuv no Windows
    // (`!(handle->flags & UV_HANDLE_CLOSING)`) — e o runner de regressão decide pelo exit code,
    // então um teste com todas as checagens verdes contaria como falha.
    server.closeAllConnections?.();
    await new Promise<void>(resolve => server.close(() => resolve()));

    // ── 4. A interface não repete o número do limite ──────────────────────────
    {
        const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf-8');
        check(
            !/const\s+MAX_ATTACHMENTS\s*=\s*\d+/.test(html),
            'index.html não fixa o limite como constante literal (lê do servidor)',
        );
        check(
            !/alert\(`?⚠️ Máximo de/.test(html),
            'o alerta de limite não é mais texto fixo em português',
        );
    }

    // ── 5. Chaves de anexo do index.html existem nos três idiomas ─────────────
    {
        const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf-8');
        const TRANSLATIONS = loadTranslations();
        const langs = Object.keys(TRANSLATIONS);
        const T_CALL = /\bt\(\s*'([a-zA-Z0-9_]+)'|\bt\(\s*"([a-zA-Z0-9_]+)"/g;

        const used = new Set<string>();
        let m: RegExpExecArray | null;
        while ((m = T_CALL.exec(html)) !== null) used.add(m[1] || m[2]);

        const attachKeys = [...used].filter(k => k.startsWith('attach_'));
        check(attachKeys.length >= 2, 'index.html usa chaves de tradução para anexos', attachKeys.join(', '));

        const unresolved: string[] = [];
        for (const key of used) {
            for (const lang of langs) {
                if (!(key in TRANSLATIONS[lang])) unresolved.push(`${key} (${lang})`);
            }
        }
        check(
            unresolved.length === 0,
            `as ${used.size} chaves t() de index.html resolvem nos 3 idiomas`,
            unresolved.slice(0, 10).join(', '),
        );
    }

    console.log(failures === 0 ? '\n✅ S199 passou' : `\n❌ S199: ${failures} falha(s)`);
    // exitCode em vez de process.exit(): deixa o loop de eventos drenar os handles de rede.
    process.exitCode = failures === 0 ? 0 : 1;
}

main();
