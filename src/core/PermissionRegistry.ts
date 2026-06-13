/**
 * PermissionRegistry — Camada centralizada de autorização do NewClaw
 *
 * Singleton que mantém o modo operacional ativo e responde a consultas de
 * capabilities de qualquer componente do sistema. Todos os pontos de decisão
 * (RiskAnalyzer, GoalExecutionLoop, ReflectionMemory, exec_command) consultam
 * esta camada em vez de implementar lógica de permissão própria.
 *
 * Uso:
 *   const perm = PermissionRegistry.getInstance();
 *   if (perm.can('auto_approve_exec')) { ... }
 *   perm.setMode(OperationalMode.DEVELOPER);
 */

import { createLogger } from '../shared/AppLogger';
import {
    OperationalMode,
    ModeCapabilities,
    MODE_LABELS,
    getCapabilities,
    isValidMode,
} from './CapabilityMode';

const log = createLogger('PermissionRegistry');

export class PermissionRegistry {
    private static instance: PermissionRegistry;
    private mode: OperationalMode;
    private onChangeCallbacks: Array<(mode: OperationalMode) => void> = [];

    private constructor() {
        const envMode = process.env.CAPABILITY_MODE ?? OperationalMode.SAFE;
        this.mode = isValidMode(envMode) ? (envMode as OperationalMode) : OperationalMode.SAFE;
        log.info(`[PermissionRegistry] initialized: mode=${this.mode}`);
    }

    static getInstance(): PermissionRegistry {
        if (!PermissionRegistry.instance) {
            PermissionRegistry.instance = new PermissionRegistry();
        }
        return PermissionRegistry.instance;
    }

    getMode(): OperationalMode {
        return this.mode;
    }

    getModeLabel(): string {
        return MODE_LABELS[this.mode];
    }

    getCapabilities(): ModeCapabilities {
        return getCapabilities(this.mode);
    }

    /**
     * Verifica se a capability está disponível no modo atual.
     * Único ponto de consulta para todos os componentes.
     */
    can(capability: keyof ModeCapabilities): boolean {
        return getCapabilities(this.mode)[capability];
    }

    /**
     * Altera o modo operacional. Registra no audit log e notifica listeners.
     * GOD mode requer confirmação explícita (godModeConfirmed=true).
     */
    setMode(newMode: OperationalMode, source: string, godModeConfirmed = false): {
        success: boolean;
        error?: string;
    } {
        if (newMode === OperationalMode.GOD && !godModeConfirmed) {
            return { success: false, error: 'God Mode requer confirmação explícita (godModeConfirmed=true).' };
        }

        const previous = this.mode;
        this.mode = newMode;

        log.warn(`[PermissionRegistry] mode_changed: ${previous} → ${newMode} (source=${source})`);
        this.onChangeCallbacks.forEach(cb => cb(newMode));

        return { success: true };
    }

    /**
     * Registra listener para mudanças de modo.
     * Usado pelo OwnerProfileService para persistir a mudança no banco.
     */
    onChange(callback: (mode: OperationalMode) => void): void {
        this.onChangeCallbacks.push(callback);
    }

    /**
     * Inicializa o modo a partir do banco de dados (chamado no startup).
     * Não dispara callbacks de onChange — é uma restauração silenciosa.
     */
    restoreMode(savedMode: string): void {
        if (isValidMode(savedMode)) {
            this.mode = savedMode as OperationalMode;
            log.info(`[PermissionRegistry] mode_restored: ${this.mode}`);
        }
    }

    /**
     * Retorna um resumo do estado atual para o dashboard.
     */
    toJSON(): {
        mode: OperationalMode;
        label: string;
        capabilities: ModeCapabilities;
    } {
        return {
            mode: this.mode,
            label: this.getModeLabel(),
            capabilities: this.getCapabilities(),
        };
    }
}

// Exporta a instância global para uso em módulos que não podem importar o singleton diretamente
export const permissionRegistry = PermissionRegistry.getInstance();
