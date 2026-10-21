/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S435
 * A "memória do pedido" (validação de suficiência e resolução de parâmetro do fast path) entrega os nós achados pela busca
 * MESMO com confiança baixa — com a confiança como dado para o LLM ponderar — e a suficiência recebe o resumo das skills
 * mesmo antes de o AgentLoop ter rodado.
 *
 * INCIDENTE REAL (Windows e Linux, 17/10/2026, "quais as novidades de e-mail e agenda?"): o NewClaw perguntou duas vezes
 * "qual e-mail você usa?", mesmo depois de "você já tem na memória!". O registro do juiz de suficiência mostrou
 * `memoria: 0 chars` e `skills: 0 chars`; o campo `faltou` dizia "o conteúdo da memória não foi fornecido". A busca achava
 * os 4 nós do e-mail, mas `memoriaProximaDoPedido` descartava `confidence < 0.60` — e a confiança decai com o tempo (71 de
 * 80 nós ativos abaixo de 0,60 em 21/10). Memória vazia em 46 de 63 chamadas desde 09/10.
 *
 * Execução: npx ts-node src/__tests__/regression/S435_MemoriaDoPedidoSemCorteDeConfianca.test.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { MemoryManager, descreverNoDaMemoria } from '../../memory/MemoryManager';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

console.log('\n=== S435-1 — nó achado com confiança decaída chega a quem decide, com a confiança ===');
{
    const db = new (Database as any)(':memory:');
    const mm = new MemoryManager(db, 'http://mock-ollama:11434');
    mm.addNode({ id: 'acesso_email_1', type: 'infrastructure', name: 'Acesso ao e-mail e agenda',
        content: 'E-mail lido pelo cliente himalaya; agenda lida pelo link ICS salvo em emails-agenda.md', confidence: 0.52 } as any);
    mm.addNode({ id: 'arquivado_1', type: 'fact', name: 'E-mail antigo arquivado',
        content: 'E-mail e agenda de outra conta, desativada', confidence: 0.9 } as any);
    db.prepare("UPDATE memory_nodes SET lifecycle_state = 'ARCHIVED' WHERE id = 'arquivado_1'").run();
    const r = mm.memoriaProximaDoPedido('quais as novidades de e-mail e agenda', 5);
    const achado = r.find(n => n.id === 'acesso_email_1');
    assert(!!achado, 'o nó com confiança 0,52 é devolvido (antes: descartado pelo corte 0,60)', r);
    assert(achado?.confidence !== undefined && Math.abs((achado?.confidence ?? 0) - 0.52) < 0.01, 'a confiança vem junto, como dado', achado);
    assert(!r.some(n => n.id === 'arquivado_1'), 'o estado do nó continua valendo: arquivado não entra');
    const linha = achado ? descreverNoDaMemoria(achado) : '';
    assert(/Acesso ao e-mail e agenda \(confiança registrada 52% — diminui com o tempo sem uso\): E-mail lido/.test(linha), 'a linha diz a confiança e o que ela significa', linha);
    assert(descreverNoDaMemoria({ name: 'x', content: 'y', confidence: null }) === '• x: y', 'sem confiança registrada, a linha não inventa uma');
    db.close();
}

console.log('\n=== S435-2 — os dois consumidores usam a mesma fonte e o mesmo formato ===');
{
    const src = (f: string) => fs.readFileSync(path.join(process.cwd(), 'src', ...f.split('/')), 'utf-8');
    const mmSrc = src('memory/MemoryManager.ts');
    const bloco = mmSrc.slice(mmSrc.indexOf('memoriaProximaDoPedido(texto: string'), mmSrc.indexOf('addPreference('));
    assert(!/confidence\s*>=/.test(bloco), 'memoriaProximaDoPedido não tem corte de confiança');
    assert(/memoriaProximaDoPedido\(pedido, 5\)\.map\(descreverNoDaMemoria\)/.test(src('loop/GoalOrchestrator.ts')), 'suficiência: descreverNoDaMemoria');
    assert(/rows\.map\(descreverNoDaMemoria\)/.test(src('loop/AgentLoop.ts')), 'fast path: descreverNoDaMemoria');
}

console.log('\n=== S435-3 — o resumo das skills da suficiência carrega as skills antes ===');
{
    const ac = fs.readFileSync(path.join(process.cwd(), 'src', 'core', 'AgentController.ts'), 'utf-8');
    assert(/setResumoDasSkills\(\(\) => \{ this\.skillLoader\.loadAll\(\); return this\.skillLoader\.getSkillSummaries\(\); \}\)/.test(ac),
        'loadAll() antes de getSkillSummaries() na fonte da suficiência');
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S435 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
// MemoryManager deixa temporizadores próprios vivos: saída explícita, como nos demais testes que o instanciam (S240, S100).
process.exit(failed > 0 ? 1 : 0);
