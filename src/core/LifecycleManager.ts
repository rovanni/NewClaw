import { createLogger } from '../shared/AppLogger';

const log = createLogger('LifecycleManager');

type TimerHandle = ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>;

export interface LifecycleService {
    name: string;
    stop: () => void | Promise<void>;
}

export class LifecycleManager {
    private timers: Map<string, TimerHandle> = new Map();
    private services: LifecycleService[] = [];
    private shuttingDown = false;

    registerTimeout(name: string, callback: () => void, delayMs: number): TimerHandle {
        this.clearTimer(name);
        const timer = setTimeout(() => {
            this.timers.delete(name);
            callback();
        }, delayMs);
        this.timers.set(name, timer);
        return timer;
    }

    registerInterval(name: string, callback: () => void | Promise<void>, intervalMs: number): TimerHandle {
        this.clearTimer(name);
        const timer = setInterval(() => {
            Promise.resolve(callback()).catch(error => {
                log.error('interval_failed', error, name);
            });
        }, intervalMs);
        this.timers.set(name, timer);
        return timer;
    }

    registerService(name: string, stop: () => void | Promise<void>): void {
        this.services.push({ name, stop });
    }

    clearTimer(name: string): void {
        const timer = this.timers.get(name);
        if (!timer) return;
        clearTimeout(timer);
        clearInterval(timer);
        this.timers.delete(name);
    }

    async shutdown(reason: string = 'shutdown'): Promise<void> {
        if (this.shuttingDown) return;
        this.shuttingDown = true;

        log.info('shutdown_started', reason, {
            timers: this.timers.size,
            services: this.services.length
        });

        for (const [name, timer] of this.timers) {
            clearTimeout(timer);
            clearInterval(timer);
            log.debug('timer_stopped', name);
        }
        this.timers.clear();

        for (const service of [...this.services].reverse()) {
            try {
                await service.stop();
                log.info('service_stopped', service.name);
            } catch (error) {
                log.error('service_stop_failed', error, service.name);
            }
        }

        log.info('shutdown_complete', reason);
    }
}
