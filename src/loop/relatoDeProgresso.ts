/**
 * Relato de progresso de um objetivo longo (ADR-027) — sem relógio que encerre o trabalho, quem espera precisa ver o que está
 * acontecendo. A cada `intervaloDoRelatoMs()`, uma mensagem no mesmo canal: há quanto tempo o objetivo roda, o que foi
 * concluído desde o último relato e o passo atual. Montado a partir de FATOS do goal (descrições do plano, tentativas), sem
 * chamada de modelo — não gasta cota e não pode inventar progresso.
 */
import type { Goal } from '../shared/domainTypes';
import type { SemanticStatusEvent } from '../shared/SemanticStatus';
import { mascararSegredos } from '../shared/segredos';

/** Minutos entre relatos: RELATO_DE_PROGRESSO_MIN (padrão 5; 0 desliga; inválido = o padrão). Lido a cada uso (o .env pode chegar depois). */
export function intervaloDoRelatoMs(): number {
    const n = Number(process.env.RELATO_DE_PROGRESSO_MIN?.trim() || NaN);
    const min = Number.isFinite(n) && n >= 0 ? n : 5;
    return min * 60_000;
}

/**
 * A descrição de um passo como o usuário a leria: sem os marcadores que o próprio loop acrescenta ao replanejar
 * ("[ATENÇÃO —", "[VERIFICAÇÃO —", "[INTENÇÃO DO PLANO]") e sem o prefixo de roteamento interno do planejador.
 */
export function descricaoParaOUsuario(descricao: string, max = 140): string {
    let d = (descricao ?? '').split(' [ATENÇÃO —')[0].split(' [VERIFICAÇÃO —')[0].split('[INTENÇÃO DO PLANO]')[0];
    d = d.replace(/^\s*(?:AgentLoop\s*\(step SEM toolName\)|SEM toolName(?:\s*\([^)]*\))?)\s*:?\s*/i, '');
    d = d.replace(/\s+/g, ' ').trim();
    return mascararSegredos(d.length > max ? `${d.slice(0, max - 1)}…` : d);
}

/**
 * O texto do relato. `desde` = epoch ms do relato anterior (ou do início). Concluído = passo do plano atual que terminou depois
 * de `desde` — pelo estado do passo (`completed`) ou por uma tentativa que não falhou. 'partial' conta: é o desfecho comum do
 * passo do agente e o GoalEvaluator o trata como progresso (teste real, 23/10/2026: contando só 'success', todos os relatos
 * diziam "nenhum passo novo" com o comando de 4 min já concluído). Agora = o primeiro passo ainda pendente.
 */
export function montarRelatoDeProgresso(goal: Goal, inicioMs: number, desde: number, agora: number = Date.now()): string {
    const minutos = Math.max(1, Math.round((agora - inicioMs) / 60_000));
    const porId = new Map(goal.currentPlan.map(s => [s.id, s]));
    const concluidos: string[] = [];
    const anotar = (descricao: string | undefined) => {
        const texto = descricao ? descricaoParaOUsuario(descricao) : '';
        if (texto && !concluidos.includes(texto)) concluidos.push(texto);
    };
    for (const s of goal.currentPlan) if (s.status === 'completed' && (s.executedAt ?? 0) >= desde) anotar(s.description);
    for (const a of goal.attempts ?? []) {
        if (a.result === 'failure' || a.executedAt < desde) continue;
        anotar(porId.get(a.planStepId)?.description);
    }
    const atual = goal.currentPlan.find(s => s.status === 'pending' || s.status === 'executing');
    const linhas = [`⏳ Ainda estou trabalhando no seu pedido (há ${minutos} min).`];
    linhas.push(concluidos.length
        ? `✔ Concluído desde o último aviso: ${concluidos.slice(0, 4).join('; ')}${concluidos.length > 4 ? ` (+${concluidos.length - 4})` : ''}.`
        : '✔ Nenhum passo novo concluído desde o último aviso.');
    if (atual) linhas.push(`▶ Agora: ${descricaoParaOUsuario(atual.description)}.`);
    linhas.push('Para interromper, envie /cancelar.');
    return linhas.join('\n');
}

/**
 * O relato de um turno de CONVERSA longo (fora de objetivo — o objetivo tem o seu, acima). Não há plano: o fato disponível é o
 * status do turno (a ferramenta em uso, ou que o modelo está pensando/montando a resposta). Code-review de 23/10/2026: sem
 * teto, um comando que trabalha sem parar deixava o turno só com "Pensando..." até o "Parar".
 */
export function montarRelatoDoTurno(inicioMs: number, agora: number, status?: SemanticStatusEvent): string {
    const minutos = Math.max(1, Math.round((agora - inicioMs) / 60_000));
    const fazendo = status?.status === 'executing_tool' && status.tool
        ? `usando a ferramenta ${status.tool}`
        : status?.status === 'synthesizing' ? 'montando a resposta' : 'pensando no próximo passo';
    return [`⏳ Ainda estou trabalhando no seu pedido (há ${minutos} min).`, `▶ Agora: ${fazendo}.`, 'Para interromper, envie /cancelar.'].join('\n');
}
