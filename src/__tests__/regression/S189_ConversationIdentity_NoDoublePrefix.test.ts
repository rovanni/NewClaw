/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S189
 *
 * Defeito observado ao dirigir o painel de verdade pelo navegador (04/08/2026), depois de a
 * validação por API não ter pego nada:
 *
 *   GET /api/conversations  →  id: "web:web-session"   (CHAVE DE SESSÃO composta)
 *   o painel adotava esse `id` como id de conversa e o devolvia como `sessionId`
 *   o servidor compunha de novo             →  session_key: "web:web:web-session"
 *
 * Efeito real medido no banco da instância isolada: a mesma conversa passou a existir sob duas
 * chaves (`web:web-session` e `web:web:web-session`), com goals, transcrição e sessão
 * fragmentados entre elas. Não era um problema do card de autorização — foi ele que expôs, ao
 * consultar pendências por conversa e não achar nada.
 *
 * Causa: dois identificadores diferentes com o mesmo nome. O `id` da linha de conversa é a chave
 * composta (`canal:usuário`, SessionKeyFactory); o que o cliente deve devolver é só a parte do
 * usuário. O cliente estava deduzindo a regra de composição — e deduzia errado.
 *
 * O que este teste trava:
 *   1. a invariante de identidade: `id` da conversa web é exatamente
 *      `composeSessionKey({channel:'web', userId: user_id})` — se um dia deixar de ser, o
 *      contrato do painel quebra silenciosamente de novo;
 *   2. `compose`/`parse` fazem round-trip exato mesmo com o valor JÁ composto (o caso que gerou
 *      o prefixo duplo) e com userId contendo ':';
 *   3. a rota devolve `sessionId` explicitamente, para o cliente não precisar deduzir nada;
 *   4. o painel usa `sessionId` (não `id`) como id local e normaliza ids compostos antigos.
 *
 * Execução: npx ts-node src/__tests__/regression/S189_ConversationIdentity_NoDoublePrefix.test.ts
 */

import { composeSessionKey, parseSessionKey } from '../../session/SessionKeyFactory';

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string, detail?: unknown): void {
    if (cond) { console.log(`  OK ${msg}`); passed++; }
    else { console.error(`  FALHOU: ${msg}`, detail ?? ''); failed++; }
}

async function main() {
    console.log('\n=== S189 — identidade de conversa: o painel não pode recompor a chave de sessão ===');

    console.log('\n--- S189.1 — o defeito real, reproduzido em uma linha ---');
    {
        const sessionIdDoCliente = 'web-session';
        const idDaLinhaNoServidor = composeSessionKey({ channel: 'web', userId: sessionIdDoCliente });
        assert(idDaLinhaNoServidor === 'web:web-session',
            'a linha de conversa é gravada com a chave composta', idDaLinhaNoServidor);

        // O painel antigo devolvia o id da linha como se fosse o sessionId:
        const chaveDuplicada = composeSessionKey({ channel: 'web', userId: idDaLinhaNoServidor });
        assert(chaveDuplicada === 'web:web:web-session',
            'devolver o id da linha como sessionId produz o prefixo duplo observado ao vivo', chaveDuplicada);
        assert(chaveDuplicada !== idDaLinhaNoServidor,
            'as duas chaves são DIFERENTES — é isso que fragmenta sessão, transcrição e goals');
    }

    console.log('\n--- S189.2 — o valor que o cliente deve devolver é o userId, e o round-trip é exato ---');
    {
        for (const userId of ['web-session', 'conv_1785849063399', 'powerpoint-addin-abc', 'id:com:dois-pontos']) {
            const composed = composeSessionKey({ channel: 'web', userId });
            const parsed = parseSessionKey(composed);
            assert(parsed.channel === 'web' && parsed.userId === userId,
                `round-trip exato para userId="${userId}"`, parsed);
        }
        // E o caso que importa aqui: parse de uma chave já composta devolve o userId original,
        // que é exatamente a normalização que o painel aplica em ids antigos do localStorage.
        assert(parseSessionKey('web:web:web-session').userId === 'web:web-session',
            'parse de uma chave duplicada devolve a chave de um nível só (base da migração do painel)');
    }

    console.log('\n--- S189.3 — a rota diz explicitamente qual valor devolver ---');
    {
        const fs = require('fs');
        const path = require('path');
        const routeSrc = fs.readFileSync(path.join(__dirname, '../../dashboard/routes/conversations.ts'), 'utf-8');
        assert(/sessionId:\s*c\.user_id/.test(routeSrc),
            'GET /api/conversations devolve sessionId = user_id (cliente não deduz a composição)');
        assert(/listWebConversations\(\)/.test(routeSrc),
            'continua usando a consulta existente — o campo é aditivo, não uma rota nova');
    }

    console.log('\n--- S189.4 — o painel usa sessionId e normaliza ids compostos antigos ---');
    {
        const fs = require('fs');
        const path = require('path');
        const uiSrc = fs.readFileSync(path.join(__dirname, '../../dashboard/public/index.html'), 'utf-8');
        assert(/sc\.sessionId\s*\|\|\s*sc\.user_id\s*\|\|\s*sc\.id/.test(uiSrc),
            'a sincronização usa sessionId como id local (com fallback para servidor antigo)');
        assert(/serverId:\s*sc\.id/.test(uiSrc),
            'o id da linha do servidor é preservado em serverId — buscar mensagens continua funcionando');
        assert(/migrateComposedConversationIds/.test(uiSrc),
            'ids compostos já gravados no localStorage são normalizados na carga');
        assert(!/id:\s*sc\.id,\s*title:\s*sc\.id/.test(uiSrc),
            'a atribuição antiga (id = id da linha) não existe mais');
    }

    console.log('\n--- S189.5 — goal parado esperando decisão não é "trabalho em andamento" ---');
    {
        // Observado ao dirigir o painel: um goal `blocked` aparecia em /api/chat/active, a tela
        // exibia "processando" e o botão de enviar ficava em modo "Parar" — o usuário não
        // conseguia nem responder à autorização que o próprio sistema estava pedindo.
        const fs = require('fs');
        const path = require('path');
        const chatRouteSrc = fs.readFileSync(path.join(__dirname, '../../dashboard/routes/chat.ts'), 'utf-8');
        assert(/if\s*\(g\.status === 'blocked'\)\s*continue;/.test(chatRouteSrc),
            'goal blocked não entra na lista de ativos — quem representa esse estado é pendingAuth');
        assert(/pendingAuth/.test(chatRouteSrc),
            'a mesma resposta carrega as pendências de autorização da conversa');
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S189 RESULTADO: ${passed} passou | ${failed} falhou`);
    if (failed > 0) process.exit(1);
    process.exit(0);
}

main().catch(err => { console.error('Erro no teste S189:', err); process.exit(1); });
