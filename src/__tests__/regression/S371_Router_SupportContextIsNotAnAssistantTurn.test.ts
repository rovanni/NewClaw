/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S371 (campanha 09/10/2026, log de 11:24:39)
 *
 * Primeira mensagem da sessão ("Vai chover hoje?"): o GoalOrchestrator injetou o bloco de preferências salvas
 * como uma volta `assistant` em `recentMessages`. O roteador o tratou como "a última resposta real do
 * assistente" e o modelo local respondeu repetindo "[PREFERÊNCIAS…" (1361 caracteres, o tamanho do bloco) em
 * vez de JSON: parse falhou, fallback por palavras decidiu `conversation → direct` (errado) e 15 s se perderam.
 * Fato do sistema não é fala da conversa.
 *
 * REGRESSÃO SE: o GoalOrchestrator voltar a passar fatos de apoio ao roteador como mensagens de conversa; ou o
 * roteador deixar de rotular o contexto de apoio / de chamá-lo de "última resposta do assistente"; ou o contexto
 * de apoio sair da chave de cache (duas sessões com preferências diferentes dividiriam a mesma classificação).
 *
 * Execução: npx ts-node src/__tests__/regression/S371_Router_SupportContextIsNotAnAssistantTurn.test.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { UnifiedIntentRouter, buildClassificationMessages } from '../../loop/UnifiedIntentRouter';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

const BLOCO = '[PREFERÊNCIAS SALVAS DO USUÁRIO — aplique cada uma somente quando o pedido tratar do assunto dela]\n• Clima padrão: cidade X';

async function main(): Promise<void> {

console.log('\n=== S371-1 — sem histórico: o apoio vai no system prompt, rotulado, íntegro; não há volta do assistente ===');
{
    const msgs = buildClassificationMessages('Vai chover hoje?', { contextoDeApoio: [BLOCO] });
    const system = msgs.find(m => m.role === 'system')?.content ?? '';
    assert(msgs.length === 2 && msgs[0].role === 'system' && msgs[1].role === 'user', 'só system + a mensagem atual', msgs.map(m => m.role));
    assert(system.includes(BLOCO), 'o bloco chega inteiro ao classificador');
    assert(/NÃO são mensagens da conversa/.test(system), 'rotulado como fato do sistema, não como conversa');
    assert(!system.includes('A última resposta real do assistente'), 'não é apresentado como resposta do assistente');
    assert(msgs.every(m => m.role !== 'assistant'), 'nenhuma volta do assistente inventada');
}

console.log('\n=== S371-2 — com histórico: a última resposta real continua sendo a real; o apoio vem à parte ===');
{
    const msgs = buildClassificationMessages('e amanhã?', {
        recentMessages: [{ role: 'user', content: 'Vai chover hoje?' }, { role: 'assistant', content: 'Sim, 80% de chuva à tarde.' }],
        contextoDeApoio: [BLOCO],
    });
    const system = msgs.find(m => m.role === 'system')?.content ?? '';
    assert(system.includes('Sim, 80% de chuva à tarde.'), 'a última resposta real do assistente é a da conversa');
    assert(system.includes(BLOCO) && /NÃO são mensagens da conversa/.test(system), 'o apoio está presente e rotulado');
    assert(msgs.filter(m => m.role === 'assistant').length === 1, 'só a volta real do assistente', msgs.map(m => m.role));
}

console.log('\n=== S371-3 — sem apoio: o prompt é o de sempre (nenhum rótulo sobrando) ===');
{
    const system = buildClassificationMessages('oi', {}).find(m => m.role === 'system')?.content ?? '';
    assert(!system.includes('Contexto de apoio'), 'sem apoio, sem bloco');
    const vazio = buildClassificationMessages('oi', { contextoDeApoio: ['   ', ''] }).find(m => m.role === 'system')?.content ?? '';
    assert(!vazio.includes('Contexto de apoio'), 'itens em branco não geram bloco');
}

console.log('\n=== S371-4 — route(): o modelo recebe o apoio no system; a chave de cache muda com o apoio ===');
{
    const vistos: string[][] = [];
    const pf = {
        chatWithFallback: async (messages: Array<{ role: string; content: string }>) => {
            vistos.push(messages.map(m => `${m.role}:${m.content}`));
            return { status: 'success', content: JSON.stringify({ category: 'information', cognitiveLoad: 'normal', confidence: 0.9 }), attempts: [] };
        },
    } as unknown as import('../../core/ProviderFactory').ProviderFactory;
    const router = new UnifiedIntentRouter(undefined, pf);
    await router.route('Vai chover hoje?', { sessionId: 's', contextoDeApoio: [BLOCO] });
    assert(vistos.length === 1 && vistos[0].some(l => l.startsWith('system:') && l.includes(BLOCO)), 'o classificador viu o apoio no system', vistos[0]);
    await router.route('Vai chover hoje?', { sessionId: 's', contextoDeApoio: [BLOCO.replace('cidade X', 'cidade Y')] });
    assert(vistos.length === 2, 'apoio diferente = nova classificação (não reaproveita o cache)', vistos.length);
    await router.route('Vai chover hoje?', { sessionId: 's', contextoDeApoio: [BLOCO.replace('cidade X', 'cidade Y')] });
    assert(vistos.length === 2, 'mesmo apoio = cache', vistos.length);
}

console.log('\n=== S371-5 — GoalOrchestrator: o roteador recebe a conversa real e o apoio à parte ===');
{
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'loop', 'GoalOrchestrator.ts'), 'utf-8');
    const chamada = src.slice(src.indexOf('getIntentRouter().route(message'), src.indexOf('getIntentRouter().route(message') + 300);
    assert(/recentMessages,\s*\n\s*contextoDeApoio: apoioDoRoteador/.test(chamada), 'route() recebe recentMessages reais + contextoDeApoio', chamada);
    assert(!/recentMessages: classifyMessages/.test(src), 'classifyMessages (com marcadores) não vai mais ao roteador');
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S371 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;
}

main().catch((err) => { console.error('S371 erro inesperado:', err); process.exitCode = 1; });
