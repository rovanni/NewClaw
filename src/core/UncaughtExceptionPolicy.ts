/**
 * UncaughtExceptionPolicy — Decisão centralizada sobre o que fazer quando um
 * uncaughtException/unhandledRejection escapa de todo try/catch.
 *
 * Motivação (auditoria adversarial 2026-07-12, achado B2): o NewClaw roda hoje em dois
 * ambientes com garantias de restart bem diferentes — Linux/VPS sob systemd (restart quase
 * imediato) e Windows via Tarefa Agendada (sem supervisor residente equivalente). Uma política
 * fixa de "sempre continuar" arrisca operar sobre estado corrompido; uma política fixa de
 * "sempre reiniciar" pode causar indisponibilidade maior no Windows do que o problema que
 * resolve. Por isso a decisão é OPERACIONAL (variável de ambiente), não de código, e fica
 * centralizada aqui — nenhum outro módulo deve reimplementar esta classificação.
 *
 * UNCAUGHT_EXCEPTION_POLICY=continue (padrão) | restart
 *   - continue: preserva o comportamento histórico — processo permanece vivo mesmo após
 *     TypeError/RangeError/ReferenceError ou qualquer outro uncaughtException inesperado,
 *     adequado a ambientes sem supervisor de restart rápido (ex.: Windows via Tarefa Agendada
 *     hoje).
 *   - restart: ambientes com supervisor residente (systemd, PM2) podem optar por encerrar o
 *     processo nesses casos e deixar o supervisor recuperar em estado limpo.
 *
 * Certas classes de erro (corrupção de SQLite, OOM, invariante explicitamente violada) SEMPRE
 * forçam saída, independente da política — não são "erro de tipo comum": indicam estado que
 * não pode ser confiavelmente continuado em nenhum ambiente.
 */

import crypto from 'crypto';
import { isWindows, isLinux, isMac } from '../utils/crossPlatform';
import { createLogger } from '../shared/AppLogger';

const log = createLogger('UncaughtExceptionPolicy');

export type UncaughtPolicyMode = 'continue' | 'restart';
export type UncaughtDecisionAction = 'continue' | 'exit';
export type UncaughtSeverity = 'critical' | 'high';
export type UncaughtCategory = 'unrecoverable' | 'configurable';

export interface UncaughtDecision {
    action: UncaughtDecisionAction;
    severity: UncaughtSeverity;
    category: UncaughtCategory;
    reason: string;
    policy: UncaughtPolicyMode;
}

/** Identifica esta execução do processo nos logs — gerado uma vez por boot. */
const runtimeId = crypto.randomUUID();

export function readUncaughtPolicyMode(): UncaughtPolicyMode {
    const raw = (process.env.UNCAUGHT_EXCEPTION_POLICY || 'continue').trim().toLowerCase();
    if (raw === 'continue' || raw === 'restart') return raw;
    log.warn('invalid_policy_value', `UNCAUGHT_EXCEPTION_POLICY="${raw}" inválido (use "continue" ou "restart") — usando "continue" (padrão seguro)`);
    return 'continue';
}

/**
 * Erros que indicam estado irrecuperável — sempre força saída, independente da política.
 * OOM/heap: memória do processo comprometida. Corrupção de SQLite: dado persistido inválido.
 * "invariant violated": convenção para asserts explícitos internos (nenhum hoje usa essa string,
 * mas o classificador já está pronto para quando existirem).
 */
function isAlwaysRestart(error: Error): boolean {
    const msg = error.message || '';
    return (
        msg.includes('ENOMEM') ||
        msg.includes('heap out of memory') ||
        msg.includes('FATAL') ||
        msg.includes('disk image is malformed') ||
        msg.includes('SQLITE_CORRUPT') ||
        msg.includes('invariant violated')
    );
}

/**
 * Decide a ação (continue|exit) para um erro, sem efeitos colaterais — puro e testável.
 *
 * Classificação (achado B2, requisito 4): fora do conjunto "sempre restart" acima, QUALQUER
 * uncaughtException/unhandledRejection — TypeError, RangeError, ReferenceError ou qualquer
 * outro tipo inesperado — é "configurável": segue a política operacional ativa, não seu tipo
 * específico. A distinção de tipo não muda o resultado; só entra no `reason` para forense.
 */
export function decideUncaughtExceptionAction(error: Error): UncaughtDecision {
    const policy = readUncaughtPolicyMode();

    if (isAlwaysRestart(error)) {
        return {
            action: 'exit',
            severity: 'critical',
            category: 'unrecoverable',
            reason: 'Erro indica estado irrecuperável (OOM, corrupção de banco ou invariante violada) — reinício obrigatório independente da política configurada.',
            policy,
        };
    }

    if (policy === 'restart') {
        return {
            action: 'exit',
            severity: 'high',
            category: 'configurable',
            reason: `Exceção inesperada (${error.constructor.name}) sob UNCAUGHT_EXCEPTION_POLICY=restart — encerrando para reinício controlado pelo supervisor.`,
            policy,
        };
    }
    return {
        action: 'continue',
        severity: 'high',
        category: 'configurable',
        reason: `Exceção inesperada (${error.constructor.name}) sob UNCAUGHT_EXCEPTION_POLICY=continue — processo mantido vivo (ambiente sem supervisor de restart imediato).`,
        policy,
    };
}

/** Loga a decisão com todos os campos exigidos pela auditoria e, se for o caso, executa o exit. */
export function applyUncaughtExceptionDecision(
    error: Error,
    source: 'uncaughtException' | 'unhandledRejection',
): void {
    const decision = decideUncaughtExceptionAction(error);
    const environment = isWindows ? 'windows' : isLinux ? 'linux' : isMac ? 'macos' : process.platform;

    log.error(source, error, decision.reason, {
        errorType: error.constructor.name,
        decision: decision.action,
        severity: decision.severity,
        category: decision.category,
        policy: decision.policy,
        timestamp: new Date().toISOString(),
        runtimeId,
        environment,
        kernelInstanceId: process.env.PM2_APP_NAME ?? process.env.APP_INSTANCE_ID ?? undefined,
    });

    if (decision.action === 'exit') {
        process.exit(1);
    }
}
