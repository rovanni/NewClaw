/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S237
 * SkillLearner não propõe a mesma skill de padrão CONHECIDO várias vezes, uma por tool incidental.
 *
 * INCIDENTE REAL (15/08/2026): o operador reportou, em /config, dezenas de propostas repetidas —
 * "Consulta Cripto (memory_admin)", "Consulta Cripto (send_document)", "Consulta Cripto
 * (crypto_analysis)", "Consulta Cripto (memory_write)", "Consulta Cripto (memory_search)",
 * "Consulta Cripto (write)", "Consulta Cripto (read)", "Consulta Cripto (weather)" — todas com a
 * MESMA descrição ("Consulta geral sobre criptomoedas com formato consistente.") e o mesmo
 * "· web_search", ao lado de "Consulta Cripto" já ATIVA. Mesmo padrão em "Operações de Arquivo" e
 * "Previsão do Tempo".
 *
 * CAUSA RAIZ: `tryCreateSkillProposal()` classificava cada mensagem num de 7 padrões fixos
 * (`SkillLearner.SKILL_DEFS`) e registrava sucesso em `skill_patterns` por (pattern, tool_name) —
 * onde `tool_name` é QUALQUER tool que rodou com sucesso depois de uma mensagem daquele padrão,
 * não necessariamente a tool usada para atendê-la. Para os 7 padrões conhecidos, o conteúdo da
 * skill final (nome/gatilho/descrição/prompt/tool_sequence) é função só do `pattern` —
 * `createSkillFromPattern` usa `def.toolSeq` do template, ignorando a `toolName` recebida. Mas a
 * checagem "já propus isso antes?" usava `(source_pattern, source_tool)` como identidade — cada
 * tool incidental diferente que cruzasse o limiar (≥3 sucessos, ≥80%) virava uma proposta NOVA
 * com conteúdo idêntico, só desambiguada por sufixo `(tool)` (fix do S185, que resolveu um
 * problema diferente — descarte mudo — sem perceber que a identidade em si estava errada para
 * estes 7 padrões).
 *
 * CORREÇÃO: para padrão conhecido (presente em `SKILL_DEFS`), a identidade de dedup passa a ser
 * só `source_pattern` — uma vez que existe QUALQUER linha (proposta OU ativa) daquele padrão,
 * nenhuma nova proposta é criada, não importa qual tool incidental cruzou o limiar depois. Padrão
 * desconhecido continua chaveado por `(pattern, tool)`, porque ali o conteúdo realmente muda.
 * Uma migração (`cleanupDuplicateKnownPatternProposals`, chamada em `ensureTable()`) remove as
 * duplicatas já gravadas em instâncias existentes, mantendo 1 proposta por `source_pattern`.
 *
 * Execução: npx ts-node src/__tests__/regression/S237_SkillLearner_KnownPatternDedupByPatternOnly.test.ts
 */

import * as path from 'path';
import Database from 'better-sqlite3';
import { SkillLearner } from '../../loop/SkillLearner';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

function seedMaturePattern(db: Database.Database, pattern: string, tool: string, successCount: number): void {
    db.prepare(
        `INSERT INTO skill_patterns (pattern, tool_name, success_count, fail_count, avg_latency_ms)
         VALUES (?, ?, ?, 0, 100)`
    ).run(pattern, tool, successCount);
}

console.log('\n=== S237-1 — reprodução do incidente: várias tools incidentais no mesmo padrão conhecido geram UMA proposta só ===');
{
    const db = new Database(':memory:');
    const learner = new SkillLearner(db, path.join(process.cwd(), '__no_skills_dir__'));

    // Simula o backlog real: mensagens sobre cripto ("river", "bitcoin"...) seguidas por tools
    // incidentais diferentes (write, read, memory_search, memory_admin, web_search), todas
    // maduras o bastante para virar proposta (≥3 sucessos, 100% de taxa).
    const toolsIncidentais = ['web_search', 'write', 'read', 'memory_search', 'memory_admin', 'send_document', 'crypto_analysis', 'memory_write'];
    for (const tool of toolsIncidentais) {
        seedMaturePattern(db, 'crypto_query', tool, 5);
    }

    // Dispara tryCreateSkillProposal indiretamente via recordPattern (privado; chamado a cada
    // múltiplo de 10 registros). recordPattern() só grava quando recebe um topicSlug já validado
    // (26/08/2026: não classifica mais o texto via regex — ver domainTypes.KNOWN_SKILL_TOPICS) —
    // por isso o "recheio" passa 'audio_request' explicitamente, irrelevante para esta asserção.
    for (let i = 0; i < 10; i++) {
        learner.recordPattern('noop_tool', true, 10, 'audio_request');
    }

    const skills = learner.getAllSkills();
    const consultaCripto = skills.filter(s => s.name.startsWith('Consulta Cripto'));

    assert(consultaCripto.length === 1, 'exatamente UMA proposta "Consulta Cripto" foi criada, não uma por tool incidental', consultaCripto.map(s => s.name));
    assert(
        consultaCripto.length > 0 && consultaCripto[0].name === 'Consulta Cripto',
        'o nome não carrega sufixo de tool — não há colisão a desambiguar para padrão conhecido',
        consultaCripto.map(s => s.name),
    );

    db.close();
}

console.log('\n=== S237-2 — skill ATIVA de um padrão conhecido bloqueia novas propostas do mesmo padrão ===');
{
    const db = new Database(':memory:');
    const learner = new SkillLearner(db, path.join(process.cwd(), '__no_skills_dir__'));

    // Simula uma skill já aprovada (ativa) para 'weather', vinda de uma tool incidental diferente
    // da que vai amadurecer a seguir.
    db.prepare(
        `INSERT INTO auto_skills (id, name, trigger, description, prompt, tool_sequence, priority, hits, status, source_pattern, source_tool, created_at, updated_at)
         VALUES ('skill_weather_1', 'Previsão do Tempo', '(clima|tempo)', 'desc', 'prompt', '["weather"]', 10, 5, 'active', 'weather', 'weather', datetime('now'), datetime('now'))`
    ).run();

    seedMaturePattern(db, 'weather', 'web_search', 5);
    for (let i = 0; i < 10; i++) {
        learner.recordPattern('noop_tool', true, 10, 'audio_request');
    }

    const previsoes = learner.getAllSkills().filter(s => s.name.startsWith('Previsão do Tempo'));
    assert(previsoes.length === 1, 'nenhuma proposta nova foi criada — já existe skill ATIVA para o padrão "weather"', previsoes.map(s => `${s.name}:${s.status}`));

    db.close();
}

console.log('\n=== S237-3 — padrão DESCONHECIDO continua propondo uma vez por tool (conteúdo realmente muda) ===');
{
    const db = new Database(':memory:');
    const learner = new SkillLearner(db, path.join(process.cwd(), '__no_skills_dir__'));

    // Insere diretamente em skill_patterns (em vez de via recordPattern) só para isolar esta
    // asserção da parte de classificação — desde 26/08/2026 recordPattern aceita qualquer
    // topicSlug bem-formado vindo do UnifiedIntentRouter, não só os 7 de KNOWN_SKILL_TOPICS (ver
    // S270), então "padrão desconhecido" também é alcançável pelo caminho real agora.
    seedMaturePattern(db, 'padrao_customizado_xyz', 'read', 5);
    seedMaturePattern(db, 'padrao_customizado_xyz', 'write', 5);
    for (let i = 0; i < 10; i++) {
        learner.recordPattern('noop_tool', true, 10, 'audio_request');
    }

    const customizadas = learner.getAllSkills().filter(s => s.source_pattern === 'padrao_customizado_xyz');
    assert(customizadas.length === 2, 'padrão desconhecido: duas tools diferentes ainda geram duas propostas (conteúdo diferente)', customizadas.map(s => `${s.name}:${s.source_tool}`));
    assert(new Set(customizadas.map(s => s.name)).size === 2, 'os nomes das duas propostas são desambiguados (sufixo de tool)', customizadas.map(s => s.name));

    db.close();
}

console.log('\n=== S237-4 — migração remove duplicatas já existentes no banco, mantendo 1 por padrão conhecido ===');
{
    const db = new Database(':memory:');
    // Primeira instância só para criar o schema (auto_skills/skill_patterns).
    new SkillLearner(db, path.join(process.cwd(), '__no_skills_dir__'));

    // Injeta o estado "sujo" pré-fix: 4 propostas de 'crypto_query' com sufixos de tool diferentes,
    // exatamente como o operador reportou.
    const sufixos = ['web_search', 'read', 'write', 'memory_search'];
    sufixos.forEach((tool, i) => {
        db.prepare(
            `INSERT INTO auto_skills (id, name, trigger, description, prompt, tool_sequence, priority, hits, status, source_pattern, source_tool, created_at, updated_at)
             VALUES (?, ?, '(bitcoin)', 'desc', 'prompt', '["web_search"]', ?, 0, 'proposed', 'crypto_query', ?, datetime('now', '+' || ? || ' seconds'), datetime('now'))`
        ).run(`dup_${i}`, i === 0 ? 'Consulta Cripto' : `Consulta Cripto (${tool})`, 10 - i, tool, i);
    });

    // Reabrir o SkillLearner sobre o MESMO banco reexecuta ensureTable() → a migração de limpeza.
    const learnerReaberto = new SkillLearner(db, path.join(process.cwd(), '__no_skills_dir__'));

    const restantes = learnerReaberto.getAllSkills().filter(s => s.source_pattern === 'crypto_query' && s.status === 'proposed');
    assert(restantes.length === 1, 'depois de reabrir, sobra apenas 1 proposta "Consulta Cripto" — as duplicatas antigas foram limpas', restantes.map(s => s.name));

    db.close();
}

console.log('\n=== S237-5 — migração remove proposta que sobrevive ao lado de skill JÁ ATIVA do mesmo padrão ===');
{
    // Reprodução exata do que sobrou no banco de produção após o primeiro deploy deste fix
    // (15/08/2026): "Consulta Cripto" ATIVA e "Consulta Cripto (read)" ainda PROPOSTA — a primeira
    // versão da migração só deduplicava propostas ENTRE SI, nunca comparava contra o que já
    // estava ativo.
    const db = new Database(':memory:');
    new SkillLearner(db, path.join(process.cwd(), '__no_skills_dir__'));

    db.prepare(
        `INSERT INTO auto_skills (id, name, trigger, description, prompt, tool_sequence, priority, hits, status, source_pattern, source_tool, created_at, updated_at)
         VALUES ('ativa_crypto', 'Consulta Cripto', '(bitcoin)', 'desc', 'prompt', '["web_search"]', 10, 200, 'active', 'crypto_query', 'web_search', datetime('now'), datetime('now'))`
    ).run();
    db.prepare(
        `INSERT INTO auto_skills (id, name, trigger, description, prompt, tool_sequence, priority, hits, status, source_pattern, source_tool, created_at, updated_at)
         VALUES ('sobra_crypto', 'Consulta Cripto (read)', '(bitcoin)', 'desc', 'prompt', '["web_search"]', 9, 0, 'proposed', 'crypto_query', 'read', datetime('now'), datetime('now'))`
    ).run();

    const learnerReaberto = new SkillLearner(db, path.join(process.cwd(), '__no_skills_dir__'));

    const doPattern = learnerReaberto.getAllSkills().filter(s => s.source_pattern === 'crypto_query');
    assert(doPattern.length === 1, 'sobra só a skill ATIVA — a proposta redundante foi removida na migração', doPattern.map(s => `${s.name}:${s.status}`));
    assert(doPattern[0]?.status === 'active' && doPattern[0]?.name === 'Consulta Cripto', 'a que sobrevive é a ativa original, intacta', doPattern);

    db.close();
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S237 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exit(1);
process.exit(0);
