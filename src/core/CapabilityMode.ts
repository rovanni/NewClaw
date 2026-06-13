/**
 * CapabilityMode — Sistema de Modos Operacionais do NewClaw
 *
 * Define três níveis de autonomia operacional:
 *   SAFE      — máxima segurança, confirmação para ações importantes
 *   DEVELOPER — autonomia expandida para desenvolvimento de skills e ferramentas
 *   GOD       — acesso completo ao framework com mecanismos mínimos de recuperação
 *
 * Proteções absolutas (presentes em todos os modos):
 *   - Audit log completo
 *   - isDestructive() para rm -rf /, shutdown, mkfs, etc.
 *   - Confirmação obrigatória para exclusão em massa, remoção de diretórios,
 *     alteração de credenciais, acesso a secrets e operações irreversíveis
 */

export enum OperationalMode {
    SAFE      = 'safe',
    DEVELOPER = 'developer',
    GOD       = 'god',
}

export interface ModeCapabilities {
    /** exec_command sem confirmação por chamada (WorkflowEngine bypass) */
    auto_approve_exec: boolean;
    /** Instalação automática de dependências (npm, pip, cargo, composer, etc.) */
    install_dependencies: boolean;
    /** Criar novas skills no diretório skills/ */
    create_skills: boolean;
    /** Atualizar SKILL.md de skills existentes */
    update_skills: boolean;
    /** Remover skills existentes */
    remove_skills: boolean;
    /** Ferramentas locais do sistema (binários, scripts) */
    execute_shell: boolean;
    /** Modificar arquivos do framework (src/, dist/) */
    modify_core: boolean;
    /** Ler/modificar secrets (.env, arquivos de credencial) */
    access_secrets: boolean;
    /** Ignorar soft constraints do ReflectionMemory (histórico de falhas) */
    bypass_reflection_constraints: boolean;
    /** Ignorar BLOCK-HINTs do RiskAnalyzer (mantém hard blocks sempre) */
    bypass_block_hints: boolean;
    /** Criar e modificar agents */
    manage_agents: boolean;
    /** Modificar configurações avançadas de modelos e providers */
    modify_advanced_config: boolean;
}

/** Matriz de capabilities por modo */
const MODE_CAPABILITIES: Record<OperationalMode, ModeCapabilities> = {
    [OperationalMode.SAFE]: {
        auto_approve_exec:              false,
        install_dependencies:           false,
        create_skills:                  false,
        update_skills:                  false,
        remove_skills:                  false,
        execute_shell:                  false,
        modify_core:                    false,
        access_secrets:                 false,
        bypass_reflection_constraints:  false,
        bypass_block_hints:             false,
        manage_agents:                  false,
        modify_advanced_config:         false,
    },
    [OperationalMode.DEVELOPER]: {
        auto_approve_exec:              true,
        install_dependencies:           true,
        create_skills:                  true,
        update_skills:                  true,
        remove_skills:                  true,
        execute_shell:                  true,
        modify_core:                    false,
        access_secrets:                 false,
        bypass_reflection_constraints:  false,
        bypass_block_hints:             false,
        manage_agents:                  true,
        modify_advanced_config:         true,
    },
    [OperationalMode.GOD]: {
        auto_approve_exec:              true,
        install_dependencies:           true,
        create_skills:                  true,
        update_skills:                  true,
        remove_skills:                  true,
        execute_shell:                  true,
        modify_core:                    true,
        access_secrets:                 true,
        bypass_reflection_constraints:  true,
        bypass_block_hints:             true,
        manage_agents:                  true,
        modify_advanced_config:         true,
    },
};

/** Labels legíveis para exibição no dashboard */
export const MODE_LABELS: Record<OperationalMode, string> = {
    [OperationalMode.SAFE]:      'Safe Mode',
    [OperationalMode.DEVELOPER]: 'Developer Mode',
    [OperationalMode.GOD]:       'God Mode',
};

/** Descrições curtas para exibição no dashboard */
export const MODE_DESCRIPTIONS: Record<OperationalMode, string> = {
    [OperationalMode.SAFE]:
        'Máxima segurança. Confirmação obrigatória para exec_command e instalações. ' +
        'Recomendado para uso em produção com usuários finais.',
    [OperationalMode.DEVELOPER]:
        'Autonomia expandida para desenvolvimento. exec_command sem confirmação por chamada, ' +
        'instalação automática de dependências, gerenciamento de skills. ' +
        'Mantém ReflectionMemory e análise de riscos.',
    [OperationalMode.GOD]:
        'Acesso total ao framework. Bypass de constraints não-críticas. ' +
        'Audit log e proteções contra destruição permanecem ativos. ' +
        'Requer confirmação explícita para ativar.',
};

export function getCapabilities(mode: OperationalMode): ModeCapabilities {
    return MODE_CAPABILITIES[mode];
}

export function isValidMode(value: string): value is OperationalMode {
    return Object.values(OperationalMode).includes(value as OperationalMode);
}
