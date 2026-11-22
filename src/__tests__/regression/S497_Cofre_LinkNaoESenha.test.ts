/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S497 (22/11/2026, ADR-019)
 *
 * ORIGEM: 22/11/2026 — ao enviar um link curto de vídeo no chat, o cofre de segredos capturou a URL inteira como
 * `<SEGREDO:senha_1>`, e ao tentar reenviar após a explicação automática, capturou o segundo link como `<SEGREDO:senha_2>`.
 *
 * Três causas coordenadas:
 *   1. `temCaraDeSenha` aceitava URLs HTTP(S) (8+ caracteres, minúsculas + `:/.`, sem espaço) quando `pedidaAgora` estava
 *      ativo ou depois de um rótulo, engolindo o link inteiro — inclusive antes da regra S459 (`TOKEN_EM_LINK`).
 *   2. `CREDENCIAL_PEDIDA` casava o plural `tokens` (ex.: resumo de simulação com "530 tokens" ou orçamento com "2000 tokens"),
 *      e falas de instrução para desfazer falso positivo (`/segredo_apagar`) disparavam `pedidaAgora` por conterem "senha",
 *      criando um laço em que o reenvio virava `senha_2`, `senha_3`…
 *   3. `SessionManager.ultimaFalaDoAssistente` não tinha janela de validade: uma mensagem do assistente de 11 horas antes
 *      seguia ativa como se fosse um pedido imediato de credencial.
 *
 * REGRESSÃO SE: links HTTP(S) sem credencial na autoridade virarem segredo inteiro (sozinhos ou após rótulo); token dentro
 * de link (`/private-…`, `?token=…`) ou `usuario:senha@host` perderem proteção; plural `tokens` ou aviso com `/segredo_apagar`
 * ativarem `pedidaAgora`; pedido singular `token` ou sugestão `/segredo <nome> <valor>` deixarem de proteger; ou
 * `ultimaFalaDoAssistente` aceitar mensagem do assistente expirada (> 30 min).
 *
 * Execução: npx ts-node src/__tests__/regression/S497_Cofre_LinkNaoESenha.test.ts
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { detectarSegredos, protegerEntrada } from '../../shared/segredos';
import { SessionManager } from '../../session/SessionManager';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-s497-'));
const envPath = path.join(dir, '.env');
fs.writeFileSync(envPath, 'APP_LANG=pt-BR\n');
const envAntes = { ...process.env };

try {
    console.log('\n=== S497-1 — links HTTP(S) nunca viram senha inteira ===');
    {
        const ctxSenha = { ultimaFalaDoAssistente: 'Me envie a senha da sua conta, por favor.' };
        assert(detectarSegredos('https://vt.tiktok.example/AbCd12345/', ctxSenha).length === 0,
            'link curto de vídeo sozinho após pedido de senha não vira segredo');
        assert(detectarSegredos('https://www.tiktok.example/@usuario/video/7000000000000000001', ctxSenha).length === 0,
            'link com @ no caminho (não na autoridade) não é confundido com credencial');
        assert(detectarSegredos('https://www.youtube.example/watch?v=AbCdEfGhIjK', ctxSenha).length === 0,
            'link de vídeo YouTube não vira segredo');
        assert(detectarSegredos('http://localhost:3000/video', ctxSenha).length === 0,
            'link http local não vira segredo');

        assert(detectarSegredos('o link da senha é https://accounts.example/apppasswords').length === 0,
            'frase com rótulo apontando para URL não guarda a URL');
        assert(detectarSegredos('o vídeo sobre a senha fica em https://vt.tiktok.example/AbCd12345/').length === 0,
            'frase com texto intermediário antes de URL não parte a URL no esquema');
        assert(detectarSegredos('senha https://accounts.example/reset').length === 0,
            'rótulo colado em URL não guarda a URL');
        assert(detectarSegredos('a senha é http://localhost:8080/login').length === 0,
            'URL http após "a senha é" não vira segredo');

        const p = protegerEntrada('https://vt.tiktok.example/AbCd12345/', envPath, ctxSenha);
        assert(p.guardados.length === 0 && p.texto === 'https://vt.tiktok.example/AbCd12345/',
            'protegerEntrada preserva o link intacto sem gravar no cofre', p);
    }

    console.log('\n=== S497-2 — proteção de tokens em link e usuario:senha@host preservada ===');
    {
        const ctxSenha = { ultimaFalaDoAssistente: 'Me envie a senha.' };
        const tokenIcs = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
        const linkIcs = `https://calendar.example/ical/private-${tokenIcs}/basic.ics`;
        const achadosIcs = detectarSegredos(linkIcs, ctxSenha);
        assert(achadosIcs.length === 1 && achadosIcs[0] === tokenIcs,
            'private-<token> continua protegendo só o token (sem engolir o link inteiro), mesmo sob pedido de senha', achadosIcs);

        const tokenQuery = 'Zx8Qw7Er6Ty5Ui4Op3';
        const linkQuery = `https://api.example/v1/dados?token=${tokenQuery}`;
        const achadosQuery = detectarSegredos(linkQuery, ctxSenha);
        assert(achadosQuery.length === 1 && achadosQuery[0] === tokenQuery,
            '?token=… continua protegendo só o token, mesmo sob pedido de senha', achadosQuery);

        const pIcs = protegerEntrada(linkIcs, envPath, ctxSenha);
        assert(pIcs.guardados.length === 1 && pIcs.texto.includes('calendar.example/ical/private-<SEGREDO:') && pIcs.texto.endsWith('/basic.ics'),
            'protegerEntrada mascara só o token e mantém o resto do link legível', pIcs);

        const linkComUserPass = 'https://admin:Xk9!mP2v@painel.example/api';
        assert(detectarSegredos(linkComUserPass, ctxSenha).includes(linkComUserPass),
            'URL com usuario:senha@host na autoridade continua protegida após pedido de senha');
        assert(detectarSegredos(`senha: ${linkComUserPass}`).includes(linkComUserPass),
            'URL com usuario:senha@host na autoridade continua protegida quando rotulada');
    }

    console.log('\n=== S497-3 — plural "tokens" e instrução /segredo_apagar não ativam pedidaAgora ===');
    {
        const resumoFinanceiro = 'Simulação concluída: +168 tokens adicionados. Total: 698 tokens na carteira.';
        const ctxOrcamento = { ultimaFalaDoAssistente: 'O orçamento da chamada foi de 2000 tokens.' };
        assert(detectarSegredos('AbCdEfGhIjK', { ultimaFalaDoAssistente: resumoFinanceiro }).length === 0,
            'plural "tokens" em resumo financeiro não dispara captura da resposta seguinte');
        assert(detectarSegredos('Xk9#mP2vL7', ctxOrcamento).length === 0,
            'plural "tokens" em contexto técnico não dispara captura');
        assert(detectarSegredos('relatorio_2026.pdf', { ultimaFalaDoAssistente: resumoFinanceiro }).length === 0,
            'nome de arquivo após "tokens" não vira segredo');

        const falaDesfazer = 'O detector achou que parte da mensagem era uma senha e guardou como senha_1. Use /segredo_apagar senha_1 e reenvie a mensagem.';
        assert(detectarSegredos('AbCdEfGhIjK', { ultimaFalaDoAssistente: falaDesfazer }).length === 0,
            'instrução com /segredo_apagar não ativa pedidaAgora para a próxima mensagem');
        assert(detectarSegredos('Xk9#mP2vL7', { ultimaFalaDoAssistente: falaDesfazer }).length === 0,
            'laço senha_1 -> senha_2 quebrado quando assistente explica /segredo_apagar');
        assert(detectarSegredos('https://vt.tiktok.example/AbCd12345/', { ultimaFalaDoAssistente: falaDesfazer }).length === 0,
            'reenvio de link após instrução de /segredo_apagar passa intacto');

        assert(detectarSegredos('48291375', { ultimaFalaDoAssistente: 'Qual é o token que chegou por SMS?' }).includes('48291375'),
            'singular "token" em pedido real continua protegendo a resposta');
        assert(detectarSegredos('Xk9#mP2vL7', { ultimaFalaDoAssistente: 'Me envie a senha ou use /segredo gmail <valor>.' }).includes('Xk9#mP2vL7'),
            'pedido que sugere /segredo <nome> <valor> continua protegendo a resposta');
        assert(detectarSegredos('Xk9#mP2vL7', { ultimaFalaDoAssistente: 'Já tenho <SEGREDO:email>, agora me envie a senha do painel.' }).includes('Xk9#mP2vL7'),
            'fala com marcador <SEGREDO:...> que pede outra senha continua protegendo');
    }

    console.log('\n=== S497-4 — janela temporal em SessionManager.ultimaFalaDoAssistente ===');
    {
        const transcriptDir = path.join(dir, 'sessions');
        let ultimaMensagem: { role: string; content: string; created_at?: string } | undefined;
        const fakeMemory = {
            getFacade: () => ({ loadSessionCheckpoints: () => [] }),
            getRecentMessages: (_convId: string, _limit: number) => (ultimaMensagem ? [ultimaMensagem] : []),
        } as unknown as ConstructorParameters<typeof SessionManager>[1];

        const sm = new SessionManager({ transcriptDir }, fakeMemory);
        const key = { channel: 'telegram', userId: 'test-user' };
        const agoraMs = Date.UTC(2026, 10, 22, 14, 43, 47);
        const fmtSqliteUtc = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

        ultimaMensagem = { role: 'assistant', content: 'Qual é a senha?', created_at: fmtSqliteUtc(agoraMs - 5 * 60 * 1000) };
        assert(sm.ultimaFalaDoAssistente(key, agoraMs) === 'Qual é a senha?',
            'fala do assistente de 5 min atrás (formato SQLite UTC) permanece válida');

        ultimaMensagem = { role: 'assistant', content: 'Qual é a senha?', created_at: fmtSqliteUtc(agoraMs - SessionManager.JANELA_FALA_ANTERIOR_MS) };
        assert(sm.ultimaFalaDoAssistente(key, agoraMs) === 'Qual é a senha?',
            'fala no limite exato da janela de 30 min permanece válida');

        ultimaMensagem = { role: 'assistant', content: 'Qual é a senha?', created_at: fmtSqliteUtc(agoraMs - (SessionManager.JANELA_FALA_ANTERIOR_MS + 1000)) };
        assert(sm.ultimaFalaDoAssistente(key, agoraMs) === null,
            'fala expirada (> 30 min) retorna null');

        ultimaMensagem = { role: 'assistant', content: 'Simulação com tokens.', created_at: fmtSqliteUtc(agoraMs - 11 * 60 * 60 * 1000) };
        assert(sm.ultimaFalaDoAssistente(key, agoraMs) === null,
            'fala do assistente de 11 horas atrás retorna null');

        ultimaMensagem = { role: 'assistant', content: 'Qual é a senha?' };
        assert(sm.ultimaFalaDoAssistente(key, agoraMs) === 'Qual é a senha?',
            'sem created_at mantém fail-safe retornando o conteúdo');

        ultimaMensagem = { role: 'user', content: 'Qual é a senha?', created_at: fmtSqliteUtc(agoraMs - 60 * 1000) };
        assert(sm.ultimaFalaDoAssistente(key, agoraMs) === null,
            'última mensagem do usuário retorna null');
    }

    console.log('\n=== S497-5 — detecção linear em link longo (sem ReDoS) ===');
    {
        const urlGigante = 'https://' + 'a'.repeat(200_000);
        const t0 = Date.now();
        const achados = detectarSegredos(urlGigante, { ultimaFalaDoAssistente: 'Me envie a senha.' });
        const ms = Date.now() - t0;
        assert(ms < 500 && achados.length === 0, `URL de 200 mil chars avaliada em ${ms} ms sem falso positivo`, { ms, achados });
    }
} finally {
    for (const k of Object.keys(process.env)) if (!(k in envAntes)) delete process.env[k];
    Object.assign(process.env, envAntes);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S497 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
process.exit(failed > 0 ? 1 : 0);
