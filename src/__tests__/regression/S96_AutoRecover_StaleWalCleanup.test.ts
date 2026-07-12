/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S96
 * Auditoria adversarial 2026-07-12, achado A2 (Alto): autoRecoverDatabase copiava o backup por
 * cima de newclaw.db SEM remover o WAL/SHM stale do banco corrompido. Como o SQLite abre em modo
 * WAL, na reabertura ele encontrava o WAL de OUTRO banco e aplicava seus frames sobre o backup
 * restaurado → "disk image is malformed". O restore manual (index.ts) já limpava WAL/SHM; a
 * auto-recuperação não. Assimetria corrigida via helper único `replaceDatabaseFile`.
 *
 * Execução: npx ts-node src/__tests__/regression/S96_AutoRecover_StaleWalCleanup.test.ts
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { replaceDatabaseFile } from '../../core/dbRecovery';

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string, detail?: unknown): void {
    if (cond) { console.log(`  ✅ ${msg}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${msg}`, detail ?? ''); failed++; }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'newclaw-s96-'));
const dest = path.join(tmp, 'newclaw.db');
const src = path.join(tmp, 'backup.db');

console.log('\n=== S96 — replaceDatabaseFile remove WAL/SHM stale antes de copiar ===');

// Cenário: banco corrompido (dest) com WAL/SHM stale + backup válido (src) com conteúdo distinto.
fs.writeFileSync(dest, 'BANCO_CORROMPIDO');
fs.writeFileSync(dest + '-wal', 'WAL_STALE_DO_BANCO_CORROMPIDO');
fs.writeFileSync(dest + '-shm', 'SHM_STALE');
fs.writeFileSync(src, 'BACKUP_VALIDO');

replaceDatabaseFile(src, dest);

assert(fs.readFileSync(dest, 'utf8') === 'BACKUP_VALIDO', 'dest passou a ter o conteúdo do backup');
assert(!fs.existsSync(dest + '-wal'), 'WAL stale foi REMOVIDO (evita reaplicação de frames de outro banco)');
assert(!fs.existsSync(dest + '-shm'), 'SHM stale foi REMOVIDO');

console.log('\n=== S96-B — idempotência: funciona quando NÃO há WAL/SHM (sem lançar) ===');
const dest2 = path.join(tmp, 'novo.db');
let threw = false;
try {
    replaceDatabaseFile(src, dest2); // dest2 não existe, sem wal/shm
} catch { threw = true; }
assert(!threw, 'não lança quando WAL/SHM não existem');
assert(fs.readFileSync(dest2, 'utf8') === 'BACKUP_VALIDO', 'copiou mesmo sem arquivos auxiliares prévios');

// Limpeza
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ok */ }

console.log(`\n${'─'.repeat(60)}`);
console.log(`S96 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exit(1);
