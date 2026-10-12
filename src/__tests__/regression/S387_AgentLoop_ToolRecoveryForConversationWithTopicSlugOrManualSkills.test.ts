/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S387 (Sprint S5 / P2)
 *
 * Incidente real em produção (11/10/2026, turno "E meus e-mails alguma novidade?"):
 * O roteador classificou a mensagem como 'conversation' com topicSlug='check_email' e confiança 0.85.
 * A categoria 'conversation' tinha extras=[], e como preferredTools de skills manuais não era repassado,
 * o AgentLoop removeu 'exec_command' do pool de ferramentas, ficando impossibilitado de rodar a checagem real.
 *
 * Este teste valida:
 *   1 → Quando category='conversation' tem confiança >= 0.65 mas possui um topicSlug operacional (ex: 'check_email'),
 *       buildToolDefs não tranca as ferramentas: envia todas as ferramentas disponíveis para evitar bloqueio;
 *   2 → Quando skills manuais são correspondidas (com tools declaradas como 'exec_command'), essas ferramentas
 *       são adicionadas a preferredTools e liberadas pelo filtro de ferramentas;
 *   3 → Conversa pura (sem topicSlug, sem skills correspondidas) continua restrita apenas às CORE_TOOLS (comportamento original preservado).
 *
 * Execução: npx ts-node src/__tests__/regression/S387_AgentLoop_ToolRecoveryForConversationWithTopicSlugOrManualSkills.test.ts
 */
process.env.WORKSPACE_DIR = process.env.WORKSPACE_DIR || 'D:/IA/newclaw/workspace';

import { AgentLoop } from '../../loop/AgentLoop';
import type { IntentDecision } from '../../loop/UnifiedIntentRouter';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

// Simulador de AgentLoop com as ferramentas padrão
const fakeTools = new Map<string, { name: string; description: string; parameters: Record<string, unknown> }>([
    ['write', { name: 'write', description: 'escrever', parameters: {} }],
    ['read', { name: 'read', description: 'ler', parameters: {} }],
    ['edit', { name: 'edit', description: 'editar', parameters: {} }],
    ['send_document', { name: 'send_document', description: 'doc', parameters: {} }],
    ['send_audio', { name: 'send_audio', description: 'audio', parameters: {} }],
    ['send_image', { name: 'send_image', description: 'img', parameters: {} }],
    ['memory_search', { name: 'memory_search', description: 'mem search', parameters: {} }],
    ['memory_write', { name: 'memory_write', description: 'mem write', parameters: {} }],
    ['exec_command', { name: 'exec_command', description: 'exec', parameters: {} }],
    ['web_search', { name: 'web_search', description: 'web', parameters: {} }],
    ['weather', { name: 'weather', description: 'clima', parameters: {} }],
]);

const build = (intent: Partial<IntentDecision>, hostTools: string[] = []): string[] => {
    const fakeLoop = {
        tools: fakeTools,
    };
    const res = (AgentLoop.prototype as unknown as { buildToolDefs: (i: unknown, h?: string[]) => Array<{ name: string }> })
        .buildToolDefs.call(fakeLoop, intent, hostTools);
    return res.map(t => t.name);
};

console.log('\n[1] Conversa pura (sem topicSlug) — continua restrita às CORE_TOOLS');
{
    const tools = build({ category: 'conversation', confidence: 0.85 });
    assert(!tools.includes('exec_command'), 'exec_command bloqueado na conversa pura');
    assert(!tools.includes('web_search'), 'web_search bloqueado na conversa pura');
    assert(tools.includes('read') && tools.includes('memory_search'), 'CORE_TOOLS disponíveis');
}

console.log('\n[2] Conversa com topicSlug operacional (ex: check_email) — evita bloqueio e envia todas as ferramentas');
{
    const tools = build({ category: 'conversation', confidence: 0.85, topicSlug: 'check_email' });
    assert(tools.includes('exec_command'), 'exec_command disponível quando há topicSlug operacional');
    assert(tools.includes('web_search'), 'web_search disponível quando há topicSlug operacional');
    assert(tools.length === fakeTools.size, 'todas as ferramentas enviadas para segurança');
}

console.log('\n[3] Conversa com preferredTools (vindo de skill aprendida ou manual)');
{
    const tools = build({ category: 'conversation', confidence: 0.85, preferredTools: ['exec_command'] });
    assert(tools.includes('exec_command'), 'exec_command incluído via preferredTools da skill');
    assert(!tools.includes('web_search'), 'ferramenta não solicitada pela skill continua restrita');
}

console.log(`\n${passed} passaram, ${failed} falharam`);
process.exit(failed > 0 ? 1 : 0);
