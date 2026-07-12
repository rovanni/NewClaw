import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { createLogger } from '../shared/AppLogger';

const log = createLogger('DBRecovery');

/**
 * Substitui o arquivo de banco `dest` pelo conteúdo de `src`, removendo ANTES o WAL/SHM stale
 * do destino.
 *
 * Por que a limpeza do WAL/SHM é obrigatória (auditoria adversarial 2026-07-12, achado A2):
 * o NewClaw abre o SQLite em modo WAL (agentControllerSetup.openDatabase). Se copiarmos um `.db`
 * por cima de `dest` sem apagar o `dest-wal`/`dest-shm` remanescentes do banco antigo, na próxima
 * abertura o SQLite encontra um WAL que pertence a OUTRO banco e tenta aplicar seus frames sobre o
 * arquivo recém-copiado — resultado: "disk image is malformed". Este é exatamente o modo de falha
 * que o restore manual (index.ts) já tratava inline; a auto-recuperação NÃO tratava, então podia
 * reverter/loopar justamente no cenário que deveria salvar. Ponto único, usado pelos dois caminhos.
 */
export function replaceDatabaseFile(src: string, dest: string): void {
    for (const suffix of ['-wal', '-shm']) {
        try { fs.unlinkSync(dest + suffix); } catch { /* ok se não existir */ }
    }
    fs.copyFileSync(src, dest);
}

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
        // replaceDatabaseFile remove o WAL/SHM stale antes de copiar — sem isso o SQLite
        // reaplicaria o WAL do banco corrompido sobre o backup restaurado (ver A2 acima).
        replaceDatabaseFile(best, dbMain);
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
