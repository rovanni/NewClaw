/**
 * schedule_tool — Ferramenta para o LLM agendar mensagens recorrentes
 * 
 * Permite ao usuário pedir: "Me mande previsão do tempo às 8h, 12h e 18h"
 * e o LLM cria tarefas agendadas automaticamente.
 */

import { ToolExecutor, ToolResult } from '../loop/agentLoopTypes';
import { SchedulerService } from '../services/SchedulerService';
import { errorMessage } from '../shared/errors';

export class ScheduleTool implements ToolExecutor {
    name = 'schedule';
    description = 'Agendar mensagens recorrentes para o usuário. Exemplos: "me mande previsão do tempo às 8h, 12h e 18h", "todo dia às 9h me mande cotação de BTC e ETH", "agende relatório de cripto às 7:30". Ações: create (criar agendamento), list (listar agendamentos), delete (remover), toggle (ativar/desativar).';
    parameters = {
        type: 'object',
        properties: {
            action: {
                type: 'string',
                enum: ['create', 'list', 'delete', 'toggle'],
                description: 'Ação: create (novo agendamento), list (listar), delete (remover), toggle (ativar/desativar)'
            },
            chat_id: { type: 'string', description: 'ID do chat/destinatário (obrigatório para create)' },
            label: { type: 'string', description: 'Nome/descrição do agendamento (create)' },
            time: { type: 'string', description: 'Horários. Todo dia: lista só de horários com o mesmo minuto ("8h, 12h, 18h", "8:30", "7:30 e 19:30"). Dia da semana, dia do mês, mês ou intervalo: expressão cron de 5 campos, "minuto hora dia-do-mês mês dia-da-semana" (ex.: "0 9 * * 1" = segundas às 9h; "*/15 * * * *" = a cada 15 min; dia da semana 0 ou 7 = domingo).' },
            type_action: { type: 'string', description: 'Tipo: weather, crypto, custom (create)' },
            params: { type: 'string', description: 'Parâmetros extras em JSON (create)' },
            task_id: { type: 'number', description: 'ID da tarefa (delete/toggle)' },
            active: { type: 'boolean', description: 'Ativar ou desativar (toggle)' }
        },
        required: ['action']
    };

    private scheduler: SchedulerService;
    private currentChatId: string = '';
    private currentChannel: string = 'telegram';

    constructor(scheduler: SchedulerService) {
        this.scheduler = scheduler;
    }

    setContext(chatId: string, channel?: string): void {
        this.currentChatId = chatId;
        this.currentChannel = channel || 'telegram';
    }

    async execute(args: Record<string, any>): Promise<ToolResult> {
        try {
            const action = args.action;

            // S489 (18/11/2026, instância isolada com modelo real): o modelo mandou `frequency: "weekly"`, `day: "monday"` e
            // `time: "09:00"`. Campos fora do esquema eram ignorados sem aviso, e a tarefa nascia diária. Campo desconhecido
            // agora recusa a chamada inteira, dizendo quais e onde a informação cabe.
            const aceitos = Object.keys(this.parameters.properties);
            const desconhecidos = Object.keys(args ?? {}).filter(k => !aceitos.includes(k));
            if (desconhecidos.length > 0) {
                return {
                    success: false, output: '',
                    error: `Campos que esta ferramenta não tem: ${desconhecidos.join(', ')}. Nada foi feito. Campos aceitos: ${aceitos.join(', ')}. Dia da semana, dia do mês ou mês vão em "time" como expressão cron de 5 campos ("0 9 * * 1" = segundas às 9h); o nome do agendamento vai em "label".`,
                };
            }

            if (action === 'create') {
                const chatId = args.chat_id || this.currentChatId;
                if (!chatId) return { success: false, error: 'chat_id é obrigatório.', output: '' };
                if (!args.time) return { success: false, error: 'Informe os horários. Ex: "8h, 12h, 18h"', output: '' };

                const cronExpr = this.scheduler.parseTimeInput(args.time);
                if (!cronExpr) return {
                    success: false, output: '',
                    error: `Horário não aceito: "${args.time}". Formatos aceitos: lista só de horários, todo dia, com o mesmo minuto ("8h, 12h, 18h", "8:30"); ou expressão cron de 5 campos ("0 9 * * 1" = segundas às 9h). Horários com minutos diferentes precisam de um agendamento cada.`,
                };

                const actionInfo = args.type_action
                    ? { action_type: args.type_action, action_params: args.params || '{}' }
                    : this.scheduler.parseActionType(args.label || args.time);

                const label = args.label || `Agendamento ${actionInfo.action_type}`;

                const task = this.scheduler.createTask(
                    chatId, label, cronExpr,
                    actionInfo.action_type, actionInfo.action_params,
                    this.currentChannel
                );

                const timeDesc = this.scheduler.describeCron(cronExpr);
                return {
                    success: true,
                    output: `✅ Agendamento criado!\n📋 ID: #${task.id}\n🏷️ ${label}\n⏰ ${timeDesc}\n📌 Tipo: ${actionInfo.action_type}\n\nVou te enviar automaticamente nesses horários!`
                };
            }

            if (action === 'list') {
                const chatId = args.chat_id || this.currentChatId;
                const tasks = this.scheduler.listTasks(chatId);

                if (tasks.length === 0) {
                    return { success: true, output: '📭 Nenhum agendamento ativo.' };
                }

                const lines = tasks.map(t => {
                    const timeDesc = this.scheduler.describeCron(t.cron_expr);
                    const status = t.active ? '🟢' : '🔴';
                    const lastRun = t.last_run ? `(último: ${t.last_run})` : '';
                    return `${status} #${t.id} — ${t.label}\n   ⏰ ${timeDesc} | ${t.action_type} ${lastRun}`;
                });

                return { success: true, output: `📋 Seus agendamentos:\n\n${lines.join('\n\n')}` };
            }

            if (action === 'delete') {
                if (!args.task_id) return { success: false, error: 'Informe o task_id para deletar.', output: '' };
                const deleted = this.scheduler.deleteTask(args.task_id);
                if (deleted) {
                    return { success: true, output: `✅ Agendamento #${args.task_id} removido.` };
                }
                return { success: false, error: `Agendamento #${args.task_id} não encontrado.`, output: '' };
            }

            if (action === 'toggle') {
                if (!args.task_id) return { success: false, error: 'Informe o task_id e active (true/false).', output: '' };
                const active = args.active !== false;
                const task = this.scheduler.toggleTask(args.task_id, active);
                if (task) {
                    return { success: true, output: `✅ Agendamento #${args.task_id} ${active ? 'ativado 🟢' : 'desativado 🔴'}.` };
                }
                return { success: false, error: `Agendamento #${args.task_id} não encontrado.`, output: '' };
            }

            return { success: false, error: `Ação "${action}" inválida.`, output: '' };

        } catch (error) {
            return { success: false, output: '', error: `Erro: ${errorMessage(error)}` };
        }
    }
}