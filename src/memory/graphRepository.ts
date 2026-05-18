import Database from 'better-sqlite3';
import { createLogger } from '../shared/AppLogger';
import { ConfidenceClassifier } from '../core/ConfidenceClassifier';
import { MemoryNode, MemoryNodeRow } from './memoryTypes';
import { safeExec } from './memorySchema';

const log = createLogger('GraphRepository');

export const NODE_TYPES: Record<string, { label: string; description: string }> = {
    identity:       { label: 'Identidade',      description: 'Entidades centrais (usuário, agente)' },
    preference:     { label: 'Preferência',     description: 'Interesses, escolhas, configurações' },
    project:        { label: 'Projeto',         description: 'Iniciativas, sistemas, produtos' },
    skill:          { label: 'Habilidade',      description: 'Competências, serviços, ferramentas' },
    context:        { label: 'Contexto',        description: 'Infraestrutura, ambiente, configuração' },
    fact:           { label: 'Fato',            description: 'Informações temporais ou eventos' },
    infrastructure: { label: 'Infraestrutura',  description: 'VPS, servidores, exchanges, hosts físicos' },
    domain:         { label: 'Domínio',         description: 'Hub de domínio cognitivo (CLIMA, CRIPTO, PROJETOS, etc.)' },
};

export const RELATION_ONTOLOGY: Record<string, { label: string; description: string; allowedFrom: string[]; allowedTo: string[] }> = {
    belongs_to:     { label: 'pertence a',          description: 'Pertinência hierárquica',           allowedFrom: ['identity','skill','project','context'], allowedTo: ['identity','project','context'] },
    owns:           { label: 'possui',              description: 'Posse direta',                      allowedFrom: ['identity'],                             allowedTo: ['project','skill','context'] },
    prefers:        { label: 'prefere',             description: 'Preferência ou interesse',          allowedFrom: ['identity'],                             allowedTo: ['preference'] },
    works_on:       { label: 'trabalha em',         description: 'Envolvimento ativo',                allowedFrom: ['identity'],                             allowedTo: ['project'] },
    uses:           { label: 'usa',                 description: 'Uso de ferramenta/serviço',         allowedFrom: ['identity','project','skill','infrastructure'], allowedTo: ['skill','context','infrastructure'] },
    runs_on:        { label: 'executa em',          description: 'Hospedagem/infraestrutura',         allowedFrom: ['project','skill','infrastructure'],     allowedTo: ['context','infrastructure'] },
    references:     { label: 'referencia',          description: 'Referência informativa',            allowedFrom: ['*'],                                   allowedTo: ['*'] },
    related_to:     { label: 'relacionado',         description: 'Relação genérica',                 allowedFrom: ['*'],                                   allowedTo: ['*'] },
    depends_on:     { label: 'depende de',          description: 'Dependência técnica',               allowedFrom: ['project','skill','context','infrastructure'], allowedTo: ['project','skill','context','infrastructure'] },
    contains:       { label: 'contém',             description: 'Composição hierárquica',             allowedFrom: ['project','context','domain'],           allowedTo: ['skill','context','fact','preference','project','infrastructure','trait','rule','strategy','knowledge'] },
    created:        { label: 'criou',              description: 'Autoria/criação',                   allowedFrom: ['identity'],                             allowedTo: ['project','fact'] },
    reads:          { label: 'lê',                 description: 'Leitura de dados',                  allowedFrom: ['skill','project'],                      allowedTo: ['skill','context'] },
    writes:         { label: 'escreve',             description: 'Escrita de dados',                 allowedFrom: ['skill','project'],                      allowedTo: ['skill','context'] },
    hosts:          { label: 'hospeda',             description: 'Infraestrutura hospeda projeto',    allowedFrom: ['infrastructure'],                       allowedTo: ['project','skill'] },
    has_preference: { label: 'possui preferência', description: 'Preferência de usuário',             allowedFrom: ['identity'],                             allowedTo: ['preference'] },
    has_goal:       { label: 'tem objetivo',        description: 'Objetivo ou meta',                  allowedFrom: ['identity'],                             allowedTo: ['project', 'fact'] },
    has_trait:      { label: 'possui traço',        description: 'Característica ou perícia',         allowedFrom: ['identity'],                             allowedTo: ['fact', 'preference'] },
    has_identity:   { label: 'tem identidade',      description: 'Relaciona usuário ao seu nome/ID', allowedFrom: ['identity'],                             allowedTo: ['identity'] },
    has_domain:     { label: 'tem domínio',         description: 'Agrupa memórias por domínio cognitivo', allowedFrom: ['identity'],                        allowedTo: ['domain'] },
    groups:         { label: 'agrupa',              description: 'Domínio agrega nós de memória',     allowedFrom: ['domain'],                               allowedTo: ['*'] },
};

export function validateRelation(fromType: string, relation: string, toType: string): boolean {
    const rel = RELATION_ONTOLOGY[relation];
    if (!rel) return true;
    if (rel.allowedFrom[0] === '*' && rel.allowedTo[0] === '*') return true;
    if (!rel.allowedFrom.includes(fromType) && !rel.allowedFrom.includes('*')) return false;
    if (!rel.allowedTo.includes(toType) && !rel.allowedTo.includes('*')) return false;
    return true;
}

export function addNode(db: Database.Database, classifier: ConfidenceClassifier, node: MemoryNode, source: string = 'unknown'): void {
    const classification = classifier.classify(node.content, source, node.metadata);
    if (!classifier.shouldPersist(classification.confidence)) {
        log.warn(`[GraphRepository] Preventing persistence of ${classification.confidence} content: ${node.id}`);
        return;
    }

    const confidenceScore = node.confidence ?? classification.score;

    let metadataObj = node.metadata || {};
    let metadataJson = JSON.stringify(metadataObj);
    if (metadataJson.length > 8000) {
        const truncated: Record<string, unknown> = {};
        for (const key of Object.keys(metadataObj).slice(0, 20)) {
            const val = String(metadataObj[key] ?? '');
            truncated[key] = val.length > 500 ? val.slice(0, 500) + '...' : metadataObj[key];
        }
        truncated['_truncated'] = true;
        metadataObj = truncated as Record<string, string>;
        metadataJson = JSON.stringify(truncated);
        log.warn(`[GraphRepository] Truncated metadata for node ${node.id}: ${metadataJson.length} chars`);
    }

    db.prepare(`
        INSERT OR REPLACE INTO memory_nodes (id, type, name, content, metadata, weight, confidence, last_updated, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(
        node.id, node.type, node.name, node.content,
        metadataJson, node.weight ?? 1.0, confidenceScore,
        node.last_updated || new Date().toISOString()
    );

    try {
        db.prepare(`
            INSERT OR IGNORE INTO node_metrics (node_id, usage_count, last_accessed_at, reinforcement_score, memory_class)
            VALUES (?, 0, CURRENT_TIMESTAMP, 0.0, 'latent')
        `).run(node.id);
    } catch { /* node_metrics may not exist in older schemas */ }
}

export function getNode(db: Database.Database, id: string): MemoryNode | undefined {
    const row = db.prepare('SELECT * FROM memory_nodes WHERE id = ?').get(id) as MemoryNodeRow | undefined;
    if (!row) return undefined;
    return { ...row, metadata: JSON.parse(row.metadata || '{}') };
}

export function getNodesByType(db: Database.Database, type: MemoryNode['type']): MemoryNode[] {
    return db.prepare('SELECT * FROM memory_nodes WHERE type = ?').all(type) as MemoryNode[];
}

export function searchNodes(db: Database.Database, query: string, limit: number = 10): MemoryNode[] {
    const stopWords = new Set(['o', 'a', 'os', 'as', 'de', 'do', 'da', 'dos', 'das', 'em', 'no', 'na', 'nos', 'nas', 'um', 'uma', 'uns', 'umas', 'e', 'ou', 'mas', 'se', 'que', 'não', 'para', 'com', 'por', 'como', 'isso', 'esse', 'essa', 'estes', 'estas', 'esse', 'isso', 'aquilo', 'the', 'is', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by']);
    const keywords = query.toLowerCase()
        .replace(/[^\w\sáàãâéèêíìîóòõôúùûç]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 2 && !stopWords.has(w));

    const searchTokens = keywords.length > 0 ? keywords : [query];

    try {
        const ftsQuery = searchTokens.join(' OR ');
        const ftsResults = db.prepare(`
            SELECT n.* FROM memory_nodes n
            JOIN memory_nodes_fts f ON f.rowid = n.rowid
            WHERE memory_nodes_fts MATCH ?
            ORDER BY rank LIMIT ?
        `).all(ftsQuery, limit) as MemoryNode[];
        if (ftsResults.length > 0) return ftsResults;
    } catch { /* FTS5 might fail on special chars */ }

    const conditions = searchTokens.map(() => '(name LIKE ? OR content LIKE ?)').join(' OR ');
    const params = searchTokens.flatMap(k => [`%${k}%`, `%${k}%`]);
    return db.prepare(`
        SELECT * FROM memory_nodes WHERE ${conditions} ORDER BY updated_at DESC LIMIT ?
    `).all(...params, limit) as MemoryNode[];
}

export function addEdge(
    db: Database.Database,
    from: string,
    to: string,
    relation: string,
    weight: number = 1.0,
    confidence: number = 1.0
): void {
    const fromNode = getNode(db, from);
    const toNode = getNode(db, to);
    if (fromNode && toNode) {
        if (!validateRelation(fromNode.type, relation, toNode.type)) {
            if (validateRelation(fromNode.type, 'related_to', toNode.type)) {
                log.warn(`[GraphRepository] Relation "${relation}" invalid for ${fromNode.type}->${toNode.type}. Falling back to "related_to".`);
                relation = 'related_to';
            } else if (validateRelation(fromNode.type, 'has_trait', toNode.type)) {
                log.warn(`[GraphRepository] Relation "${relation}" invalid for ${fromNode.type}->${toNode.type}. Falling back to "has_trait".`);
                relation = 'has_trait';
            } else {
                log.warn(`[GraphRepository] No valid relation for ${fromNode.type}->${toNode.type}. Using "related_to" as last resort.`);
                relation = 'related_to';
            }
        }
    }
    db.prepare(`
        INSERT OR REPLACE INTO memory_edges (from_node, to_node, relation, weight, confidence)
        VALUES (?, ?, ?, ?, ?)
    `).run(from, to, relation, weight, confidence);
}

export function addEdgeWithInverse(
    db: Database.Database,
    from: string,
    to: string,
    relation: string,
    weight: number = 1.0,
    confidence: number = 1.0,
    inverseRelations: Record<string, string>
): string[] {
    addEdge(db, from, to, relation, weight, confidence);
    const created = [`${from} --${relation}--> ${to}`];
    const inverse = inverseRelations[relation];
    if (inverse) {
        addEdge(db, to, from, inverse, weight, confidence);
        created.push(`${to} --${inverse}--> ${from}`);
    }
    return created;
}

export function getRelatedNodes(db: Database.Database, nodeId: string, relation?: string): MemoryNode[] {
    const sql = relation
        ? `SELECT n.* FROM memory_nodes n JOIN memory_edges e ON n.id = e.to_node WHERE e.from_node = ? AND e.relation = ?`
        : `SELECT n.* FROM memory_nodes n JOIN memory_edges e ON n.id = e.to_node WHERE e.from_node = ?`;
    const params = relation ? [nodeId, relation] : [nodeId];
    return db.prepare(sql).all(...params) as MemoryNode[];
}

export function getContext(db: Database.Database): string {
    const identity = getNode(db, 'identity');
    const preferences = getNodesByType(db, 'preference');
    const projects = getNodesByType(db, 'project');
    const allFacts = getNodesByType(db, 'fact');
    const facts = allFacts.sort((a, b) => (b.pagerank || 0) - (a.pagerank || 0)).slice(0, 3);

    let context = '';
    if (identity) context += `Identidade: ${identity.name} - ${(identity.content || '').slice(0, 120)}\n`;
    if (preferences.length) context += `Preferências: ${preferences.map(p => (p.content || '').slice(0, 80)).join(', ')}\n`;
    if (projects.length) context += `Projetos: ${projects.map(p => `${p.name}: ${(p.content || '').slice(0, 80)}`).join(', ')}\n`;
    if (facts.length) context += `Fatos: ${facts.map(f => (f.content || '').slice(0, 100)).join('; ')}\n`;

    const coreNodes = db.prepare(
        "SELECT id, name, content FROM memory_nodes WHERE id LIKE 'core_%' OR id = 'pref_workspace' ORDER BY id"
    ).all() as Array<{ id: string; name: string; content: string }>;
    if (coreNodes.length) {
        context += '\nConhecimento do sistema:\n';
        for (const node of coreNodes) {
            context += `- ${node.name}: ${(node.content || '').slice(0, 150)}\n`;
        }
    }

    return context;
}

/**
 * Seed the core cognitive graph on first boot.
 * Uses raw SQL inserts (bypasses classification pipeline) since these are always-valid core nodes.
 */
export function bootstrapCoreGraph(
    db: Database.Database,
    classifier: ConfidenceClassifier
): void {
    const coreNodes: MemoryNode[] = [
        { id: 'identity',          type: 'identity', name: 'IDENTITY',          content: 'Nó-raiz da identidade cognitiva do NewClaw. Conecta agente, usuário, estilo e princípios.' },
        { id: 'core_identity',     type: 'identity', name: 'IDENTITY CORE',     content: 'Hub estrutural da identidade cognitiva. Mantido para compatibilidade com curadoria e expansão do grafo.' },
        { id: 'core_agent',        type: 'identity', name: 'AGENTS',            content: 'Representa o agente NewClaw, seu papel como copiloto local, memória persistente e capacidade de agir com ferramentas.' },
        { id: 'core_soul',         type: 'context',  name: 'SOUL',              content: 'Guarda a personalidade, voz, valores e tom do sistema: útil, acolhedor, direto e persistente.' },
        { id: 'core_tools',        type: 'skill',    name: 'TOOLS',             content: 'Hub das ferramentas disponíveis para pesquisar, editar arquivos, executar comandos, navegar e gerenciar memória.' },
        { id: 'core_user',         type: 'identity', name: 'USER',              content: 'Perfil vivo do usuário. Deve ser enriquecido gradualmente com nome, objetivos, preferências, contexto e histórico.' },
        { id: 'core_heartbeat',    type: 'fact',     name: 'HEARTBEAT',         content: 'Marca o estado inicial do sistema e serve como trilha de vida do agente: instalação, boot, onboarding e eventos importantes.' },
        { id: 'core_memory',       type: 'context',  name: 'MEMORY',            content: 'Hub da memória semântica persistente. Organiza nós, relações, contexto relevante e recuperação futura.' },
        { id: 'system_reflection', type: 'fact',     name: 'system_reflection', content: 'System initialized with base cognitive graph and awaiting user interaction' },
        { id: 'agent_state',       type: 'context',  name: 'agent_state',       content: JSON.stringify({ mode: 'learning', confidence: 0.5, user_alignment: 0.5, current_focus: 'unknown' }) },
    ];

    for (const node of coreNodes) {
        if (!db.prepare('SELECT 1 FROM memory_nodes WHERE id = ?').get(node.id)) {
            addNode(db, classifier, node, 'bootstrap');
        }
    }

    if (!getNode(db, 'pref_workspace')) {
        const defaultPath = process.env.WORKSPACE_DIR || '/newclaw/workspace';
        addNode(db, classifier, { id: 'pref_workspace', type: 'preference', name: 'Workspace', content: `Workspace principal do NewClaw em ${defaultPath}` }, 'bootstrap');
    }

    const baseEdges: Array<[string, string, string]> = [
        ['identity', 'core_agent', 'related_to'],
        ['identity', 'core_user', 'related_to'],
        ['identity', 'core_soul', 'related_to'],
        ['identity', 'core_memory', 'related_to'],
        ['identity', 'core_identity', 'related_to'],
        ['core_identity', 'core_agent', 'related_to'],
        ['core_identity', 'core_user', 'related_to'],
        ['core_identity', 'core_memory', 'related_to'],
        ['core_agent', 'core_tools', 'uses'],
        ['core_agent', 'core_memory', 'related_to'],
        ['core_agent', 'core_heartbeat', 'created'],
        ['core_user', 'core_memory', 'related_to'],
        ['core_user', 'pref_workspace', 'prefers'],
        ['core_memory', 'core_heartbeat', 'contains'],
        ['core_memory', 'core_tools', 'contains'],
        ['core_soul', 'core_agent', 'related_to'],
    ];

    for (const [from, to, relation] of baseEdges) {
        try {
            if (!db.prepare('SELECT 1 FROM memory_edges WHERE from_node = ? AND to_node = ? LIMIT 1').get(from, to)) {
                addEdge(db, from, to, relation, 1.0, 1.0);
            }
        } catch { /* Keep bootstrap resilient across ontology changes. */ }
    }
}

export function rebuildFtsIndex(db: Database.Database): void {
    try {
        db.exec(`INSERT INTO memory_nodes_fts(memory_nodes_fts) VALUES('rebuild')`);
        safeExec(db, 'CREATE INDEX IF NOT EXISTS idx_memory_nodes_pagerank ON memory_nodes(pagerank)');
    } catch (e) {
        log.warn('[GraphRepository] FTS rebuild failed:', String(e));
    }
}
