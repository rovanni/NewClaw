/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S437
 * `memory_write create` sem id, diante de um nó PARECIDO (findSimilarNode), não sobrescreve nada: devolve o candidato como
 * fato para o agente decidir — update no id dele (mesmo fato) ou create com id próprio (outro fato).
 *
 * INCIDENTE REAL (Windows, 17/10/2026, "consegue salvar os dados do e-mail da agenda?"): o create do nó "Acesso e-mail +
 * agenda" encontrou um nó do tipo infrastructure sobre a VPS com 3 palavras de 5+ letras em comum e SUBSTITUIU nome e
 * conteúdo dele — "✅ Nó "vps_…" atualizado (conteúdo similar já existia — duplicata evitada)". O fato sobre a VPS se perdeu;
 * a resposta à usuária falou em "misfire: o sistema de memória atualizou um nó errado".
 *
 * Execução: npx ts-node src/__tests__/regression/S437_MemoryWriteNaoSobrescreveNoParecido.test.ts
 */
import Database from 'better-sqlite3';
import { MemoryManager } from '../../memory/MemoryManager';
import { MemoryWriteTool } from '../../tools/memory_write';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

// Sem servidor de embedding: as chamadas falham rápido e o teste não depende de rede.
(globalThis as any).fetch = async () => { throw new Error('sem rede no teste'); };

async function main(): Promise<void> {
    const db = new (Database as any)(':memory:');
    const mm = new MemoryManager(db, 'http://mock-ollama:11434');
    const tool = new MemoryWriteTool(mm);

    const vps = 'Servidor VPS de testes inacessível pelo acesso remoto; o cliente himalaya de e-mail roda no servidor principal da conta';
    await tool.execute({ action: 'create', id: 'vps_testes_1', type: 'infrastructure', name: 'VPS de testes inacessível', content: vps });

    console.log('\n=== S437-1 — o nó parecido de OUTRO assunto fica intacto ===');
    const r = await tool.execute({
        action: 'create', type: 'infrastructure', name: 'Acesso e-mail + agenda consolidado',
        content: 'Acesso consolidado: e-mail da conta pelo cliente himalaya no servidor; agenda pelo link privado salvo no arquivo',
    });
    const no = db.prepare("SELECT name, content FROM memory_nodes WHERE id = 'vps_testes_1'").get() as { name: string; content: string };
    assert(no.name === 'VPS de testes inacessível' && no.content === vps, 'nome e conteúdo do nó existente não mudaram', no);
    assert(r.success === false, 'o create não finge sucesso', r);
    assert((db.prepare("SELECT COUNT(*) n FROM memory_nodes WHERE type = 'infrastructure'").get() as { n: number }).n === 1, 'nenhum nó novo foi gravado às escondidas');

    console.log('\n=== S437-2 — o agente recebe o fato e as duas saídas ===');
    const e = r.error ?? '';
    assert(/já existe um nó parecido, "vps_testes_1"/.test(e) && /VPS de testes inacessível/.test(e), 'diz qual nó é e o nome dele', e);
    // Validação real (21/10/2026): as saídas no fim da mensagem não chegavam ao modelo. Vêm antes do trecho do conteúdo.
    assert(e.indexOf('action="create"') < e.indexOf('Conteúdo atual de'), 'as duas saídas vêm antes do trecho do conteúdo existente', e);
    assert(/Servidor VPS de testes inacessível/.test(e), 'mostra o conteúdo atual, para comparar', e);
    assert(/action="update" id="vps_testes_1"/.test(e), 'mesmo fato: a chamada exata de update no id existente', e);
    // Validação real (21/10/2026): com "repita o create informando um id próprio", o agente repetiu a mesma chamada e desistiu.
    const idSugerido = e.match(/action="create" id="([a-z0-9_]+)"/)?.[1];
    assert(!!idSugerido && idSugerido !== 'vps_testes_1', 'outro fato: a chamada exata de create com um id novo já escrito', e);

    console.log('\n=== S437-3 — escolhendo "outro fato", os dois convivem ===');
    const r2 = await tool.execute({
        action: 'create', id: 'acesso_email_agenda_1', type: 'infrastructure', name: 'Acesso e-mail + agenda consolidado',
        content: 'Acesso consolidado: e-mail da conta pelo cliente himalaya no servidor; agenda pelo link privado salvo no arquivo',
    });
    assert(r2.success === true, 'create com id próprio grava', r2);
    assert((db.prepare("SELECT COUNT(*) n FROM memory_nodes WHERE type = 'infrastructure'").get() as { n: number }).n === 2, 'os dois fatos existem');

    db.close();
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S437 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
