/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S270
 *
 * Campanha "sugestão de skill" (26/08/2026): a instância real do usuário tinha 34 combinações
 * (padrão, ferramenta) elegíveis em `skill_patterns` (≥3 sucessos, ≥80% taxa) e ZERO propostas
 * novas em 7 semanas. Causa raiz: `SkillLearner.extractPattern()` classificava o texto do usuário
 * via regex num de 7 padrões fixos — decisão semântica tratada como validação estrutural, proibida
 * por `docs/ARCHITECTURE/RESPONSABILIDADE_ANTES_DO_MECANISMO.md` — e o vocabulário fechado
 * significava que, uma vez que as 7 categorias já tivessem virado skill ativa (como em produção),
 * o mecanismo nunca mais propunha nada novo.
 *
 * Investigação Fase 1-5 (mesma sessão) concluiu: `UnifiedIntentRouter` já roda um LLM por turno
 * (para rotear a mensagem) — a correção faz essa MESMA chamada também emitir um `topicSlug` livre,
 * e `SkillLearner.recordPattern()` passa a recebê-lo já computado, em vez de recalculá-lo via
 * regex. Zero chamadas de LLM novas (reaproveita a classificação que já acontece); determinismo
 * aqui volta a ser só validação de FORMATO (nunca reinterpretação do texto do usuário).
 *
 * Este teste cobre:
 *   1. Fonte única — SKILL_DEFS e KNOWN_SKILL_TOPICS não podem divergir (o compilador já barra
 *      isso; aqui provamos em runtime também).
 *   2. buildClassificationMessages() (função pura) inclui a instrução de topicSlug e a lista de
 *      slugs conhecidos no prompt enviado ao LLM.
 *   3. UnifiedIntentRouter.route() (LLM mockado, mesmo padrão do S217) propaga um topicSlug
 *      bem-formado do LLM até o IntentDecision final.
 *   4. Um topicSlug malformado declarado pelo LLM é descartado (validação estrutural, não
 *      confiança cega no que o LLM disse).
 *   5. SkillLearner.recordPattern() só grava quando recebe um topicSlug válido — ausência ou
 *      formato inválido não gravam nada (NUNCA_ADIVINHAR: sem o slug, sem decisão).
 *   6. Reprodução do achado: um topicSlug NOVO (fora de KNOWN_SKILL_TOPICS) agora consegue virar
 *      proposta de skill — caminho que extractPattern() nunca alcançava na prática.
 *
 * Execução: npx ts-node src/__tests__/regression/S270_SkillLearner_TopicSlugFromRouter.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { SkillLearner } from '../../loop/SkillLearner';
import { UnifiedIntentRouter, buildClassificationMessages } from '../../loop/UnifiedIntentRouter';
import { KNOWN_SKILL_TOPICS } from '../../shared/domainTypes';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  OK ${message}`); passed++; }
    else { console.error(`  FALHOU: ${message}`, detail ?? ''); failed++; }
}

function fakeProviderFactory(content: string) {
    return {
        chatWithFallback: async () => ({ status: 'success', content, attempts: [] }),
    } as unknown as import('../../core/ProviderFactory').ProviderFactory;
}

async function main(): Promise<void> {

console.log('\n=== S270-1 — SKILL_DEFS (SkillLearner) e KNOWN_SKILL_TOPICS (domainTypes) não divergem ===');
{
    const skillLearnerSrc = fs.readFileSync(path.join(process.cwd(), 'src', 'loop', 'SkillLearner.ts'), 'utf-8');
    // O compilador já barra isso (SKILL_DEFS é tipado como Record<typeof KNOWN_SKILL_TOPICS[number], ...>)
    // — aqui confirmamos a intenção declarada no código (o tipo referencia a constante, não a duplica).
    assert(
        /SKILL_DEFS: Record<typeof KNOWN_SKILL_TOPICS\[number\]/.test(skillLearnerSrc),
        'SKILL_DEFS é tipado a partir de KNOWN_SKILL_TOPICS — uma única fonte, divergência vira erro de compilação',
    );
    for (const topic of KNOWN_SKILL_TOPICS) {
        assert(new RegExp(`\\b${topic}:\\s*\\{`).test(skillLearnerSrc), `SKILL_DEFS tem uma entrada para o topic conhecido "${topic}"`);
    }
}

console.log('\n=== S270-2 — buildClassificationMessages() instrui o LLM sobre topicSlug e lista os slugs conhecidos ===');
{
    const messages = buildClassificationMessages('o que é deepseek harness?');
    const systemMsg = messages.find(m => m.role === 'system');
    assert(!!systemMsg, 'mensagem de sistema existe');
    const content = systemMsg?.content ?? '';
    assert(content.includes('topicSlug'), 'prompt menciona "topicSlug" (campo novo no schema)');
    for (const topic of KNOWN_SKILL_TOPICS) {
        assert(content.includes(topic), `prompt lista o slug conhecido "${topic}" como preferência`);
    }
    assert(/Omit "topicSlug" entirely for general conversation/.test(content), 'prompt instrui a OMITIR o slug para conversa geral — ausência é saída válida, não adivinhação');

    // Mesma verificação no caminho COM histórico (buildClassificationMessages com contexto) —
    // o bridge precisa aparecer nos dois pontos de montagem do prompt, não só no primeiro.
    const messagesComContexto = buildClassificationMessages('continue', {
        recentMessages: [
            { role: 'user', content: 'oi' },
            { role: 'assistant', content: 'Olá! Como posso ajudar?' },
        ],
    } as any);
    const systemComContexto = messagesComContexto.find(m => m.role === 'system')?.content ?? '';
    assert(systemComContexto.includes('topicSlug'), 'prompt COM histórico de conversa também inclui a instrução de topicSlug');
}

console.log('\n=== S270-3 — UnifiedIntentRouter.route() propaga um topicSlug bem-formado do LLM até o IntentDecision final ===');
{
    const router = new UnifiedIntentRouter(undefined, fakeProviderFactory(
        JSON.stringify({ category: 'data_analysis', cognitiveLoad: 'normal', confidence: 0.9, topicSlug: 'crypto_price' })
    ));
    const decision = await router.route('quanto vale bitcoin agora?');
    assert(decision.topicSlug === 'crypto_price', `topicSlug bem-formado chega ao IntentDecision final (recebido: "${decision.topicSlug}")`);
}

console.log('\n=== S270-4 — topicSlug malformado declarado pelo LLM é descartado (validação estrutural, não confiança cega) ===');
{
    const casosInvalidos = ['CRYPTO PRICE', 'crypto-price!!', '1abc', 'a', 'x'.repeat(50)];
    for (const invalido of casosInvalidos) {
        const router = new UnifiedIntentRouter(undefined, fakeProviderFactory(
            JSON.stringify({ category: 'information', cognitiveLoad: 'normal', confidence: 0.8, topicSlug: invalido })
        ));
        const decision = await router.route('mensagem qualquer');
        assert(decision.topicSlug === undefined, `topicSlug malformado "${invalido}" é descartado, não repassado cru`, decision.topicSlug);
    }
}

console.log('\n=== S270-5 — SkillLearner.recordPattern() só grava com topicSlug válido (ausência/formato inválido não gravam nada) ===');
{
    const db = new (Database as any)(':memory:');
    const learner = new SkillLearner(db, path.join(process.cwd(), '__no_skills_dir__'));

    learner.recordPattern('web_search', true, 100); // sem topicSlug
    learner.recordPattern('web_search', true, 100, undefined); // explicitamente ausente
    learner.recordPattern('web_search', true, 100, 'INVALIDO SLUG!'); // malformado

    const count = db.prepare('SELECT COUNT(*) as c FROM skill_patterns').get() as { c: number };
    assert(count.c === 0, `nenhuma linha gravada em skill_patterns sem topicSlug válido (encontrado: ${count.c})`);

    learner.recordPattern('web_search', true, 100, 'crypto_price');
    const countDepois = db.prepare('SELECT COUNT(*) as c FROM skill_patterns').get() as { c: number };
    assert(countDepois.c === 1, 'com topicSlug válido, a linha É gravada normalmente');

    db.close();
}

console.log('\n=== S270-6 — reprodução do achado: um topicSlug NOVO (fora de KNOWN_SKILL_TOPICS) vira proposta de skill ===');
{
    const db = new (Database as any)(':memory:');
    const learner = new SkillLearner(db, path.join(process.cwd(), '__no_skills_dir__'));

    const novoSlug = 'translate_text'; // não está em KNOWN_SKILL_TOPICS
    assert(!(KNOWN_SKILL_TOPICS as readonly string[]).includes(novoSlug), 'sanity: o slug do teste realmente não é um dos 7 conhecidos');

    for (let i = 0; i < 3; i++) {
        learner.recordPattern('web_search', true, 100, novoSlug);
    }
    // Dispara tryCreateSkillProposal (a cada múltiplo de 10 chamadas) — recheio com o mesmo slug
    // válido, já maduro o bastante (≥3 sucessos, 100%).
    for (let i = 0; i < 7; i++) {
        learner.recordPattern('web_search', true, 100, novoSlug);
    }

    const propostas = learner.getAllSkills().filter(s => s.source_pattern === novoSlug);
    assert(propostas.length === 1, `um topicSlug novo e maduro vira exatamente 1 proposta (achado original: isso NUNCA acontecia via extractPattern)`, propostas.map(s => s.name));
    assert(propostas[0]?.status === 'proposed', 'a proposta fica pendente de revisão manual — nunca ativa automaticamente');

    db.close();
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S270 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exit(1);

}

main().catch(err => { console.error('ERRO NÃO TRATADO:', err); process.exit(1); });
