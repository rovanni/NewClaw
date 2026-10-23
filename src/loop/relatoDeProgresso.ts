/**
 * Relato de progresso de um objetivo longo (ADR-027) — sem relógio que encerre o trabalho, quem espera precisa ver o que está
 * acontecendo. A cada `intervaloDoRelatoMs()`, uma mensagem no mesmo canal: há quanto tempo o objetivo roda, o que foi
 * concluído desde o último relato e o passo atual. Montado a partir de FATOS do goal (descrições do plano, tentativas), sem
 * chamada de modelo — não gasta cota e não pode inventar progresso.
 */
import type { Goal } from '../shared/domainTypes';
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
 * O texto do relato. `desde` = epoch ms do relato anterior (ou do início). Concluído = passo do plano atual cuja tentativa
 * bem-sucedida aconteceu depois de `desde`; agora = o primeiro passo ainda pendente.
 */
export function montarRelatoDeProgresso(goal: Goal, inicioMs: number, desde: number, agora: number = Date.now()): string {
    const minutos = Math.max(1, Math.round((agora - inicioMs) / 60_000));
    const porId = new Map(goal.currentPlan.map(s => [s.id, s]));
    const concluidos: string[] = [];
    for (const a of goal.attempts ?? []) {
        if (a.result !== 'success' || a.executedAt < desde) continue;
        const passo = porId.get(a.planStepId);
        const texto = passo ? descricaoParaOUsuario(passo.description) : '';
        if (texto && !concluidos.includes(texto)) concluidos.push(texto);
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
