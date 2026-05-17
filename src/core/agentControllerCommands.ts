import { errorMessage } from '../shared/errors';
import type { MessageBus } from '../channels/MessageBus';
import type { MemoryManager } from '../memory/MemoryManager';
import type { MemoryFacade } from '../memory/MemoryFacade';
import type { SessionManager } from '../session/SessionManager';
import type { AuditorService } from '../services/auditor/AuditorService';
import { registerAuditCommand } from '../services/auditor/auditCommand';
import type { NewClawConfig } from './agentControllerTypes';
import type { AgentLoop } from '../loop/AgentLoop';

export function registerCommands(
    messageBus: MessageBus,
    memory: MemoryManager,
    memoryFacade: MemoryFacade,
    sessionManager: SessionManager,
    auditor: AuditorService,
    config: NewClawConfig,
    agentLoop: AgentLoop
): void {
    for (const cmd of ['/cancelar', '/cancel', '/stop', '/pare']) {
        messageBus.registerCommand(cmd, async (msg) => {
            agentLoop.cancel(msg.userId);
            return '⏹ Operação cancelada.';
        });
    }

    messageBus.registerCommand('/clear', async (msg) => {
        memory.createNewConversation(msg.userId);
        const sessionKey = { channel: msg.channel, userId: msg.userId };
        await sessionManager.closeSession(sessionKey);
        return '🧹 Sessão limpa! Contexto anterior comprimido. Nova sessão iniciada.';
    });

    messageBus.registerCommand('/skills', async (_msg) => {
        try {
            const skills = memoryFacade.listAutoSkills(10);
            if (skills.length === 0) return 'Nenhuma skill automática cadastrada ainda.';

            const lines = skills.map(skill => {
                const shortId = skill.id.slice(-8);
                const status = skill.status === 'proposed' ? 'PROPOSED' : skill.status === 'active' ? 'ACTIVE' : 'REJECTED';
                return `• **${skill.name}** [${status}]\n  id: \`${shortId}\` | origem: ${skill.source_pattern || 'manual'} → ${skill.source_tool || '—'} | pri: ${skill.priority}`;
            });

            return `🧠 **SkillLearner**\n\n${lines.join('\n\n')}\n\nAções:\n\`/skill_approve <id>\` / \`/skill_reject <id>\``;
        } catch (e) {
            return `⚠️ Erro ao listar skills: ${errorMessage(e)}`;
        }
    });

    messageBus.registerCommand('/skill_approve', async (msg) => {
        const parts = msg.text.trim().split(/\s+/);
        const rawId = parts[1];
        if (!rawId) return 'Use /skill_approve <id_curto>. Veja os IDs com /skills';
        try {
            const match = memoryFacade.findAutoSkillIdBySuffix(rawId);
            if (!match) return `Skill com ID curto "${rawId}" não encontrada.`;
            memoryFacade.setAutoSkillStatus(match, 'active');
            return `✅ Skill aprovada: ${match}`;
        } catch (e) {
            return `⚠️ Erro: ${errorMessage(e)}`;
        }
    });

    messageBus.registerCommand('/skill_reject', async (msg) => {
        const parts = msg.text.trim().split(/\s+/);
        const rawId = parts[1];
        if (!rawId) return 'Use /skill_reject <id_curto>. Veja os IDs com /skills';
        try {
            const match = memoryFacade.findAutoSkillIdBySuffix(rawId);
            if (!match) return `Skill com ID curto "${rawId}" não encontrada.`;
            memoryFacade.setAutoSkillStatus(match, 'rejected');
            return `❌ Skill rejeitada: ${match}`;
        } catch (e) {
            return `⚠️ Erro: ${errorMessage(e)}`;
        }
    });

    const ownerIds = [
        ...config.telegramAllowedUserIds,
        ...(config.discordAllowedUserIds || []),
        ...(config.whatsappAllowedJids || []),
        ...(config.signalAllowedNumbers || []),
    ];
    registerAuditCommand(messageBus, auditor, ownerIds);
}
