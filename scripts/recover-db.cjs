#!/usr/bin/env node
/**
 * NewClaw — Recuperação manual do banco de dados
 *
 * Use quando o PM2 está em crash loop por banco corrompido e
 * o dashboard está inacessível:
 *
 *   node scripts/recover-db.cjs
 *
 * Funciona sem build, sem PM2 e sem dashboard (Windows e Linux).
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const DIR        = path.join(__dirname, '..');
const DATA_DIR   = path.join(DIR, 'data');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const DB_MAIN    = path.join(DATA_DIR, 'newclaw.db');

function hr() { console.log('─'.repeat(50)); }

hr();
console.log('  🪐 NewClaw — Recuperação do Banco de Dados');
hr();

let Database;
try {
    Database = require('better-sqlite3');
} catch {
    console.error('\n❌ better-sqlite3 não encontrado. Execute: npm install\n');
    process.exit(1);
}

if (!fs.existsSync(BACKUP_DIR)) {
    console.error(`\n❌ Pasta não encontrada: ${BACKUP_DIR}`);
    console.error('   Nenhum backup disponível para recuperação.\n');
    process.exit(1);
}

const allFiles = fs.readdirSync(BACKUP_DIR)
    .filter(f => f.endsWith('.db'))
    .sort()
    .reverse();

if (!allFiles.length) {
    console.error('\n❌ Nenhum arquivo .db encontrado em data/backups/\n');
    process.exit(1);
}

// Prioriza pre-restore, depois regulares
const sorted = [
    ...allFiles.filter(f => f.startsWith('database-pre-restore-')),
    ...allFiles.filter(f => f.startsWith('database-') && !f.includes('pre-restore')),
];

console.log('\n📋 Verificando backups disponíveis...\n');
const valid   = [];
const invalid = [];

for (const name of sorted) {
    const filePath = path.join(BACKUP_DIR, name);
    const stat     = fs.statSync(filePath);
    const mb       = (stat.size / 1024 / 1024).toFixed(1);
    try {
        const db  = new Database(filePath, { readonly: true });
        const row = db.prepare('PRAGMA integrity_check').get();
        db.close();
        if (row && row.integrity_check === 'ok') {
            console.log(`  ✅  ${name}  (${mb} MB)`);
            valid.push(filePath);
        } else {
            console.log(`  ⚠️   ${name}  — corrompido (integrity_check: ${row && row.integrity_check})`);
            invalid.push(name);
        }
    } catch (e) {
        console.log(`  ❌  ${name}  — ilegível: ${e.message}`);
        invalid.push(name);
    }
}

if (!valid.length) {
    console.error('\n❌ Nenhum backup válido encontrado.');
    console.error('   Importe um backup externo para data/backups/ e tente novamente.\n');
    process.exit(1);
}

const best     = valid[0];
const bestName = path.basename(best);

console.log(`\n🔄 Aplicando o backup mais recente válido:`);
console.log(`   ${bestName}`);
console.log('');

// Salva o banco corrompido atual como .corrupt para inspeção posterior
if (fs.existsSync(DB_MAIN)) {
    const corruptCopy = DB_MAIN + '.corrupt-' + Date.now();
    try {
        fs.copyFileSync(DB_MAIN, corruptCopy);
        console.log(`   💾 Banco corrompido salvo em: ${path.basename(corruptCopy)}`);
    } catch { /* não crítico */ }
}

try {
    fs.copyFileSync(best, DB_MAIN);
} catch (err) {
    console.error(`\n❌ Falha ao copiar backup: ${err.message}\n`);
    process.exit(1);
}

hr();
console.log('  ✅ Banco restaurado com sucesso!');
hr();
console.log('');
console.log('  Próximos passos:');
console.log('    Windows → pm2 restart newclaw');
console.log('    Linux   → pm2 restart newclaw');
console.log('');
