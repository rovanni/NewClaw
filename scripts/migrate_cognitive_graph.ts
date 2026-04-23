/**
 * Migration: cognitive_graph.json (Thorial/IAL) → newclaw.db (NewClaw)
 * 
 * Type mapping:
 *   document      → fact
 *   core_document → context
 *   service       → skill
 *   exchange      → project
 *   host          → context
 */
import fs from 'fs';
import Database from 'better-sqlite3';

const TYPE_MAP: Record<string, string> = {
    document: 'fact',
    core_document: 'context',
    service: 'skill',
    exchange: 'project',
    host: 'context'
};

const RELATION_MAP: Record<string, string> = {
    references: 'related_to',
    feeds: 'writes',
    publishes: 'writes',
    broadcasts: 'writes',
    sends_commands: 'writes',
    routes_commands: 'writes',
    publishes_commands: 'writes',
    forwards_commands: 'writes',
    writes: 'writes',
    reads: 'reads',
    proxies: 'uses',
    serves: 'contains',
    hosts: 'runs_on',
    accesses: 'uses',
    documented_by: 'belongs_to',
    auto_linked: 'related_to'
};

function mapNodeType(type: string): string {
    return TYPE_MAP[type] || 'fact';
}

function mapRelation(relation: string): string {
    return RELATION_MAP[relation] || 'related_to';
}

function main() {
    const dbPath = process.argv[2] || './data/newclaw.db';
    const graphPath = process.argv[3] || './cognitive_graph.json';
    
    const db = new Database(dbPath);
    const graph = JSON.parse(fs.readFileSync(graphPath, 'utf-8'));
    
    const nodes = graph.nodes || graph.graph?.nodes || [];
    const edges = graph.edges || graph.graph?.edges || [];
    
    console.log(`📊 Migrating: ${nodes.length} nodes, ${edges.length} edges`);
    
    // Get current max fts_rowid
    const maxRow = db.prepare('SELECT COALESCE(MAX(fts_rowid), 0) as max FROM memory_nodes').get() as any;
    let nextFtsRowid = maxRow.max + 1;
    
    // Insert nodes
    const insertNode = db.prepare(`
        INSERT OR IGNORE INTO memory_nodes (id, type, name, content, metadata, fts_rowid, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    let nodeCount = 0;
    const skipPrefixes = ['doc:', 'core:'];
    
    for (const node of nodes) {
        const id = node.id;
        const type = mapNodeType(node.type);
        const name = node.name || node.id;
        const content = node.path || node.name || '';
        const metadata = JSON.stringify({
            original_type: node.type,
            path: node.path || '',
            category: node.category || '',
            score: node.score || 0,
            size: node.size || 0,
            modified: node.modified || '',
            created_source: node.created || ''
        });
        const createdAt = node.created || new Date().toISOString();
        const updatedAt = node.modified || createdAt;
        
        const result = insertNode.run(id, type, name, content, metadata, nextFtsRowid, createdAt, updatedAt);
        if (result.changes > 0) {
            nextFtsRowid++;
            nodeCount++;
        }
    }
    
    // Insert edges
    const insertEdge = db.prepare(`
        INSERT OR IGNORE INTO memory_edges (from_node, to_node, relation, weight, confidence, created_at)
        VALUES (?, ?, ?, ?, 1.0, ?)
    `);
    
    let edgeCount = 0;
    for (const edge of edges) {
        const from = edge.source || edge.from;
        const to = edge.target || edge.to;
        const relation = mapRelation(edge.relation || 'related_to');
        const createdAt = edge.created || new Date().toISOString();
        
        try {
            insertEdge.run(from, to, relation, 1.0, createdAt);
            edgeCount++;
        } catch {
            // Skip if source/target node doesn't exist
        }
    }
    
    // Rebuild FTS5 index
    try {
        db.exec('INSERT INTO memory_nodes_fts(memory_nodes_fts) VALUES("rebuild")');
        console.log('✅ FTS5 index rebuilt');
    } catch (e: any) {
        console.log('⚠️ FTS5 rebuild skipped:', e.message);
    }
    
    // Stats
    const totalNodes = (db.prepare('SELECT COUNT(*) as c FROM memory_nodes').get() as any).c;
    const totalEdges = (db.prepare('SELECT COUNT(*) as c FROM memory_edges').get() as any).c;
    
    db.close();
    console.log(`✅ Migration complete: +${nodeCount} nodes, +${edgeCount} edges`);
    console.log(`📊 Total: ${totalNodes} nodes, ${totalEdges} edges`);
}

main();