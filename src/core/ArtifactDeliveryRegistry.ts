/**
 * ArtifactDeliveryRegistry — Registro centralizado de artefatos gerados e entregues.
 *
 * Responsabilidades:
 *   - Rastrear o ciclo de vida de cada artefato: CREATED → VALIDATED → DELIVERED
 *   - Deduplicar entregas: garantir que 1 artefato = 1 entrega por sessão
 *   - Persistir o estado em disco para sobreviver a replannings dentro do mesmo goal
 *   - Fornecer contexto de artefatos para decisões do GoalExecutionLoop
 *
 * Fundação para o ArtifactManager descrito em SPRINT_3_6:
 *   Esta é a camada de entrega. Versionamento, hashing e agrupamento
 *   serão adicionados iterativamente à medida que a arquitetura evoluir.
 *
 * Estados do artefato:
 *   CREATED    — arquivo escrito no workspace (write/exec_command)
 *   VALIDATED  — objetivo validado como atingido (Q4 achieved=true)
 *   DELIVERED  — send_document executado com sucesso
 *   SUPERSEDED — versão mais nova do mesmo artefato foi entregue
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { createLogger } from '../shared/AppLogger';

const log = createLogger('ArtifactDeliveryRegistry');

export type ArtifactStatus = 'CREATED' | 'VALIDATED' | 'DELIVERED' | 'SUPERSEDED';

export interface ArtifactRecord {
    artifactId: string;      // hash do path + goalId (estável e único)
    path: string;            // caminho relativo ao workspace
    goalId: string;
    sessionId: string;
    status: ArtifactStatus;
    createdAt: number;
    deliveredAt?: number;
    supersededBy?: string;   // artifactId que substituiu este
}

interface RegistryState {
    artifacts: Record<string, ArtifactRecord>;
    deliveredPaths: string[];  // paths já entregues (cache rápido)
    updatedAt: string;
}

export class ArtifactDeliveryRegistry {
    private artifacts = new Map<string, ArtifactRecord>();
    private deliveredPaths = new Set<string>();
    private persistPath: string;

    constructor(workspaceDir: string) {
        this.persistPath = path.join(workspaceDir, '.newclaw', 'delivery_registry.json');
        this.loadFromDisk();
    }

    // ── API pública ───────────────────────────────────────────────────────────

    /**
     * Registra um artefato como criado/modificado.
     * Não marca como entregue — use markDelivered() após o send_document.
     */
    recordCreated(artifactPath: string, goalId: string, sessionId: string): ArtifactRecord {
        const artifactId = this.makeId(artifactPath, goalId);
        const existing = this.artifacts.get(artifactId);
        if (existing && existing.status === 'DELIVERED') {
            // Nova versão: marca a antiga como SUPERSEDED
            existing.status = 'SUPERSEDED';
            existing.supersededBy = artifactId;
            log.info(
                `[DELIVERY-REGISTRY] artifact="${artifactPath}"` +
                ` goal=${goalId} status=SUPERSEDED` +
                ` reason=new_version_created`
            );
        }
        const record: ArtifactRecord = {
            artifactId,
            path: artifactPath,
            goalId,
            sessionId,
            status: 'CREATED',
            createdAt: Date.now(),
        };
        this.artifacts.set(artifactId, record);
        log.info(
            `[DELIVERY-REGISTRY] artifact="${artifactPath}"` +
            ` artifact_id=${artifactId}` +
            ` goal=${goalId}` +
            ` session=${sessionId}` +
            ` status=CREATED`
        );
        this.saveToDisk();
        return record;
    }

    /**
     * Marca um artefato como entregue após send_document bem-sucedido.
     * Retorna false se já foi entregue (dedup).
     */
    markDelivered(artifactPath: string, goalId: string): boolean {
        if (this.deliveredPaths.has(artifactPath)) {
            log.info(
                `[DELIVERY-REGISTRY] artifact="${artifactPath}"` +
                ` goal=${goalId}` +
                ` status=already_delivered` +
                ` decision=skip`
            );
            return false;
        }
        const artifactId = this.makeId(artifactPath, goalId);
        const record = this.artifacts.get(artifactId) ?? {
            artifactId,
            path: artifactPath,
            goalId,
            sessionId: 'unknown',
            status: 'CREATED' as ArtifactStatus,
            createdAt: Date.now(),
        };
        record.status = 'DELIVERED';
        record.deliveredAt = Date.now();
        this.artifacts.set(artifactId, record);
        this.deliveredPaths.add(artifactPath);
        log.info(
            `[DELIVERY-REGISTRY] artifact="${artifactPath}"` +
            ` artifact_id=${artifactId}` +
            ` goal=${goalId}` +
            ` status=DELIVERED` +
            ` delivered_at=${new Date(record.deliveredAt).toISOString()}`
        );
        this.saveToDisk();
        return true;
    }

    /**
     * Verifica se um artefato já foi entregue nesta ou em sessões anteriores.
     */
    isDelivered(artifactPath: string): boolean {
        return this.deliveredPaths.has(artifactPath);
    }

    /**
     * Retorna todos os artefatos com status DELIVERED para um goal.
     */
    getDeliveredForGoal(goalId: string): ArtifactRecord[] {
        return [...this.artifacts.values()]
            .filter(r => r.goalId === goalId && r.status === 'DELIVERED');
    }

    /**
     * Retorna um sumário para injeção no contexto cognitivo do LLM.
     */
    buildContextBlock(goalId: string): string {
        const delivered = this.getDeliveredForGoal(goalId);
        if (delivered.length === 0) return '';
        const lines = ['Artefatos já entregues neste goal (não reenviar):'];
        for (const r of delivered) {
            lines.push(`  • ${r.path} (entregue em ${new Date(r.deliveredAt!).toISOString()})`);
        }
        return lines.join('\n');
    }

    // ── Persistência ─────────────────────────────────────────────────────────

    private makeId(artifactPath: string, goalId: string): string {
        return crypto.createHash('sha1').update(`${goalId}:${artifactPath}`).digest('hex').slice(0, 12);
    }

    private loadFromDisk(): void {
        try {
            if (!fs.existsSync(this.persistPath)) return;
            const raw = fs.readFileSync(this.persistPath, 'utf-8');
            const state: RegistryState = JSON.parse(raw);
            for (const [id, rec] of Object.entries(state.artifacts ?? {})) {
                this.artifacts.set(id, rec);
                if (rec.status === 'DELIVERED' && rec.path) {
                    this.deliveredPaths.add(rec.path);
                }
            }
            log.info(`[DELIVERY-REGISTRY] loaded artifacts=${this.artifacts.size} delivered=${this.deliveredPaths.size}`);
        } catch {
            // Registry inexistente ou corrompido — começa limpo
        }
    }

    private saveToDisk(): void {
        try {
            const dir = path.dirname(this.persistPath);
            fs.mkdirSync(dir, { recursive: true });
            const state: RegistryState = {
                artifacts: Object.fromEntries(this.artifacts),
                deliveredPaths: [...this.deliveredPaths],
                updatedAt: new Date().toISOString(),
            };
            fs.writeFileSync(this.persistPath, JSON.stringify(state, null, 2), 'utf-8');
        } catch (err) {
            log.warn(`[DELIVERY-REGISTRY] save_failed: ${String(err)}`);
        }
    }
}
