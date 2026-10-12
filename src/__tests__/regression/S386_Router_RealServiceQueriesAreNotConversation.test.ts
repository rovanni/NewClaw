/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S386 (Sprint S4 / P1)
 *
 * Incidente real em produção (11/10/2026, turno "E meus e-mails alguma novidade?"):
 * O classificador rotulou a consulta como 'conversation' (confiança 0.85),
 * privando o AgentLoop de ferramentas de sistema (exec_command) e causando alucinação.
 *
 * Este teste valida:
 *   1 → buildClassificationMessages instrui que pedidos para checar dados reais, e-mails, contas ou serviços
 *       NUNCA são 'conversation' e pertencem à categoria funcional (system_operation ou information);
 *   2 → Em fallback semântico (semanticRoute), queries sobre email/gmail/inbox caem em 'system_operation',
 *       não em 'conversation', mesmo terminando com interrogação '?';
 *   3 → O schema de categorias instrui claramente o modelo sobre a distinção.
 *
 * Execução: npx ts-node src/__tests__/regression/S386_Router_RealServiceQueriesAreNotConversation.test.ts
 */
process.env.WORKSPACE_DIR = process.env.WORKSPACE_DIR || 'D:/IA/newclaw/workspace';

import { UnifiedIntentRouter, buildClassificationMessages } from '../../loop/UnifiedIntentRouter';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

console.log('\n[1] buildClassificationMessages — instruções semânticas no prompt do classificador');
{
    const msgsSemContexto = buildClassificationMessages('E meus e-mails alguma novidade?');
    const sysSem = msgsSemContexto.find(m => m.role === 'system')?.content ?? '';
    assert(/emails|inboxes|gmail/i.test(sysSem), 'system_operation descreve checagem de emails/inbox/gmail');
    assert(/NEVER conversation|NUNCA como conversation/i.test(sysSem), 'instrui explicitamente que checagens de dados/serviços reais não são conversation');

    const msgsComContexto = buildClassificationMessages('E meus e-mails alguma novidade?', {
        recentMessages: [
            { role: 'user', content: 'Qual a previsão do tempo?' },
            { role: 'assistant', content: 'Tempo bom em Belo Horizonte.' },
        ],
    });
    const sysCom = msgsComContexto.find(m => m.role === 'system')?.content ?? '';
    assert(/NUNCA como conversation/i.test(sysCom), 'prompt contextual instrui que pedidos de contas/e-mails não são conversation');
}

console.log('\n[2] semanticRoute (fallback por keywords) — queries de e-mail não caem em conversation');
{
    const router = new UnifiedIntentRouter(); // sem ProviderFactory → usa semanticRoute
    const dec1 = router.routeSync('E meus e-mails alguma novidade?');
    assert(dec1.category === 'system_operation', `consulta de e-mail com '?' vira system_operation no fallback (foi ${dec1.category})`);

    const dec2 = router.routeSync('verificar minha caixa de mensagens do gmail');
    assert(dec2.category === 'system_operation', `verificar gmail vira system_operation no fallback (foi ${dec2.category})`);

    const dec3 = router.routeSync('inbox status');
    assert(dec3.category === 'system_operation', `inbox status vira system_operation no fallback (foi ${dec3.category})`);
}

console.log(`\n${passed} passaram, ${failed} falharam`);
process.exit(failed > 0 ? 1 : 0);
