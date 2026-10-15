/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S401
 * Busca por significado (EMBED_MODEL) escolhida no painel, para qualquer usuário — e funcionando com o Ollama em outro
 * endereço.
 *
 * ORIGEM (14/10/2026): o juiz recebia memória vazia para "Alguma novidade no meu e-mail?" porque só existia busca por
 * palavras. A busca por significado resolveria, mas (a) só dava para ligá-la editando o .env, (b) trocar de modelo deixava
 * vetores incompatíveis no banco e (c) o MemoryManager criava o EmbeddingService SEM o endereço do Ollama configurado —
 * caía sempre em localhost:11434, e quem usa o Ollama em outra máquina nunca teria embeddings.
 *
 * REGRESSÃO SE: o painel deixar de oferecer o campo (com os modelos que o Ollama declara como de embedding); reindexar não
 * descartar os vetores de outro modelo; ou o EmbeddingService voltar a ignorar o OLLAMA_URL.
 *
 * Execução: npx ts-node src/__tests__/regression/S401_BuscaPorSignificado_Painel.test.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { EmbeddingService } from '../../memory/EmbeddingService';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}
const ler = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), ...p), 'utf-8');

console.log('\n=== S401-1 — reindexar: descarta vetores de outro modelo e conta os pendentes ===');
{
    const original = process.env.EMBED_MODEL;
    const db = new Database(':memory:');
    db.exec('CREATE TABLE memory_nodes (id TEXT PRIMARY KEY, name TEXT, content TEXT)');
    db.prepare('INSERT INTO memory_nodes VALUES (?, ?, ?)').run('n1', 'gmail', 'acesso via himalaya');
    db.prepare('INSERT INTO memory_nodes VALUES (?, ?, ?)').run('n2', 'clima', 'cidade padrão');
    process.env.EMBED_MODEL = 'modelo-novo:v1';
    const svc = new EmbeddingService(db, 'http://127.0.0.1:1');
    const blob = Buffer.from(new Float64Array([0.1, 0.2]).buffer);
    db.prepare('INSERT INTO memory_embeddings (node_id, embedding, model) VALUES (?, ?, ?)').run('n1', blob, 'modelo-antigo:v0');
    db.prepare('INSERT INTO memory_embeddings (node_id, embedding, model) VALUES (?, ?, ?)').run('n2', blob, 'modelo-novo:v1');
    assert(svc.pendentes() === 0, 'antes: todo nó tem algum vetor');
    assert(svc.descartarDeOutroModelo() === 1, 'o vetor do modelo antigo é descartado (não é comparável com o novo)');
    assert(svc.pendentes() === 1, 'o nó que ficou sem vetor entra na fila de reindexação');
    process.env.EMBED_MODEL = '';
    assert(svc.descartarDeOutroModelo() === 0, 'sem modelo escolhido, nada é apagado');
    db.close();
    if (original === undefined) delete process.env.EMBED_MODEL; else process.env.EMBED_MODEL = original;
}

console.log('\n=== S401-2 — o Ollama configurado chega ao serviço de embeddings ===');
{
    const mm = ler('src', 'memory', 'MemoryManager.ts');
    assert(/new EmbeddingService\(this\.db, this\.ollamaUrl\)/.test(mm), 'MemoryManager passa o OLLAMA_URL (antes: sempre localhost:11434)');
}

console.log('\n=== S401-3 — painel: campo, sugestões por fato do Ollama, reindexar ===');
{
    // Atualizado DE PROPÓSITO em 15/10/2026 (S403): a escolha deixou de passar pelo Salvar geral — agora só vale depois de
    // um teste real do modelo (Ativar), e as sugestões vêm das capacidades que o Ollama declara em /api/tags.
    const rota = ler('src', 'dashboard', 'routes', 'config.ts');
    assert(/router\.post\('\/embeddings\/reindex'/.test(rota) && /router\.get\('\/embeddings\/status'/.test(rota), 'rotas de reindexar e de acompanhar');
    assert(/descartarDeOutroModelo\(\)/.test(rota) && /svc\.verificar\(\)/.test(rota), 'reindexar testa o modelo de verdade e descarta os vetores antigos');
    const tela = ler('src', 'dashboard', 'public', 'config', 'views', 'ModelosView.js');
    assert(/id="ml-embedModel"/.test(tela) && /s\.modelosDeBusca/.test(tela), 'campo do modelo, com sugestões dos modelos que o Ollama DECLARA como de busca (não pelo nome)');
    assert(!/cs\.set\('embedModel'/.test(tela) && /reindexEmbeddings\(\)/.test(tela), 'não grava pelo Salvar geral (nome não testado não vira configuração); prepara de novo pelo botão');
    const textos = ler('src', 'dashboard', 'public', 'shared.js');
    for (const k of ['ml_embed_title', 'ml_embed_desc', 'ml_embed_hint', 'ml_embed_reindex_btn', 'ml_embed_reindex_started']) {
        assert((textos.match(new RegExp(`\\b${k}:`, 'g')) || []).length === 3, `texto "${k}" nas 3 línguas`);
    }
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S401 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
process.exit(failed > 0 ? 1 : 0);
