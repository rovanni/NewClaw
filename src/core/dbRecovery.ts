import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { createLogger } from '../shared/AppLogger';

const log = createLogger('DBRecovery');

// Retorna o caminho do melhor backup válido disponível em backupDir,
// priorizando pre-restore (criados automaticamente antes de um restore) sobre regulares.
// Retorna null se nenhum backup válido existir.
export function findBestValidBackup(backupDir: string): string | null {
    if (!fs.existsSync(backupDir)) return null;

    const all = fs.readdirSync(backupDir)
        .filter(f => f.endsWith('.db'))
        .sort()
        .reverse(); // mais recente primeiro

    const candidates = [
        ...all.filter(f => f.startsWith('database-pre-restore-')),
        ...all.filter(f => f.startsWith('database-') && !f.includes('pre-restore')),
    ];

    for (const name of candidates) {
        const filePath = path.join(backupDir, name);
        try {
            const db = new Database(filePath, { readonly: true });
            const row = db.prepare('PRAGMA integrity_check').get() as { integrity_check: string } | undefined;
            db.close();
            if (row?.integrity_check === 'ok') return filePath;
            log.warn('backup_invalid', `${name}: integrity_check="${row?.integrity_check}" — pulando`);
        } catch {
            log.warn('backup_unreadable', `${name}: não pôde ser aberto — pulando`);
        }
    }
    return null;
}

// Tenta recuperar o banco automaticamente a partir do melhor backup disponível.
// Retorna true se a recuperação foi bem-sucedida, false se não havia backup válido.
export function autoRecoverDatabase(dataDir: string): boolean {
    const backupDir = path.join(dataDir, 'backups');
    const dbMain    = path.join(dataDir, 'newclaw.db');

    log.warn('db_malformed',
        '🔴 Banco de dados corrompido ou ilegível — iniciando auto-recuperação...'
    );

    const best = findBestValidBackup(backupDir);
    if (!best) {
        log.error('auto_recovery_no_backup', undefined,
            '❌ Nenhum backup válido encontrado em data/backups/\n' +
            '   Recuperação manual: newclaw restore\n' +
            '   (se o newclaw CLI não responder: node scripts/recover-db.cjs)'
        );
        return false;
    }

    try {
        fs.copyFileSync(best, dbMain);
        log.info('auto_recovery_applied',
            `✅ Auto-recuperação aplicada: ${path.basename(best)}`
        );
        return true;
    } catch (err) {
        log.error('auto_recovery_copy_failed', err instanceof Error ? err : undefined,
            `Falha ao copiar ${path.basename(best)} → ${dbMain}`
        );
        return false;
    }
}
