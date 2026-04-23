/**
 * CognitiveDomains — Modularização Cognitiva do Grafo NewClaw
 *
 * Cada nó pertence a exatamente 1 domínio cognitivo.
 * Domínios representam funções mentais distintas.
 * Relações cross-domain são permitidas e incentivadas.
 */

// ── Domain Definitions ──────────────────────────────────────

export const COGNITIVE_DOMAINS = {
    core_identity: {
        label: 'Core Identity',
        description: 'Identidade do agente, traços de personalidade, auto-conhecimento',
        priority: 0.6,
        allowedTypes: ['identity', 'trait'],
    },
    user_modeling: {
        label: 'User Modeling',
        description: 'Perfil do usuário, preferências, histórico, objetivos pessoais',
        priority: 0.7,
        allowedTypes: ['identity', 'preference', 'goal'],
    },
    memory_graph: {
        label: 'Memory Graph',
        description: 'Documentação, fatos históricos, índices, containers legacy',
        priority: 0.3,
        allowedTypes: ['fact', 'context', 'legacy_container'],
    },
    active_context: {
        label: 'Active Context',
        description: 'Contexto ativo, estado atual, workspace, tarefas correntes',
        priority: 1.0,
        allowedTypes: ['context', 'context_state', 'active_goal', 'current_task'],
    },
    skills_tools: {
        label: 'Skills & Tools',
        description: 'Habilidades, serviços, infraestrutura, projetos, ferramentas',
        priority: 0.5,
        allowedTypes: ['skill', 'infrastructure', 'project', 'knowledge'],
    },
    governance_safety: {
        label: 'Governance & Safety',
        description: 'Regras operacionais, protocolos de segurança, estratégias de execução',
        priority: 0.5,
        allowedTypes: ['rule', 'strategy', 'context'],
    },
    cognitive_architecture: {
        label: 'Cognitive Architecture',
        description: 'Conhecimento sobre o próprio sistema, metacognição, observabilidade',
        priority: 0.4,
        allowedTypes: ['knowledge', 'context', 'fact'],
    },
};

export type CognitiveDomain = keyof typeof COGNITIVE_DOMAINS;

// ── Domain Validation Rules ─────────────────────────────────

/**
 * Validates that a node type is compatible with a domain.
 * Returns true if the type is allowed in the domain.
 */
export function isTypeValidForDomain(type: string, domain: CognitiveDomain): boolean {
    const domainDef = COGNITIVE_DOMAINS[domain];
    if (!domainDef) return false;
    return domainDef.allowedTypes.includes(type as any);
}

/**
 * Suggests the best domain for a given node type.
 * Returns the first domain that allows the type.
 */
export function suggestDomainForType(type: string): CognitiveDomain {
    for (const [domain, def] of Object.entries(COGNITIVE_DOMAINS)) {
        if ((def.allowedTypes as string[]).includes(type)) {
            return domain as CognitiveDomain;
        }
    }
    return 'memory_graph'; // Default fallback
}

/**
 * Get domain priority for attention score calculation.
 * Used by AttentionLayer to weight domain_priority.
 */
export function getDomainPriority(domain: string | null | undefined): number {
    if (!domain) return 0.3; // No domain = low priority
    const def = COGNITIVE_DOMAINS[domain as CognitiveDomain];
    return def?.priority ?? 0.3;
}

/**
 * Cross-domain relation incentives.
 * Some domain pairs should have stronger relations.
 */
export const CROSS_DOMAIN_STRENGTH: Record<string, number> = {
    'active_context:memory_graph':       0.8,  // Context accesses memory
    'active_context:skills_tools':        0.7,  // Context uses tools
    'active_context:governance_safety':   0.6,  // Context follows rules
    'user_modeling:active_context':      0.7,  // User drives context
    'user_modeling:core_identity':       0.6,  // User ↔ Agent relationship
    'core_identity:governance_safety':    0.8,  // Identity defines rules
    'core_identity:cognitive_architecture': 0.6, // Identity knows architecture
    'skills_tools:cognitive_architecture': 0.5,  // Skills documented in architecture
    'governance_safety:cognitive_architecture': 0.6, // Rules documented
    'memory_graph:cognitive_architecture': 0.4, // Docs reference architecture
};

/**
 * Get cross-domain relation strength bonus.
 */
export function getCrossDomainStrength(fromDomain: string, toDomain: string): number {
    const key1 = `${fromDomain}:${toDomain}`;
    const key2 = `${toDomain}:${fromDomain}`;
    return CROSS_DOMAIN_STRENGTH[key1] ?? CROSS_DOMAIN_STRENGTH[key2] ?? 0.3;
}

// ── Domain Queries ──────────────────────────────────────────

/**
 * SQL helpers for domain-based queries.
 */
export const DOMAIN_QUERIES = {
    /** Get all nodes in a domain */
    byDomain: (domain: CognitiveDomain) =>
        `SELECT * FROM memory_nodes WHERE domain = ? ORDER BY pagerank DESC`,

    /** Get nodes by domain and type */
    byDomainAndType: (domain: CognitiveDomain, type: string) =>
        `SELECT * FROM memory_nodes WHERE domain = ? AND type = ? ORDER BY pagerank DESC`,

    /** Count nodes per domain */
    domainStats: `
        SELECT domain, COUNT(*) as count, GROUP_CONCAT(DISTINCT type) as types
        FROM memory_nodes GROUP BY domain ORDER BY count DESC`,

    /** Get cross-domain edges */
    crossDomainEdges: `
        SELECT e.*, n1.domain as from_domain, n2.domain as to_domain
        FROM memory_edges e
        JOIN memory_nodes n1 ON e.from_node = n1.id
        JOIN memory_nodes n2 ON e.to_node = n2.id
        WHERE n1.domain != n2.domain
        ORDER BY e.weight DESC`,

    /** Search within a domain using FTS5 */
    searchInDomain: (domain: CognitiveDomain) =>
        `SELECT n.* FROM memory_nodes n
         JOIN memory_nodes_fts f ON f.rowid = n.rowid
         WHERE n.domain = ? AND memory_nodes_fts MATCH ?
         ORDER BY rank LIMIT ?`,

    /** Get domain distribution for analytics */
    domainDistribution: `
        SELECT domain, type, COUNT(*) as count
        FROM memory_nodes
        GROUP BY domain, type
        ORDER BY domain, count DESC`,
};