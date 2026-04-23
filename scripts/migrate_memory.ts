/**
 * migrate_memory.ts — Importa dados do IAL (cognitive_graph.json + memory/) para o SQLite do NewClaw
 * 
 * Uso: npx ts-node scripts/migrate_memory.ts
 * 
 * Lê:
 * - system/graph/cognitive_graph.json → memory_nodes + memory_edges
 * - memory/*.md → memory_nodes (tipo 'fact')
 * - SOUL.md, USER.md, IDENTITY.md → memory_nodes (tipo 'identity')
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const DB_PATH = process.argv[2] || path.resolve(__dirname, '../../data/newclaw.db');
const WORKSPACE = process.argv[3] || path.resolve(__dirname, '../../../');

function migrate() {
    console.log('🔄 Iniciando migração de memória IAL → NewClaw...\n');

    const db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');

    let nodesImported = 0;
    let edgesImported = 0;
    let factsImported = 0;

    // === 1. Importar cognitive_graph.json ===
    const graphPath = path.join(WORKSPACE, 'system/graph/cognitive_graph.json');
    if (fs.existsSync(graphPath)) {
        const graphData = JSON.parse(fs.readFileSync(graphPath, 'utf-8'));
        const nodes = graphData.nodes || [];
        const edges = graphData.edges || [];

        console.log(`📊 Grafo: ${nodes.length} nós, ${edges.length} arestas`);

        const insertNode = db.prepare(`
            INSERT OR REPLACE INTO memory_nodes (id, type, name, content, metadata, updated_at)
            VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        `);

        const insertEdge = db.prepare(`
            INSERT OR REPLACE INTO memory_edges (from_node, to_node, relation, weight)
            VALUES (?, ?, ?, ?)
        `);

        const tx = db.transaction(() => {
            for (const node of nodes) {
                const type = mapType(node.type);
                const name = (node.label || node.name || node.id || '').slice(0, 200);
                const content = node.content || node.description || node.summary || name;
                const metadata = JSON.stringify({
                    source: 'ial_cognitive_graph',
                    original_type: node.type,
                    ...(node.metadata || {})
                });
                insertNode.run(node.id, type, name, content, metadata);
                nodesImported++;
            }

            for (const edge of edges) {
                const from = edge.from || edge.source;
                const to = edge.to || edge.target;
                const relation = edge.label || edge.relation || 'related_to';
                const weight = edge.weight || 1.0;
                if (from && to) {
                    insertEdge.run(from, to, relation, weight);
                    edgesImported++;
                }
            }
        });

        tx();
        console.log(`  ✅ ${nodesImported} nós importados`);
        console.log(`  ✅ ${edgesImported} arestas importadas`);
    } else {
        console.log('  ⚠️ cognitive_graph.json não encontrado');
    }

    // === 2. Importar arquivos memory/*.md ===
    const memoryDir = path.join(WORKSPACE, 'memory');
    if (fs.existsSync(memoryDir)) {
        const files = fs.readdirSync(memoryDir).filter(f => f.endsWith('.md'));
        console.log(`\n📁 Memory: ${files.length} arquivos`);

        const insertNode = db.prepare(`
            INSERT OR REPLACE INTO memory_nodes (id, type, name, content, metadata, updated_at)
            VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        `);

        const tx = db.transaction(() => {
            for (const file of files) {
                const content = fs.readFileSync(path.join(memoryDir, file), 'utf-8');
                const id = `memory_${file.replace('.md', '')}`;
                insertNode.run(id, 'fact', file.replace('.md', ''), content, JSON.stringify({ source: 'ial_memory', file }));
                factsImported++;
            }
        });

        tx();
        console.log(`  ✅ ${factsImported} fatos importados`);
    }

    // === 3. Importar SOUL.md, USER.md, IDENTITY.md ===
    const coreFiles = ['SOUL.md', 'USER.md', 'IDENTITY.md'];
    console.log('\n📄 Arquivos core:');
    for (const file of coreFiles) {
        const filePath = path.join(WORKSPACE, file);
        if (fs.existsSync(filePath)) {
            const content = fs.readFileSync(filePath, 'utf-8');
            const id = `core_${file.toLowerCase().replace('.md', '')}`;
            const type = file === 'USER.md' ? 'identity' : file === 'SOUL.md' ? 'identity' : 'identity';
            db.prepare(`
                INSERT OR REPLACE INTO memory_nodes (id, type, name, content, metadata, updated_at)
                VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            `).run(id, type, file, content, JSON.stringify({ source: 'ial_core', file }));
            console.log(`  ✅ ${file} importado`);
            nodesImported++;
        }
    }

    // === Resumo ===
    const finalNodes = db.prepare('SELECT COUNT(*) as c FROM memory_nodes').get() as any;
    const finalEdges = db.prepare('SELECT COUNT(*) as c FROM memory_edges').get() as any;

    console.log(`\n🎉 Migração completa!`);
    console.log(`   Nós totais: ${finalNodes.c} | Arestas: ${finalEdges.c}`);

    db.close();
}

function mapType(ialType: string): string {
    const map: Record<string, string> = {
        'document': 'project',
        'core_document': 'context',
        'service': 'skill',
        'exchange': 'fact',
        'host': 'context',
    };
    return map[ialType] || 'fact';
}

migrate();