import { errorMessage } from '../shared/errors';
import { nomesNoCofre, apagarSegredo } from '../shared/segredos';
import type { MessageBus } from '../channels/MessageBus';
import type { MemoryManager } from '../memory/MemoryManager';
import type { MemoryFacade } from '../memory/MemoryFacade';
import type { SessionManager } from '../session/SessionManager';
import type { AuditorService } from '../services/auditor/AuditorService';
import { registerAuditCommand } from '../services/auditor/auditCommand';
import type { NewClawConfig } from './agentControllerTypes';
import type { AgentLoop } from '../loop/AgentLoop';
import type { GoalOrchestrator } from '../loop/GoalOrchestrator';
import type { SkillLearner } from '../loop/SkillLearner';

export function registerCommands(
    messageBus: MessageBus,
    memory: MemoryManager,
    memoryFacade: MemoryFacade,
    sessionManager: SessionManager,
    auditor: AuditorService,
    config: NewClawConfig,
    agentLoop: AgentLoop,
    goalOrchestrator: GoalOrchestrator,
    skillLearner?: SkillLearner,
): void {
    for (const cmd of ['/cancelar', '/cancel', '/stop', '/pare']) {
        messageBus.registerPriorityCommand(cmd, async (msg) => {
            // agentLoop.cancel() por si só só aborta a chamada de LLM/tool EM CURSO — se essa
            // chamada pertence a um step de Goal, o GoalExecutionLoop pode tratar o abort como
            // uma falha comum de step e replanejar/continuar o MESMO goal. cancelActiveGoal()
            // marca o goal ativo da sessão como 'abandoned', para que o checkpoint dedicado em
            // GoalExecutionLoop.ts realmente encerre o loop (ver comentário no método).
            // cancelarTurno cobre também a fase ANTES de existir goal (extração, roteador, suficiência, planejamento): o
            // clique em "Parar" logo depois do pedido caía num vazio (10/10/2026) e o pedido seguia.
            agentLoop.cancel(msg.userId);
            const cancelado = goalOrchestrator.cancelarTurno(msg.channel, msg.userId);
            return cancelado.turno || cancelado.goal ? '⏹ Operação cancelada.' : '⏹ Nada em andamento para cancelar.';
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

    // ADR-019: cofre de senhas. O valor de `/segredo <nome> <valor>` já foi guardado e trocado pelo marcador no
    // MessageBus.processMessage (antes de qualquer log) — aqui só se confirma; o comando nunca vê o valor.
    messageBus.registerCommand('/segredo', async (msg) => {
        const nome = msg.text.trim().split(/\s+/)[1];
        if (!nome || !/<SEGREDO:/.test(msg.text)) return 'Use /segredo <nome> <valor> — o valor vai para o cofre e some da conversa. Ver os guardados: /segredos';
        return `🔐 Guardado como <SEGREDO:${nome.toLowerCase()}>. Peça a tarefa normalmente; eu uso o marcador.`;
    });
    messageBus.registerCommand('/segredos', async () => {
        const nomes = nomesNoCofre();
        return nomes.length > 0
            ? `🔐 No cofre (só os nomes):\n${nomes.map(n => `• <SEGREDO:${n}>`).join('\n')}\nApagar: /segredo_apagar <nome>`
            : 'O cofre está vazio. Guardar: /segredo <nome> <valor>';
    });
    messageBus.registerCommand('/segredo_apagar', async (msg) => {
        const nome = msg.text.trim().split(/\s+/)[1];
        if (!nome) return 'Use /segredo_apagar <nome>. Ver os guardados: /segredos';
        try {
            return apagarSegredo(nome) ? `🗑️ Apagado do cofre: ${nome.toLowerCase()}` : `Nenhum segredo chamado "${nome}".`;
        } catch (e) {
            return `⚠️ Erro: ${errorMessage(e)}`;
        }
    });

    // ADR-017: o aviso "aprendi algo novo" traz este comando — desativa (remove o SKILL.md; reversível no painel de Skills).
    messageBus.registerCommand('/skill_desativar', async (msg) => {
        const alvo = msg.text.trim().split(/\s+/).slice(1).join(' ');
        if (!alvo) return 'Use /skill_desativar <nome>. Veja as skills com /skills';
        if (!skillLearner) return '⚠️ Aprendizado de skills indisponível.';
        try {
            const nome = skillLearner.deactivateSkillByName(alvo);
            return nome ? `↩️ Skill desativada: ${nome}` : `Nenhuma skill ativa chamada "${alvo}".`;
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
