/**
 * NewClaw — Sistema de Logging Centralizado
 */

export class Logger {
    private static getTimestamp(): string {
        const now = new Date();
        return `[${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}]`;
    }

    static info(message: string, ...args: any[]): void {
        console.log(`${this.getTimestamp()} [INFO] ${message}`, ...args);
    }

    static warn(message: string, ...args: any[]): void {
        console.warn(`${this.getTimestamp()} [WARN] ⚠️ ${message}`, ...args);
    }

    static error(message: string, ...args: any[]): void {
        console.error(`${this.getTimestamp()} [ERROR] ❌ ${message}`, ...args);
    }

    static debug(tag: string, message: string, ...args: any[]): void {
        console.log(`${this.getTimestamp()} [${tag}] ${message}`, ...args);
    }

    /**
     * Override global console.log to include timestamps automatically
     */
    static hookGlobalConsole(): void {
        const originalLog = console.log;
        const originalWarn = console.warn;
        const originalError = console.error;

        console.log = (message?: any, ...optionalParams: any[]) => {
            if (typeof message === 'string') {
                originalLog(`${this.getTimestamp()} ${message}`, ...optionalParams);
            } else {
                originalLog(`${this.getTimestamp()}`, message, ...optionalParams);
            }
        };

        console.warn = (message?: any, ...optionalParams: any[]) => {
            if (typeof message === 'string') {
                originalWarn(`${this.getTimestamp()} ${message}`, ...optionalParams);
            } else {
                originalWarn(`${this.getTimestamp()}`, message, ...optionalParams);
            }
        };

        console.error = (message?: any, ...optionalParams: any[]) => {
            if (typeof message === 'string') {
                originalError(`${this.getTimestamp()} ${message}`, ...optionalParams);
            } else {
                originalError(`${this.getTimestamp()}`, message, ...optionalParams);
            }
        };
    }
}
