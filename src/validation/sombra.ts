/**
 * Modo sombra do motor único (ADR-014 M1–M6) — um só jeito de rodar um tipo do motor junto de um validador atual.
 *
 * Roda depois do veredito real, sem bloquear e sem mudar nada; compara o estado e registra a comparação no gravador
 * de voo do validador atual (efeito `sombra_motor_comparada`). É a evidência do critério de troca de cada tipo
 * (ADR-014 §5: concordância nos casos rotulados, desacordos conferidos à mão, tempo médio que não piora).
 *
 * Ligado por tipo em `VALIDACAO_SOMBRA` (ver sombraLigadaPara). Uma falha aqui nunca alcança o validador real.
 */
import type { ProviderFactory } from '../core/ProviderFactory';
import { createLogger } from '../shared/AppLogger';
import { gravarEfeito, type Avaliador, type ContextoAvaliacao } from '../shared/evaluatorFlightRecorder';
import type { VereditoPadrao } from './contratoDeValidacao';
import type { ValidationEngine } from './ValidationEngine';
import { criarMotorDeValidacao, sombraLigadaPara } from './motorPadrao';

const log = createLogger('ValidacaoSombra');

// Uma instância por ProviderFactory: o motor é só dados + a fábrica de provedores.
const motores = new WeakMap<object, ValidationEngine>();

export interface PedidoDeSombra<T> {
    providerFactory: ProviderFactory;
    tipo: string;
    entradas: Record<string, string | undefined>;
    contexto?: ContextoAvaliacao;
    /** Avaliador atual, em cujo gravador a comparação é registrada. */
    avaliadorAtual: Avaliador;
    avaliacaoIdAtual?: string;
    /** Estado do validador atual, já na escala comparável. */
    estadoAtual: string;
    /** Estado do motor na mesma escala. */
    estadoDoMotor: (adaptado: T, veredito: VereditoPadrao) => string;
    msAtual?: number;
    /** Fatos extras do validador atual para o registro (contagens, motivo). */
    detalheAtual?: Record<string, unknown>;
}

export function rodarEmSombra<T>(p: PedidoDeSombra<T>): void {
    if (!sombraLigadaPara(p.tipo)) return;
    void (async () => {
        const t0 = Date.now();
        let motor = motores.get(p.providerFactory);
        if (!motor) { motor = criarMotorDeValidacao(p.providerFactory); motores.set(p.providerFactory, motor); }
        const r = await motor.validar<T>(p.tipo, p.entradas, { ...p.contexto, phase: `sombra-${p.contexto?.phase ?? 'real'}` });
        const novo = p.estadoDoMotor(r.adaptado, r.veredito);
        const detalhe = {
            tipo: p.tipo, antigo: p.estadoAtual, novo, concorda: p.estadoAtual === novo,
            novoContagem: {
                sim: r.veredito.itens.filter(i => i.confere === 'sim').length,
                nao: r.veredito.itens.filter(i => i.confere === 'nao').length,
                sem_evidencia: r.veredito.itens.filter(i => i.confere === 'sem_evidencia').length,
            },
            citacoesNaoEncontradas: r.veredito.itens.filter(i => i.citacaoConfere === false).length,
            naoAvaliavelPorque: r.veredito.naoAvaliavelPorque,
            msAntigo: p.msAtual, msNovo: Date.now() - t0, avaliacaoDoMotor: r.veredito.avaliacaoId,
            ...p.detalheAtual,
        };
        gravarEfeito({ avaliacaoId: p.avaliacaoIdAtual, avaliador: p.avaliadorAtual, efeito: 'sombra_motor_comparada', detalhe, contexto: p.contexto });
        log.info(`[SOMBRA-MOTOR] ${JSON.stringify(detalhe)}`);
    })().catch(err => log.warn(`[SOMBRA-MOTOR] ${p.tipo} falhou (sem efeito no validador real): ${String(err).slice(0, 120)}`));
}
