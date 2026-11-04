/**
 * Contrato do turno, versão 2 (ADR-033, aprovada em 04/11/2026): as projeções do que o núcleo já sabe sobre um objetivo,
 * no formato público. Módulo-folha e só de funções puras (QUANDO_EXTRAIR_DUPLICACAO): a rota do painel (`/active`) e o
 * orquestrador (resultado na outbox) importam daqui, e nenhum dos dois importa o outro.
 *
 * Limites de exposição (ADR-033 §6): só sai texto escrito para a pessoa (a descrição da etapa), estados, contagens e
 * números. Nunca `toolName`, `toolArgs`, `result`, tentativas, vereditos ou raciocínio — o teste S474 enche esses campos
 * de marcadores e confere que nenhum aparece.
 */
import type { Goal, GoalStatus, PlanStep } from './domainTypes';

export const VERSAO_DO_CONTRATO = 2;

export type EstadoDoTrabalho = 'executando' | 'aguardando_aprovacao' | 'replanejando' | 'concluido' | 'falhou' | 'cancelado';
export type EstadoDaEtapa = 'pendente' | 'executando' | 'concluida' | 'pulada' | 'falhou';

export interface EtapaPublica { id: string; descricao: string; estado: EstadoDaEtapa }
export interface TrabalhoPublico {
    tipo: 'objetivo';
    estado: EstadoDoTrabalho;
    /** `planGeneration`: quando muda, o plano foi substituído e o cliente descarta as etapas que tinha. */
    plano: number;
    etapas: EtapaPublica[];
}
export interface ResultadoDaTarefa {
    estado: 'concluido' | 'falhou' | 'cancelado' | 'parcial';
    etapas: { total: number; concluidas: number };
}

/** Projeção estável de `GoalStatus`. `active`, e `blocked` sem aprovação pendente, são trabalho em andamento. */
export function estadoDoTrabalho(status: GoalStatus, aguardandoAprovacao: boolean): EstadoDoTrabalho {
    switch (status) {
        case 'completed': return 'concluido';
        case 'failed': return 'falhou';
        case 'abandoned': return 'cancelado';
        case 'replanning': return 'replanejando';
        case 'blocked': return aguardandoAprovacao ? 'aguardando_aprovacao' : 'executando';
        case 'active':
        case 'executing': return 'executando';
    }
}

const ESTADO_DA_ETAPA: Record<PlanStep['status'], EstadoDaEtapa> = {
    pending: 'pendente', executing: 'executando', completed: 'concluida', skipped: 'pulada', failed: 'falhou',
};

/** As etapas do plano vigente: só o texto que o planejador escreveu para a etapa (inteiro) e o estado. */
export function projetarTrabalho(goal: Pick<Goal, 'status' | 'currentPlan' | 'planGeneration' | 'pendingTxnId' | 'requiresAuth'>): TrabalhoPublico {
    return {
        tipo: 'objetivo',
        estado: estadoDoTrabalho(goal.status, !!goal.pendingTxnId || goal.requiresAuth),
        plano: goal.planGeneration ?? 0,
        etapas: (goal.currentPlan ?? []).map(s => ({ id: s.id, descricao: s.description, estado: ESTADO_DA_ETAPA[s.status] ?? 'pendente' })),
    };
}

/**
 * Resultado de um objetivo que terminou, para a outbox. O estado é o que o núcleo já decidiu: o `GoalStatus` final e, num
 * objetivo concluído, `parcial` quando alguma etapa concluída terminou com confiança baixa (`lastAttemptOutcome`).
 */
export function resultadoDaTarefa(goal: Pick<Goal, 'status' | 'currentPlan'>): ResultadoDaTarefa {
    const etapas = goal.currentPlan ?? [];
    const concluidas = etapas.filter(s => s.status === 'completed').length;
    const parcial = etapas.some(s => s.status === 'completed' && s.lastAttemptOutcome === 'partial');
    const estado: ResultadoDaTarefa['estado'] = goal.status === 'completed' ? (parcial ? 'parcial' : 'concluido')
        : goal.status === 'abandoned' ? 'cancelado' : 'falhou';
    return { estado, etapas: { total: etapas.length, concluidas } };
}

/**
 * `revisao`: número que só cresce, alterado quando o trabalho público muda (etapa, estado ou plano). Com `desdeRevisao`
 * igual, o servidor omite as etapas e a consulta frequente fica leve. Guardado por objetivo, em memória: reiniciar o
 * servidor recomeça a contagem, e o cliente que mandar uma revisão antiga só recebe as etapas de novo.
 */
const revisoes = new Map<string, { assinatura: string; revisao: number }>();
export function revisaoDoTrabalho(goalId: string, publico: unknown): number {
    const assinatura = JSON.stringify(publico);
    const atual = revisoes.get(goalId);
    if (atual && atual.assinatura === assinatura) return atual.revisao;
    const revisao = (atual?.revisao ?? 0) + 1;
    revisoes.set(goalId, { assinatura, revisao });
    if (revisoes.size > 500) revisoes.delete(revisoes.keys().next().value as string);
    return revisao;
}

/**
 * ADR-033 §4: o modelo e o provedor da ÚLTIMA chamada que respondeu num turno desta conversa (a resposta, não os juízes:
 * só chamadas marcadas `diag.respostaDaConversa`). Alimentado pelo `ProviderFactory`; em memória — reiniciar o servidor
 * apaga, e aí o contrato diz que não sabe (NUNCA_ADIVINHAR). Nunca o modelo configurado.
 */
export interface ModeloQueRespondeu { nome: string; provedor: string; em: string }
const modelos = new Map<string, ModeloQueRespondeu>();
export function registrarModeloQueRespondeu(conversa: string, provedor: string, nome: string): void {
    modelos.delete(conversa);
    modelos.set(conversa, { nome, provedor, em: new Date().toISOString() });
    if (modelos.size > 500) modelos.delete(modelos.keys().next().value as string);
}
/** Uma resposta veio de uma tentativa cujo modelo não se sabe: o registro anterior deixa de valer. */
export function esquecerModeloQueRespondeu(conversa: string): void {
    modelos.delete(conversa);
}
export function modeloQueRespondeu(conversa: string): ModeloQueRespondeu | undefined {
    return modelos.get(conversa);
}

/** `client` de POST /api/chat: até 64 caracteres de [a-z0-9._-]. Só informativo — nenhuma decisão do núcleo depende dele. */
export function clienteValido(valor: unknown): string | undefined {
    return typeof valor === 'string' && /^[a-z0-9._-]{1,64}$/.test(valor) ? valor : undefined;
}
