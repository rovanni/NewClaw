/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S396 (Sprint 6, campanha de 14/10/2026)
 * `/skill_approve` e `/skill_reject` pelo chat fazem o mesmo que os botões do painel: passam pelo SkillLearner, que
 * escreve (aprovar) ou apaga (rejeitar) o SKILL.md — o arquivo que o SkillLoader de fato lê.
 *
 * DEFEITO: os comandos só mudavam o `status` no banco (memoryFacade.setAutoSkillStatus). Uma skill aprovada pelo chat
 * ficava "ativa" no banco e nunca chegava ao agente (sem SKILL.md); uma rejeitada pelo chat continuava sendo usada (o
 * SKILL.md ficava). O painel já fazia certo (POST /api/skills/auto/:id/approve|reject → skillLearner).
 *
 * REGRESSÃO SE: o comando voltar a mexer só no banco; ou aprovar algo que não está proposto.
 *
 * Execução: npx ts-node src/__tests__/regression/S396_SkillCommands_SameFileFlowAsDashboard.test.ts
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import { SkillLearner } from '../../loop/SkillLearner';
import { registerCommands } from '../../core/agentControllerCommands';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

async function main(): Promise<void> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-s396-'));
    const db = new Database(':memory:');
    const learner = new SkillLearner(db, dir);
    const id = 'skill-proposta-abc123';
    db.prepare(`INSERT INTO auto_skills (id, name, trigger, description, prompt, status) VALUES (?, ?, ?, ?, ?, 'proposed')`)
        .run(id, 'Teste S396', 'gatilho', 'descrição', 'procedimento');

    // Fachada mínima: o que os dois comandos usam dela (achar o id pelo sufixo; o caminho antigo, só banco).
    const memoryFacade = {
        findAutoSkillIdBySuffix: (s: string) => (db.prepare('SELECT id FROM auto_skills').all() as Array<{ id: string }>).map(r => r.id).find(i => i.endsWith(s)) ?? null,
        setAutoSkillStatus: (i: string, st: string) => db.prepare('UPDATE auto_skills SET status = ? WHERE id = ?').run(st, i).changes > 0,
    };
    const handlers = new Map<string, (msg: { text: string }) => Promise<string | null>>();
    const bus = { registerCommand: (c: string, h: any) => handlers.set(c, h), registerPriorityCommand: () => {} };
    const silencio = process.stdout.write.bind(process.stdout);
    (process.stdout.write as unknown) = (): boolean => true;
    try {
        registerCommands(bus as any, {} as any, memoryFacade as any, {} as any, { } as any, {} as any, {} as any, {} as any, learner);
    } catch { /* outras dependências não importam aqui */ }
    finally { process.stdout.write = silencio; }

    const arquivos = () => fs.readdirSync(dir, { recursive: true } as any).map(String).filter(f => f.endsWith('SKILL.md'));

    console.log('\n=== S396-1 — /skill_approve escreve o SKILL.md (como o painel) ===');
    assert(handlers.has('/skill_approve') && handlers.has('/skill_reject'), 'os dois comandos estão registrados');
    const r1 = await handlers.get('/skill_approve')!({ text: '/skill_approve abc123' });
    assert(/aprovada/.test(String(r1)), 'responde que aprovou', r1);
    assert(arquivos().length === 1, 'o SKILL.md foi escrito — é o que o SkillLoader lê', arquivos());
    const linha = db.prepare('SELECT status, file_exported FROM auto_skills WHERE id = ?').get(id) as { status: string; file_exported: number };
    assert(linha.status === 'active' && linha.file_exported === 1, 'banco e arquivo concordam (active, file_exported=1)', linha);

    console.log('\n=== S396-2 — aprovar de novo não finge sucesso ===');
    const r2 = await handlers.get('/skill_approve')!({ text: '/skill_approve abc123' });
    assert(/não está aguardando aprovação/.test(String(r2)), 'só propostas podem ser aprovadas', r2);

    console.log('\n=== S396-3 — /skill_reject apaga o SKILL.md ===');
    const r3 = await handlers.get('/skill_reject')!({ text: '/skill_reject abc123' });
    assert(/rejeitada/.test(String(r3)), 'responde que rejeitou', r3);
    assert(arquivos().length === 0, 'o SKILL.md saiu — a skill rejeitada deixa de ser usada', arquivos());
    assert((db.prepare('SELECT status FROM auto_skills WHERE id = ?').get(id) as { status: string }).status === 'rejected', 'status rejected no banco');

    db.close();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ok */ }
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S396 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    process.exit(failed > 0 ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
