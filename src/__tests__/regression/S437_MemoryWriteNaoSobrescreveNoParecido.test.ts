/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S437
 * `memory_write create` sem id, diante de um nó PARECIDO (findSimilarNode): nunca sobrescreve o existente e sempre grava o
 * novo — o nó parecido vai como fato, com a chamada exata para mesclar se for o mesmo.
 *
 * INCIDENTES REAIS:
 * - Windows, 17/10/2026, "consegue salvar os dados do e-mail da agenda?": o create encontrou um nó sobre a VPS com 3 palavras
 *   em comum e SUBSTITUIU nome e conteúdo dele ("duplicata evitada") — o fato sobre a VPS se perdeu.
 * - 21/10/2026: na primeira correção nada era gravado e o agente tinha de decidir (update × create com id). Em 3 de 4 testes
 *   reais o modelo não decidiu e encerrou o turno — produção, 21/10 22:07, a grade do 2º semestre: "tentei registrar essa
 *   grade na memória, mas a gravação falhou — ela não está salva".
 *
 * Execução: npx ts-node src/__tests__/regression/S437_MemoryWriteNaoSobrescreveNoParecido.test.ts
 */
import Database from 'better-sqlite3';
import { MemoryManager } from '../../memory/MemoryManager';
import { MemoryWriteTool } from '../../tools/memory_write';
import { EmbeddingService } from '../../memory/EmbeddingService';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

// Sem servidor de embedding: as chamadas falham rápido e o teste não depende de rede.
(globalThis as any).fetch = async () => { throw new Error('sem rede no teste'); };

async function main(): Promise<void> {
    const db = new (Database as any)(':memory:');
    new EmbeddingService(db);   // cria memory_embeddings (o merge a usa), como no S240
    const mm = new MemoryManager(db, 'http://mock-ollama:11434');
    const tool = new MemoryWriteTool(mm);
    const infra = () => db.prepare("SELECT id, name, content FROM memory_nodes WHERE type = 'infrastructure' ORDER BY id").all() as Array<{ id: string; name: string; content: string }>;

    const vps = 'Servidor VPS de testes inacessível pelo acesso remoto; o cliente himalaya de e-mail roda no servidor principal da conta';
    await tool.execute({ action: 'create', id: 'vps_testes_1', type: 'infrastructure', name: 'VPS de testes inacessível', content: vps });

    console.log('\n=== S437-1 — o parecido de OUTRO assunto fica intacto, e o novo é gravado ===');
    const novoConteudo = 'Acesso consolidado: e-mail da conta pelo cliente himalaya no servidor; agenda pelo link privado salvo no arquivo';
    const r = await tool.execute({ action: 'create', type: 'infrastructure', name: 'Acesso e-mail + agenda consolidado', content: novoConteudo });
    const vpsDepois = infra().find(n => n.id === 'vps_testes_1');
    assert(vpsDepois?.name === 'VPS de testes inacessível' && vpsDepois?.content === vps, 'nome e conteúdo do nó existente não mudaram', vpsDepois);
    assert(r.success === true, 'a gravação acontece (o agente não precisa decidir para nada se perder)', r);
    const novo = infra().find(n => n.id !== 'vps_testes_1');
    assert(!!novo && novo.content === novoConteudo, 'o fato novo está salvo, num nó próprio', infra());

    console.log('\n=== S437-2 — o agente recebe o parecido como fato, com a chamada exata de mesclar ===');
    const o = r.output ?? '';
    assert(/Já existia um nó parecido: "vps_testes_1"/.test(o) && /VPS de testes inacessível/.test(o), 'diz qual nó é e o nome dele', o);
    assert(o.includes(`memory_write action="merge" id="${novo?.id}" merge_ids=["vps_testes_1"]`), 'a chamada exata de merge, com os ids certos', o);
    assert(/Se for outro fato, não faça nada/.test(o), 'deixa claro que, sendo outro fato, não há nada a fazer');

    console.log('\n=== S437-3 — sendo o MESMO fato, o merge sugerido junta os dois sem perder nada ===');
    const m = await tool.execute({ action: 'merge', id: novo!.id, merge_ids: ['vps_testes_1'] });
    const depois = infra();
    assert(m.success === true && depois.length === 1, 'ficou um nó só', { m, depois });
    assert(depois[0].content.includes('himalaya') && /agenda/.test(depois[0].content), 'o conteúdo do nó que ficou tem o fato novo', depois[0]);

    console.log('\n=== S437-4 — sem nó parecido, a resposta de sempre ===');
    const r3 = await tool.execute({ action: 'create', type: 'fact', name: 'Cor preferida', content: 'Azul é a cor preferida' });
    assert(r3.success === true && !/parecido/.test(r3.output), 'nenhum aviso quando não há parecido', r3.output);

    db.close();
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S437 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
