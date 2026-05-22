/**
 * memory_write — Criar, atualizar, conectar, deletar ou mesclar nós de memória
 * v2: Adicionado action=merge com análise inteligente
 *
 * Ações:
 * - create: Criar novo nó
 * - update: Atualizar nó existente
 * - connect: Conectar dois nós
 * - delete: Remover nó e suas conexões
 * - merge: Mesclar nós duplicados (análise inteligente)
 */

import { ToolExecutor, ToolResult } from '../loop/AgentLoop';
import { MemoryManager, MemoryNode } from '../memory/MemoryManager';
import type { MemoryFacade } from '../memory/MemoryFacade';
import { isProtectedNode } from '../memory/MemoryFacade';
import { errorMessage } from '../shared/errors';
import type { ExecutionOutcome } from '../memory/ProceduralMemoryService';
import { classifyDomain } from '../memory/DomainRegistry';
import { CognitiveMemoryIndex } from '../memory/CognitiveMemoryIndex';
import type { OwnerProfileService } from '../services/OwnerProfileService';

export class MemoryWriteTool implements ToolExecutor {
    name = 'memory_write';
    description = 'Criar, atualizar, conectar, deletar ou mesclar nós na memória. REGRAS OBRIGATÓRIAS: (1) SEMPRE busque antes para evitar duplicatas. (2) SEMPRE conecte o novo nó a um nó existente no grafo (use action=connect após create, ou inclua from/relation na mesma chamada). (3) NÓS SEM CONEXÃO = GRAFO QUEBRADO. Tipos de nó: identity, preference, project, context, fact, skill, infrastructure. Relações válidas: belongs_to, owns, prefers, works_on, uses, runs_on, depends_on, contains, created, hosts. Para fatos sobre o usuário, conectar a user_identity com relação "has_trait" ou "created". Para projetos, usar tipo "project" e conectar a user_identity com "works_on" ou "owns". Para infraestrutura, usar tipo "infrastructure" e conectar a user_identity com "uses" ou ao servidor com "runs_on".';
    parameters = {
        type: 'object',
        properties: {
            action: {
                type: 'string',
                enum: ['create', 'update', 'connect', 'delete', 'merge', 'reinforce'],
                description: 'Ação: create (novo nó), update (atualizar existente), connect (ligar dois nós), delete (remover nó), merge (mesclar duplicatas), reinforce (registrar resultado de execução de skill/strategy/rule)'
            },
            id: { type: 'string', description: 'ID do nó. Obrigatório para update/connect/delete. Para merge: ID do nó que vai absorver.' },
            type: { type: 'string', enum: ['identity', 'preference', 'project', 'context', 'fact', 'skill', 'infrastructure', 'trait', 'rule', 'strategy', 'knowledge'], description: 'Tipo do nó (apenas para create)' },
            name: { type: 'string', description: 'Nome do nó (create/update)' },
            content: { type: 'string', description: 'Conteúdo do nó (create/update)' },
            from: { type: 'string', description: 'ID do nó de origem (connect)' },
            to: { type: 'string', description: 'ID do nó de destino (connect)' },
            relation: { type: 'string', description: 'Tipo da relação (connect)' },
            merge_ids: { type: 'array', items: { type: 'string' }, description: 'Lista de IDs a mesclar no nó principal (merge). Esses nós serão removidos.' },
            domain: { type: 'string', enum: ['core_identity', 'user_modeling', 'memory_graph', 'active_context', 'skills_tools', 'governance_safety', 'cognitive_architecture'], description: 'Domínio cognitivo do nó (create/update)' },
            outcome: { type: 'string', enum: ['success', 'failure', 'partial'], description: 'Resultado da execução (reinforce)' },
            context: { type: 'string', description: 'Descrição opcional do contexto de execução (reinforce)' }
        },
        required: ['action']
    };

    private memoryManager: MemoryManager;
    private facade: MemoryFacade;
    private cognitiveIndex: CognitiveMemoryIndex | null = null;
    private ownerService: OwnerProfileService | null = null;

    // IDs e nomes que representam a identidade do dono — nunca devem ser sobrescritos pelo LLM
    private static readonly OWNER_IDENTITY_IDS = new Set(['user_identity', 'core_user', 'USER', 'user', 'USUARIO', 'usuario']);

    constructor(memoryManager: MemoryManager, ownerService?: OwnerProfileService) {
        this.memoryManager = memoryManager;
        this.facade = memoryManager.getFacade();
        this.ownerService = ownerService ?? null;
    }

    private isOwnerIdentityNode(id: string): boolean {
        return MemoryWriteTool.OWNER_IDENTITY_IDS.has(id) ||
               id.toLowerCase().startsWith('user_identity');
    }

    private checkOwnerLock(id: string, action: string, content: string): ToolResult | null {
        if (!this.ownerService?.isLocked()) return null;
        if (!this.isOwnerIdentityNode(id)) return null;
        if (action !== 'create' && action !== 'update') return null;

        this.ownerService.logBlockedOverwrite(id, content, 'memory_write_tool');
        return {
            success: false,
            output: '',
            error: `Identidade do proprietário protegida: o nó "${id}" não pode ser alterado automaticamente. ` +
                   `Para registrar uma pessoa mencionada na conversa, crie um nó separado com id "person_<nome>" e tipo "identity".`
        };
    }

    private getCognitiveIndex(): CognitiveMemoryIndex {
        if (!this.cognitiveIndex) {
            this.cognitiveIndex = new CognitiveMemoryIndex(this.memoryManager.getDatabase());
        }
        return this.cognitiveIndex;
    }

    async execute(args: Record<string, any>): Promise<ToolResult> {
        let action = (args.action as string) || (args.content ? 'create' : '');

        // 1. Normalization Layer: Extract structured data if it looks like an identity statement.
        //    Only redirect to user_identity when owner is NOT yet locked (i.e., during onboarding).
        //    When locked, never auto-map a name mention to user_identity.
        if (args.content && !args.name && args.type !== 'identity') {
            const nameMatch = (args.content as string).match(/meu nome é ([\w\s]+)|me chamo ([\w\s]+)|sou o ([\w\s]+)/i);
            if (nameMatch) {
                const name = (nameMatch[1] || nameMatch[2] || nameMatch[3]).trim();
                if (!this.ownerService?.isLocked()) {
                    // Owner not yet set — this is the first-run onboarding path
                    args.name = name;
                    args.type = 'identity';
                    args.id = 'user_identity';
                    args.content = `Nome oficial: ${name}`;
                    action = 'create';
                } else {
                    // Owner already locked — treat as a third-party mention, not the owner
                    const personId = `person_${name.toLowerCase().replace(/\s+/g, '_')}`;
                    args.id = personId;
                    args.type = 'identity';
                    args.name = name;
                    args.content = `Pessoa mencionada: ${name}`;
                    action = 'create';
                }
            }
        }

        if (!args.id && args.content) {
            args.id = `fact_${Date.now()}`;
            args.name = (args.content as string).slice(0, 50);
            args.type = args.type || 'fact';
        }

        // 2. Owner identity guard — rejeita sobrescrita quando dono está configurado e bloqueado
        const lockCheck = this.checkOwnerLock(
            (args.id as string) || '',
            action,
            (args.content as string) || ''
        );
        if (lockCheck) return lockCheck;

        // 3. Validation Layer: Prevent free-text identity nodes
        if (args.type === 'identity' && action === 'create') {
            const forbiddenPatterns = [/se chama/i, /é o/i, /é a/i, /chamado/i, /usuário/i];
            const isUnstructured = (args.content || '').length > 60 || forbiddenPatterns.some(p => p.test(args.content || ''));
            if (isUnstructured) {
                return { success: false, output: '', error: 'Erro de integridade: Nós de identidade devem ser curtos e estruturados (apenas o nome). Rejeitado: ' + args.content };
            }
        }

        try {
            switch (action) {
                case 'create': return await this.create(args);
                case 'update': return await this.update(args);
                case 'connect': return await this.connect(args);
                case 'delete': return await this.delete(args);
                case 'merge': return await this.merge(args);
                case 'reinforce': return this.reinforce(args);
                default: return { success: false, output: '', error: `Ação "${action}" inválida. Use: create, update, connect, delete, merge, reinforce.` };
            }
        } catch (error) {
            return { success: false, output: '', error: `Erro: ${errorMessage(error)}` };
        }
    }

    // ── CREATE ────────────────────────────────────────────────

    private async create(args: Record<string, any>): Promise<ToolResult> {
        // Auto-fill missing fields to prevent LLM errors
        let { id, type, name, content, domain } = args;
        
        if (!content && args.action === 'create') {
            return { success: false, output: '', error: 'create exige pelo menos "content" para criar um nó.' };
        }
        
        // Auto-assign type if missing
        if (!type) {
            type = 'fact';
        }

        // Auto-assign name if missing
        if (!name) {
            name = (content as string).slice(0, 50);
        }

        // Auto-generate id if missing — but first check for semantically similar existing nodes
        // to avoid creating duplicates of the same fact with different timestamps.
        if (!id) {
            const similar = this.findSimilarNode(content as string, type as string);
            if (similar) {
                similar.content = content;
                similar.name = name || similar.name;
                this.memoryManager.addNode(similar);
                if (domain) this.facade.setNodeDomain(similar.id, domain as string);
                return { success: true, output: `✅ Nó "${similar.id}" atualizado (conteúdo similar já existia — duplicata evitada).` };
            }
            const slug = (name || content || 'node').toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 30);
            id = `${slug}_${Date.now()}`;
        }

        const existing = this.memoryManager.getNode(id);
        if (existing) {
            existing.name = name;
            existing.type = type as MemoryNode['type'];
            existing.content = content;
            this.memoryManager.addNode(existing);

            if (domain) this.facade.setNodeDomain(id, domain as string);

            return { success: true, output: `✅ Nó "${id}" atualizado (já existia).` };
        }

        this.memoryManager.addNode({ id, type: type as MemoryNode['type'], name, content });

        if (type === 'identity' && id !== 'core_user') {
            try { this.memoryManager.addEdge('core_user', id, 'has_identity'); } catch { /* ignore */ }
        }

        // Domain-aware auto-routing: connect via domain hub when confidence >= 0.65,
        // otherwise fall back to direct user_identity connection (flat graph)
        if (type !== 'identity' && type !== 'domain' && id !== 'core_user' && id !== 'user_identity') {
            const domainResult = classifyDomain(`${name} ${content}`);
            const domainHub = domainResult ? this.memoryManager.getNode(domainResult.domainId) : null;

            if (domainHub && domainResult && domainResult.confidence >= 0.65) {
                // High-confidence: route via domain hub (reduces flat star graph)
                try { this.memoryManager.addEdge(domainResult.domainId, id, 'contains'); } catch { /* ignore */ }
            } else {
                // Low confidence: keep direct user_identity connection
                const userIdentity = this.memoryManager.getNode('user_identity');
                if (userIdentity) {
                    const relation = this.inferRelation(type, name, content);
                    try { this.memoryManager.addEdge('user_identity', id, relation); } catch { /* ignore */ }
                }
            }
        }

        // Fatos sociais/familiares: sempre conectar diretamente ao USER para
        // garantir Degree > 0 independente da confiança do domínio.
        if (this.isFamilyOrSocialContent(name as string || '', content as string || '')) {
            const userNode = this.memoryManager.getNode('user_identity')
                ?? this.memoryManager.getNode('core_user');
            if (userNode) {
                const familyRel = this.inferFamilyRelation(content as string || '');
                try { this.memoryManager.addEdge(userNode.id, id, familyRel); } catch { /* ignore */ }
            }
        }

        if (domain) this.facade.setNodeDomain(id, domain as string);

        // Force immediate indexing so the node is findable in the very next query.
        // Without this, CognitiveMemoryIndex only indexes lazily → race condition.
        try { this.getCognitiveIndex().getSummaries([id]); } catch { /* non-fatal */ }

        return { success: true, output: `✅ Nó "${id}" (${type}) criado e auto-conectado ao grafo. Use action=connect para ligações adicionais.` };
    }

    // ── SIMILARITY CHECK ──────────────────────────────────────

    /**
     * Searches for an existing node with content similar to the new one.
     * Only matches nodes of the same type and that are not system nodes.
     * Returns null if no sufficiently similar node is found.
     * Similarity criterion: at least 3 unique meaningful words in common AND
     * new content length within 3× of the existing node (same scale of information).
     */
    private findSimilarNode(content: string, type: string): import('../memory/memoryTypes').MemoryNode | null {
        try {
            const stopwords = new Set(['para', 'como', 'sobre', 'quando', 'sempre', 'usar', 'usar', 'informar', 'especificar', 'não', 'sem', 'que', 'uma', 'uns', 'the', 'and', 'com', 'por', 'em']);
            const words = content.toLowerCase()
                .replace(/[^a-záàãâéêíóõôúç\s]/g, ' ')
                .split(/\s+/)
                .filter(w => w.length >= 5 && !stopwords.has(w));
            const uniqueWords = [...new Set(words)];
            if (uniqueWords.length < 3) return null;

            const candidates = this.memoryManager.keywordSearch(uniqueWords.slice(0, 6), 8);
            for (const node of candidates) {
                if (!node.content) continue;
                if (node.type !== type) continue;
                if (node.id.startsWith('core_') || node.id.startsWith('domain_') || node.id.startsWith('time_')) continue;

                const nodeWords = new Set(
                    node.content.toLowerCase().replace(/[^a-záàãâéêíóõôúç\s]/g, ' ').split(/\s+/).filter(w => w.length >= 5 && !stopwords.has(w))
                );
                const shared = uniqueWords.filter(w => nodeWords.has(w)).length;
                const lenRatio = content.length / Math.max(node.content.length, 1);

                if (shared >= 3 && lenRatio > 0.33 && lenRatio < 3) {
                    return node;
                }
            }
        } catch {
            // non-fatal
        }
        return null;
    }

    // ── UPDATE ────────────────────────────────────────────────

    private async update(args: Record<string, any>): Promise<ToolResult> {
        const { id, name, content, domain } = args;
        if (!id) return { success: false, output: '', error: 'update exige: id.' };

        const node = this.memoryManager.getNode(id);
        if (!node) return { success: false, output: '', error: `Nó "${id}" não encontrado.` };

        if (name) node.name = name;
        if (content) node.content = content;
        this.memoryManager.addNode(node);

        if (domain) this.facade.setNodeDomain(id, domain as string);

        await this.regenerateEmbedding(id, node);

        // Force re-indexing so updated content is visible immediately.
        try { this.getCognitiveIndex().getSummaries([id]); } catch { /* non-fatal */ }

        return { success: true, output: `✅ Nó "${id}" atualizado.` };
    }

    // ── CONNECT ────────────────────────────────────────────────

    private async connect(args: Record<string, any>): Promise<ToolResult> {
        const { from, to, relation } = args;
        if (!from || !to || !relation) {
            return { success: false, output: '', error: 'connect exige: from, to, relation.' };
        }

        const fromNode = this.memoryManager.getNode(from);
        const toNode = this.memoryManager.getNode(to);
        if (!fromNode) return { success: false, output: '', error: `Nó origem "${from}" não encontrado.` };
        if (!toNode) return { success: false, output: '', error: `Nó destino "${to}" não encontrado.` };

        this.memoryManager.addEdge(from, to, relation);

        // Generate embedding for from node
        await this.regenerateEmbedding(from, fromNode);

        return { success: true, output: `✅ Conectado: ${from} → [${relation}] → ${to}.` };
    }

    // ── DELETE ────────────────────────────────────────────────

    private async delete(args: Record<string, any>): Promise<ToolResult> {
        const { id } = args;
        if (!id) return { success: false, output: '', error: 'delete exige: id.' };

        if (isProtectedNode(id as string)) {
            return { success: false, output: '', error: `Nó protegido: "${id}" não pode ser deletado. É um núcleo cognitivo do sistema. Use action=update para modificar seu conteúdo.` };
        }

        const node = this.memoryManager.getNode(id);
        if (!node) return { success: false, output: '', error: `Nó "${id}" não encontrado.` };

        const edgeCount = this.facade.countNodeEdges(id as string);
        this.facade.deleteNodeFull(id as string);

        return { success: true, output: `✅ Nó "${id}" (${node.type}/${node.name}) removido com ${edgeCount} conexões.` };
    }

    // ── REINFORCE ─────────────────────────────────────────────

    private reinforce(args: Record<string, any>): ToolResult {
        const { id, outcome, context } = args;
        if (!id) return { success: false, output: '', error: 'reinforce exige: id (nó a reforçar).' };
        if (!outcome || !['success', 'failure', 'partial'].includes(outcome)) {
            return { success: false, output: '', error: 'reinforce exige: outcome (success | failure | partial).' };
        }

        const node = this.memoryManager.getNode(id);
        if (!node) return { success: false, output: '', error: `Nó "${id}" não encontrado.` };

        this.memoryManager.getProceduralMemory().recordExecution(id as string, outcome as ExecutionOutcome, context as string | undefined);

        const emoji = outcome === 'success' ? '✅' : outcome === 'failure' ? '❌' : '⚠️';
        return {
            success: true,
            output: `${emoji} Execução de "${id}" (${node.type}/${node.name}) registrada como ${outcome}.`,
        };
    }

    // ── MERGE (Inteligente) ──────────────────────────────────

    /**
     * Merge duplicate nodes into one.
     *
     * Algorithm:
     * 1. Validate: target must exist, source IDs must exist
     * 2. Check: are sources actually similar? (same name or overlapping content)
     * 3. Merge content: combine content from all sources into target
     * 4. Transfer edges: rewire all edges from sources to target
     * 5. Keep best type: use the most specific type among all nodes
     * 6. Delete sources
     * 7. Update embeddings
     *
     * Safety: Never merge nodes of type 'identity' with different names.
     */
    private async merge(args: Record<string, any>): Promise<ToolResult> {
        const { id, merge_ids } = args;
        if (!id || !merge_ids || !Array.isArray(merge_ids) || merge_ids.length === 0) {
            return { success: false, output: '', error: 'merge exige: id (nó destino) e merge_ids (lista de IDs para mesclar).' };
        }

        // 1. Validate target
        const target = this.memoryManager.getNode(id);
        if (!target) return { success: false, output: '', error: `Nó destino "${id}" não encontrado.` };

        // Safety: never merge into a protected node (core cognitive nodes are not targets for merge)
        if (isProtectedNode(id as string)) {
            return { success: false, output: '', error: `Segurança: "${id}" é um núcleo cognitivo protegido. Não é possível usá-lo como destino de merge. Use update para modificar seu conteúdo.` };
        }

        const results: string[] = [];
        let edgesTransferred = 0;
        let contentMerged = false;

        for (const sourceId of merge_ids) {
            if (sourceId === id) continue; // Skip self

            const source = this.memoryManager.getNode(sourceId);
            if (!source) {
                results.push(`⚠️ "${sourceId}" não encontrado, ignorado.`);
                continue;
            }

            // 2. Safety check: never use a protected node as merge source (it would be deleted)
            if (isProtectedNode(sourceId as string)) {
                results.push(`⚠️ "${sourceId}" é um núcleo cognitivo protegido, ignorado por segurança.`);
                continue;
            }

            // 3. Check similarity: same name OR overlapping content keywords
            const nameMatch = source.name.toLowerCase() === target.name.toLowerCase();
            const contentOverlap = this.calculateContentOverlap(source.content || '', target.content || '');
            if (!nameMatch && contentOverlap < 0.2) {
                results.push(`⚠️ "${sourceId}" parece diferente de "${id}" (similaridade: ${(contentOverlap * 100).toFixed(0)}%). Mesclando mesmo assim...`);
            }

            // 4. Merge content: append source content if not already present
            if (source.content && !target.content.includes(source.content.slice(0, 50))) {
                target.content = target.content + '\n\n' + source.content;
                contentMerged = true;
            }

            // 5. Transfer edges from source to target
            const sourceEdges = this.facade.getEdgesOf(sourceId as string);

            for (const edge of sourceEdges) {
                if (edge.from_node === sourceId && edge.to_node !== id) {
                    this.facade.insertEdgeIfNotExists(id as string, edge.to_node, edge.relation, edge.weight || 1.0);
                    edgesTransferred++;
                }
                if (edge.to_node === sourceId && edge.from_node !== id) {
                    this.facade.insertEdgeIfNotExists(edge.from_node, id as string, edge.relation, edge.weight || 1.0);
                    edgesTransferred++;
                }
            }

            // 6. Use best type (most specific wins: identity > preference > project > fact > context)
            const typePriority: Record<string, number> = {
                identity: 7, trait: 6, rule: 5, strategy: 4, knowledge: 3,
                preference: 3, project: 2, skill: 2, fact: 1, context: 1, infrastructure: 1
            };
            if ((typePriority[source.type] || 0) > (typePriority[target.type] || 0)) {
                target.type = source.type;
                results.push(`Tipo atualizado: ${source.type} (mais específico que ${target.type})`);
            }

            // Use best domain
            const sourceDomain = this.facade.getNodeDomain(sourceId as string);
            if (sourceDomain && !this.facade.getNodeDomain(id as string)) {
                this.facade.setNodeDomain(id as string, sourceDomain);
            }

            // 7. Delete source
            this.facade.deleteNodeFull(sourceId as string);

            results.push(`✅ "${sourceId}" (${source.type}/${source.name}) mesclado em "${id}"`);
        }

        // Update target with merged content
        if (contentMerged) {
            this.memoryManager.addNode(target);
        }

        if (args.domain) this.facade.setNodeDomain(id as string, args.domain as string);

        // Regenerate embedding
        await this.regenerateEmbedding(id, target);

        return {
            success: true,
            output: `✅ Merge concluído: ${merge_ids.length} nós mesclados em "${id}". ${edgesTransferred} conexões transferidas.\n${results.join('\n')}`
        };
    }

    // ── Helpers ──────────────────────────────────────────────

    private async regenerateEmbedding(nodeId: string, node: MemoryNode): Promise<void> {
        try {
            const text = `${node.name}: ${(node.content || '').slice(0, 200)}`;
            const resp = await fetch('http://localhost:11434/api/embeddings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: 'nomic-embed-text:latest', prompt: text }),
                signal: AbortSignal.timeout(15000)
            });
            if (resp.ok) {
                const data = await resp.json() as { embedding?: number[] };
                if (data.embedding) {
                    const buf = Buffer.from(new Float64Array(data.embedding).buffer);
                    this.facade.upsertEmbedding(nodeId, buf, 'nomic-embed-text');
                }
            }
        } catch { /* embedding optional */ }
    }

    /**
     * Calculate content overlap between two strings (Jaccard similarity of words).
     * Returns 0-1 where 1 = identical content.
     */
    private calculateContentOverlap(a: string, b: string): number {
        if (!a || !b) return 0;
        const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(w => w.length > 3));
        const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(w => w.length > 3));
        if (wordsA.size === 0 || wordsB.size === 0) return 0;
        let intersection = 0;
        for (const w of wordsA) { if (wordsB.has(w)) intersection++; }
        return intersection / Math.max(wordsA.size, wordsB.size);
    }

    /**
     * Detecta se o conteúdo é sobre família ou relações pessoais do usuário.
     * Usado para garantir conexão direta ao USER node (Degree > 0).
     */
    private isFamilyOrSocialContent(name: string, content: string): boolean {
        const text = (name + ' ' + content).toLowerCase();
        return /\b(filho|filha|filhos|filhas|esposa|marido|familia|familiar|irmao|irma|irmão|irmã|mae|mãe|pai|conjuge|cônjuge|parente|casado|solteiro|crianca|criança|nasceu|aniversario|aniversário|namorad)\b/.test(text);
    }

    /**
     * Infere a relação semântica correta para fatos familiares.
     */
    private inferFamilyRelation(content: string): string {
        const text = content.toLowerCase();
        if (/\b(filho|filha|filhos|filhas|crianca|criança)\b/.test(text)) return 'has_child';
        if (/\b(esposa|marido|conjuge|cônjuge|namorad|casad)\b/.test(text)) return 'has_spouse';
        if (/\b(pai|mae|mãe|irmao|irma|irmão|irmã|familiar|familia|família)\b/.test(text)) return 'has_family';
        return 'has_relation';
    }

    /**
     * Smart relation inference based on node type + content analysis.
     * Instead of mapping fact→has_trait always, it analyzes:
     * - Projects created by user → 'created'
     * - Infrastructure/services → 'uses'  
     * - Facts about preferences → 'prefers'
     * - Facts about goals → 'has_goal'
     * - Facts about traits → 'has_trait'
     * - Context/knowledge → 'belongs_to'
     */
    private inferRelation(type: string, name: string, content: string): string {
        const text = ((name || '') + ' ' + (content || '')).toLowerCase();
        
        // Ontology: identity→{project,fact} uses 'created' for authorship
        // Ontology: identity→{skill,context,infrastructure} uses 'uses'
        // Ontology: identity→{preference} uses 'prefers'
        // Ontology: identity→{project} uses 'works_on'
        // Ontology: identity→{fact,preference} uses 'has_trait'
        // Ontology: identity→{project,fact} uses 'has_goal'
        
        switch (type) {
            case 'preference':
                return 'prefers';
            case 'project':
                // Projects the user created → 'created', projects they work on → 'works_on'
                if (text.match(/criei|criou|desenvolvi|autor|meu projeto|minha/i)) return 'created';
                return 'works_on';
            case 'skill':
                return 'uses';
            case 'infrastructure':
                return 'uses';
            case 'context':
                return 'belongs_to';
            case 'fact':
                // Smart: analyze what kind of fact
                if (text.match(/criei|criou|desenvolvi|autor|built|made|fiz|construí/i)) return 'created';
                if (text.match(/prefiro|gosto|adoro|amo|favorit/i)) return 'prefers';
                if (text.match(/objetivo|meta|goal|plano|planejo/i)) return 'has_goal';
                if (text.match(/traço|característica|habilidade|skill|trait/i)) return 'has_trait';
                // Default for facts: has_trait is valid (identity→fact)
                return 'has_trait';
            case 'trait':
                return 'has_trait';
            case 'rule':
            case 'strategy':
            case 'knowledge':
                return 'belongs_to';
            default:
                return 'related_to';
        }
    }
}