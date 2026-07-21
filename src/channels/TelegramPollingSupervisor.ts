/**
 * TelegramPollingSupervisor — controla o lifecycle do polling da API do Telegram.
 *
 * Responsabilidades:
 *   - PID lock (evita duas instâncias simultâneas)
 *   - Detecção de PM2 cluster mode
 *   - Retry com cooldown adaptativo após 409 Conflict
 *   - Circuit breaker após MAX_RETRIES falhas consecutivas
 *   - Estado observável (connected/cooldown/reconnecting/conflict/disconnected)
 *   - Graceful shutdown via SIGTERM/SIGINT
 *   - Notificação aos admins nos eventos críticos
 */

import { Bot } from 'grammy';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { errorMessage } from '../shared/errors';
import { createLogger } from '../shared/AppLogger';
import { stripHtmlTags } from '../shared/stripHtmlTags';

const log = createLogger('TelegramSupervisor');

export type TelegramConnectionState =
    | 'connected'
    | 'cooldown'
    | 'reconnecting'
    | 'conflict'
    | 'disconnected';

export interface SupervisorStatus {
    state: TelegramConnectionState;
    conflictCount: number;
    retryAttempt: number;
    maxRetries: number;
    lastConnectedAt: number | null;
    connectedUptimeMs: number;
    cooldownEndsAt: number | null;
    cooldownRemainingMs: number;
    instanceId: string;
    hostname: string;
    isClusterMode: boolean;
    isSecondaryInstance: boolean;
}

interface LockFile {
    pid: number;
    startedAt: number;
    hostname: string;
    instanceId: string;
}

// Cooldown adaptativo: 1º conflito=10s, 2º=20s, 3º=30s, 4º+=60s
const COOLDOWN_STEPS_SECS = [10, 20, 30, 60];
const MAX_RETRIES = 5;
const CIRCUIT_OPEN_SECS = 300; // 5 min após circuit breaker abrir

export class TelegramPollingSupervisor {
    private state: TelegramConnectionState = 'disconnected';
    private conflictCount = 0;
    private retryAttempt = 0;
    private networkRetryCount = 0;
    private lastConnectedAt: number | null = null;
    private cooldownEndsAt: number | null = null;
    private pollingActive = false;
    private stopped = false;

    // Usado para cancelar o sleep quando stop() é chamado
    private pendingSleepResolve: (() => void) | null = null;

    private readonly instanceId: string;
    private readonly hostname: string;
    private readonly lockFile: string;
    private clusterInfo = { isCluster: false, isSecondary: false, instanceId: '0' };

    constructor(
        private readonly bot: Bot,
        private readonly allowedUserIds: string[],
        lockFilePath: string,
    ) {
        this.lockFile    = path.resolve(lockFilePath);
        this.instanceId  = process.env.PM2_APP_NAME ?? process.env.APP_INSTANCE_ID ?? 'newclaw';
        this.hostname    = os.hostname();

        const onShutdown = () => { this.stop().catch(() => {}); };
        process.once('SIGTERM', onShutdown);
        process.once('SIGINT',  onShutdown);
    }

    getStatus(): SupervisorStatus {
        const now = Date.now();
        return {
            state:               this.state,
            conflictCount:       this.conflictCount,
            retryAttempt:        this.retryAttempt,
            maxRetries:          MAX_RETRIES,
            lastConnectedAt:     this.lastConnectedAt,
            connectedUptimeMs:   (this.state === 'connected' && this.lastConnectedAt) ? now - this.lastConnectedAt : 0,
            cooldownEndsAt:      this.cooldownEndsAt,
            cooldownRemainingMs: (this.cooldownEndsAt && this.cooldownEndsAt > now) ? this.cooldownEndsAt - now : 0,
            instanceId:          this.instanceId,
            hostname:            this.hostname,
            isClusterMode:       this.clusterInfo.isCluster,
            isSecondaryInstance: this.clusterInfo.isSecondary,
        };
    }

    async start(): Promise<void> {
        if (this.pollingActive) {
            log.warn('already_polling', '[TELEGRAM] polling já está ativo — ignorando start() duplicado');
            return;
        }

        this.stopped = false;

        // Detecção de cluster mode
        this.clusterInfo = TelegramPollingSupervisor.detectClusterMode();
        if (this.clusterInfo.isCluster) {
            const warn = `⚠️ <b>PM2 cluster mode detectado</b>\n`
                       + `(exec_mode=${process.env.exec_mode ?? 'fork'} instances=${process.env.PM2_INSTANCE_TOTAL ?? '1'} NODE_APP_INSTANCE=${this.clusterInfo.instanceId})\n\n`
                       + `Telegram polling é incompatível com múltiplas instâncias.\n`
                       + `A API do Telegram permite apenas um consumidor <code>getUpdates</code> por BOT_TOKEN.\n`
                       + `O canal Telegram será mantido apenas na instância principal.\n`
                       + `Recomenda-se usar <code>exec_mode: "fork"</code> no ecosystem.config.`;
            log.error('cluster_mode_detected', stripHtmlTags(warn));
            await this.notifyAdmins(warn);
        }

        if (this.clusterInfo.isSecondary) {
            log.error('cluster_secondary_skip',
                `[TELEGRAM] ⚠️ Outra instância do TelegramAdapter já está ativa. `
                + `Polling desabilitado nesta instância (PM2 #${this.clusterInfo.instanceId}).`);
            this.setState('disconnected');
            return;
        }

        if (!this.acquireLock()) {
            log.warn('lock_held',
                `[TELEGRAM] ⚠️ Outra instância do TelegramAdapter já está ativa. Polling desabilitado nesta instância.`);
            this.setState('disconnected');
            return;
        }

        // Limpa webhook stale para liberar conexão anterior
        try { await this.bot.api.deleteWebhook(); } catch { /* ignore */ }

        // Período de graça para o processo anterior encerrar
        const gracePeriodMs = parseInt(process.env.TELEGRAM_START_GRACE_MS || '3000', 10);
        if (gracePeriodMs > 0) {
            log.info('startup_grace', `[TELEGRAM] Aguardando ${gracePeriodMs}ms para o processo anterior encerrar...`);
            await this.sleep(gracePeriodMs);
        }

        this.pollingActive = true;
        try {
            await this.pollingLoop();
        } finally {
            this.pollingActive = false;
        }
    }

    async stop(): Promise<void> {
        this.stopped = true;

        // Cancela sleep pendente (saída antecipada do cooldown)
        if (this.pendingSleepResolve) {
            this.pendingSleepResolve();
            this.pendingSleepResolve = null;
        }

        try {
            await this.bot.api.deleteWebhook({ drop_pending_updates: true });
        } catch { /* ignore */ }

        // Aguarda o Telegram processar o drop e liberar a conexão getUpdates (~5s)
        await new Promise(r => setTimeout(r, 5000));

        this.releaseLock();

        try { this.bot.stop(); } catch { /* ignore */ }

        this.setState('disconnected');
        log.info('supervisor_stopped', '[TELEGRAM] polling stopped gracefully');
    }

    // ─── Loop principal ───────────────────────────────────────────────────────

    private async pollingLoop(): Promise<void> {
        while (!this.stopped) {
            // Circuit breaker: retries esgotados → cooldown longo antes de resetar
            if (this.retryAttempt > MAX_RETRIES) {
                await this.handleCircuitBreaker();
                if (this.stopped) return;
                continue;
            }

            this.setState('reconnecting');
            log.info('reconnect_attempt', `[TELEGRAM] reconnect attempt ${this.retryAttempt + 1}`);

            try {
                const info = await this.bot.api.getMe();
                log.info('polling_precheck', `[TELEGRAM] getMe OK: @${info.username} (id=${info.id})`);

                const hadConflict = this.conflictCount > 0;

                await this.bot.start({
                    onStart: () => {
                        this.setState('connected');
                        this.lastConnectedAt = Date.now();
                        this.retryAttempt    = 0;
                        this.networkRetryCount = 0;
                        log.info('polling_connected', '[TELEGRAM] polling connected');
                        if (hadConflict) {
                            this.notifyAdmins('✅ <b>Telegram bot reconectado</b>\nConflito de instâncias resolvido. Bot operacional.').catch(() => {});
                        }
                    },
                });

                // bot.start() resolveu → bot parou externamente (via stop())
                log.info('polling_resolved', '[TELEGRAM] polling stopped (external stop)');
                return;

            } catch (e) {
                if (this.stopped) return;
                const msg = errorMessage(e) ?? '';

                if (msg.includes('409') || msg.includes('Conflict')) {
                    await this.handle409();
                    continue;
                }

                if (this.isNetworkError(msg)) {
                    await this.handleNetworkError(msg);
                    continue;
                }

                this.setState('disconnected');
                throw e;
            }
        }
    }

    // ─── Handlers de erro ────────────────────────────────────────────────────

    private async handle409(): Promise<void> {
        this.conflictCount++;
        this.retryAttempt++;
        this.setState('conflict');

        if (this.retryAttempt > MAX_RETRIES) return;

        const cooldownSecs = COOLDOWN_STEPS_SECS[Math.min(this.retryAttempt - 1, COOLDOWN_STEPS_SECS.length - 1)];
        this.cooldownEndsAt = Date.now() + cooldownSecs * 1000;

        log.error('polling_conflict',
            `[TELEGRAM] polling conflict detected\n`
            + `⚠️  O Telegram ainda possui uma conexão ativa do processo anterior.\n`
            + `   Isso normalmente acontece durante reinicializações do PM2.\n`
            + `   Tentando recuperação automática:\n`
            + `     1. Desconectando polling atual\n`
            + `     2. Aguardando liberação da sessão pelo Telegram\n`
            + `     3. Reconectando automaticamente em ${cooldownSecs} segundos`);

        log.info('entering_cooldown', `[TELEGRAM] entering cooldown ${cooldownSecs * 1000}ms (attempt ${this.retryAttempt}/${MAX_RETRIES})`);

        await this.notifyAdmins(
            `⚠️ <b>Conflito de instâncias detectado</b> (tentativa ${this.retryAttempt}/${MAX_RETRIES})\n`
            + `O bot foi desconectado e irá reconectar em ${cooldownSecs}s.`
        );

        // Força o Telegram a liberar a conexão getUpdates anterior
        try { await this.bot.api.deleteWebhook({ drop_pending_updates: false }); } catch { /* ignore */ }

        this.setState('cooldown');
        await this.sleep(cooldownSecs * 1000);
        this.cooldownEndsAt = null;

        log.info('cooldown_done', `[TELEGRAM] reconnect attempt ${this.retryAttempt}`);
    }

    private async handleNetworkError(msg: string): Promise<void> {
        this.networkRetryCount++;
        const delaySecs = Math.min(this.networkRetryCount * 10, 300);
        this.cooldownEndsAt = Date.now() + delaySecs * 1000;
        this.setState('cooldown');

        log.error('network_error',
            `[TELEGRAM] network error on start (attempt ${this.networkRetryCount}). `
            + `Reconnect in ${delaySecs}s: ${msg}`);

        await this.sleep(delaySecs * 1000);
        this.cooldownEndsAt = null;
    }

    private async handleCircuitBreaker(): Promise<void> {
        this.setState('conflict');

        log.error('circuit_open',
            `[TELEGRAM] Circuit breaker aberto após ${this.conflictCount} conflitos consecutivos. `
            + `Próxima tentativa automática em ${CIRCUIT_OPEN_SECS}s.`);

        await this.notifyAdmins(
            `❌ <b>Telegram bot offline</b>\n`
            + `Conflito de instâncias não resolvido após ${this.conflictCount} tentativas.\n`
            + `Verifique se há múltiplos processos rodando com o mesmo token.\n`
            + `Próxima tentativa automática em ${Math.round(CIRCUIT_OPEN_SECS / 60)} minutos.`
        );

        this.cooldownEndsAt = Date.now() + CIRCUIT_OPEN_SECS * 1000;
        await this.sleep(CIRCUIT_OPEN_SECS * 1000);
        this.cooldownEndsAt = null;

        // Reset após circuit cooldown — tenta novamente do zero
        this.retryAttempt = 0;
        this.conflictCount = 0;

        log.info('circuit_reset', '[TELEGRAM] circuit breaker reset — retrying polling');
    }

    // ─── PID Lock ────────────────────────────────────────────────────────────

    private acquireLock(): boolean {
        try {
            if (fs.existsSync(this.lockFile)) {
                let existing: LockFile | null = null;
                try { existing = JSON.parse(fs.readFileSync(this.lockFile, 'utf8')) as LockFile; } catch { /* corrupted */ }

                if (existing && existing.pid !== process.pid) {
                    try {
                        process.kill(existing.pid, 0);
                        log.warn('lock_held_by_other',
                            `PID lock: pid=${existing.pid} hostname=${existing.hostname} `
                            + `instance=${existing.instanceId} startedAt=${new Date(existing.startedAt).toISOString()} — skipping`);
                        return false;
                    } catch {
                        log.info('lock_stale', `Stale lock from PID ${existing.pid} (process dead) — claiming`);
                    }
                }
            }

            fs.mkdirSync(path.dirname(this.lockFile), { recursive: true });
            const data: LockFile = {
                pid:       process.pid,
                startedAt: Date.now(),
                hostname:  this.hostname,
                instanceId: this.instanceId,
            };
            fs.writeFileSync(this.lockFile, JSON.stringify(data, null, 2), 'utf8');
            log.info('lock_acquired', `Polling lock acquired pid=${data.pid} hostname=${data.hostname} instance=${data.instanceId}`);
            return true;
        } catch (e) {
            log.warn('lock_error', `PID lock error: ${errorMessage(e)} — proceeding anyway`);
            return true;
        }
    }

    private releaseLock(): void {
        try {
            if (fs.existsSync(this.lockFile)) {
                let existing: LockFile | null = null;
                try { existing = JSON.parse(fs.readFileSync(this.lockFile, 'utf8')) as LockFile; } catch { /* ignore */ }
                if (existing?.pid === process.pid) {
                    fs.unlinkSync(this.lockFile);
                    log.info('lock_released', `Polling lock released pid=${process.pid}`);
                }
            }
        } catch { /* ignore */ }
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────

    private setState(state: TelegramConnectionState): void {
        if (this.state !== state) {
            log.info('state_change', `[TELEGRAM] ${this.state} → ${state}`);
            this.state = state;
        }
    }

    private async notifyAdmins(text: string): Promise<void> {
        for (const userId of this.allowedUserIds) {
            try {
                await this.bot.api.sendMessage(userId, text, { parse_mode: 'HTML' });
            } catch { /* ignore — bot pode estar offline */ }
        }
    }

    private sleep(ms: number): Promise<void> {
        return new Promise<void>(resolve => {
            this.pendingSleepResolve = resolve;
            const timer = setTimeout(() => {
                this.pendingSleepResolve = null;
                resolve();
            }, ms);
            // Se já foi marcado como stopped antes do sleep, cancela imediatamente
            if (this.stopped) {
                clearTimeout(timer);
                this.pendingSleepResolve = null;
                resolve();
            }
        });
    }

    private isNetworkError(msg: string): boolean {
        return msg.includes('Network') || msg.includes('ECONNREFUSED') ||
               msg.includes('ENOTFOUND') || msg.includes('ETIMEDOUT') ||
               msg.includes('fetch failed') || msg.includes('request failed');
    }

    private static detectClusterMode(): { isCluster: boolean; isSecondary: boolean; instanceId: string } {
        const instanceId = process.env.NODE_APP_INSTANCE ?? '0';
        const execMode   = process.env.exec_mode ?? 'fork';
        const instances  = parseInt(process.env.PM2_INSTANCE_TOTAL ?? '1', 10);
        const isCluster  = execMode === 'cluster' || instances > 1;
        return { isCluster, isSecondary: isCluster && instanceId !== '0', instanceId };
    }
}
