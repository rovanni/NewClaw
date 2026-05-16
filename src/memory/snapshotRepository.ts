import Database from 'better-sqlite3';
import { SnapshotRow } from './memoryTypes';

interface MetricsRow {
    id: string; pagerank: number; degree: number;
    betweenness: number; closeness: number; community_id: number;
}

export function recordMetricsSnapshot(db: Database.Database): number {
    const nodes = db.prepare(
        'SELECT id, pagerank, degree, betweenness, closeness, community_id FROM memory_nodes'
    ).all() as MetricsRow[];

    const stmt = db.prepare(
        'INSERT INTO memory_metrics_history (node_id, pagerank, degree, betweenness, closeness, community_id) VALUES (?, ?, ?, ?, ?, ?)'
    );
    const transaction = db.transaction((rows: MetricsRow[]) => {
        for (const n of rows) {
            stmt.run(n.id, n.pagerank || 0, n.degree || 0, n.betweenness || 0, n.closeness || 0, n.community_id || 0);
        }
    });
    transaction(nodes);
    return nodes.length;
}

export function createSnapshot(db: Database.Database, label?: string): string {
    const id = `snap_${Date.now()}`;
    const nodes = db.prepare('SELECT * FROM memory_nodes').all();
    const edges = db.prepare('SELECT * FROM memory_edges').all();
    const snapshotData = JSON.stringify({ nodes, edges });
    db.prepare(`
        INSERT INTO graph_snapshots (id, label, node_count, edge_count, snapshot_data)
        VALUES (?, ?, ?, ?, ?)
    `).run(id, label || `Snapshot ${new Date().toISOString()}`, nodes.length, edges.length, snapshotData);
    return id;
}

export function listSnapshots(db: Database.Database): Omit<SnapshotRow, 'snapshot_data'>[] {
    return db.prepare(
        'SELECT id, label, node_count, edge_count, created_at FROM graph_snapshots ORDER BY created_at DESC'
    ).all() as Omit<SnapshotRow, 'snapshot_data'>[];
}

export function restoreSnapshot(db: Database.Database, id: string): boolean {
    const row = db.prepare('SELECT * FROM graph_snapshots WHERE id = ?').get(id) as SnapshotRow | undefined;
    if (!row) return false;
    const data = JSON.parse(row.snapshot_data) as { nodes: Record<string, unknown>[]; edges: Record<string, unknown>[] };

    db.transaction(() => {
        db.exec('DELETE FROM memory_edges');
        db.exec('DELETE FROM memory_nodes');

        const insertNode = db.prepare(`
            INSERT OR REPLACE INTO memory_nodes
            (id, type, name, content, metadata, pagerank, degree, betweenness, closeness, community_id, weight, confidence, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const n of data.nodes) {
            insertNode.run(
                n['id'], n['type'], n['name'], n['content'], n['metadata'],
                n['pagerank'] || 0, n['degree'] || 0, n['betweenness'] || 0, n['closeness'] || 0, n['community_id'] || 0,
                n['weight'] || 1.0, n['confidence'] || 1.0,
                n['created_at'], n['updated_at']
            );
        }

        const insertEdge = db.prepare(
            'INSERT OR REPLACE INTO memory_edges (from_node, to_node, relation, weight, confidence, created_at) VALUES (?, ?, ?, ?, ?, ?)'
        );
        for (const e of data.edges) {
            insertEdge.run(e['from_node'], e['to_node'], e['relation'], e['weight'], e['confidence'] || 1.0, e['created_at']);
        }
    })();

    return true;
}

export function deleteSnapshot(db: Database.Database, id: string): boolean {
    return db.prepare('DELETE FROM graph_snapshots WHERE id = ?').run(id).changes > 0;
}
