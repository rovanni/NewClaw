/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S276 (docs/issues/025)
 *
 * `persistConfigToEnv()` (dashboard/routes/config.ts) gravava `SYSTEM_PROMPT` no `.env`, mas o
 * objeto `config` construído no boot (`src/index.ts`) nunca lia `process.env.SYSTEM_PROMPT`: um
 * system prompt customizado pelo Dashboard sumia, calado, no próximo restart. Das 37 chaves
 * gravadas, era a única sem leitura de volta.
 *
 * Guard de CLASSE, não do caso: toda chave gravada por `persistConfigToEnv()` precisa ter uma
 * leitura `process.env.<CHAVE>` em `src/index.ts`. Uma chave nova gravada e esquecida no boot
 * falha aqui, em vez de só aparecer como "configuração que não sobrevive a restart".
 *
 * Execução: npx ts-node src/__tests__/regression/S276_EnvPersist_ParityWithBootConfig.test.ts
 */

import fs from 'fs';
import path from 'path';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  OK ${message}`); passed++; }
    else { console.error(`  FALHOU: ${message}`, detail ?? ''); failed++; }
}

const root = path.resolve(__dirname, '../../');
const configRoute = fs.readFileSync(path.join(root, 'dashboard/routes/config.ts'), 'utf8');
const bootConfig = fs.readFileSync(path.join(root, 'index.ts'), 'utf8');

// Só o corpo de persistConfigToEnv(), para não capturar chaves de outras rotas do arquivo.
const start = configRoute.indexOf('const updates: Record<string, string>');
const end = configRoute.indexOf('applyEnvUpdates(envContent, updates)');

console.log('\n=== S276.1 — o trecho de `updates` foi localizado ===');
assert(start !== -1 && end > start, 'delimitadores de persistConfigToEnv() encontrados', { start, end });

const body = configRoute.slice(start, end);
const keys = [...new Set([...body.matchAll(/updates\['([A-Z_]+)'\]|^\s*'([A-Z_]+)':/gm)].map(m => m[1] || m[2]))];

console.log('\n=== S276.2 — o guard enxerga o conjunto real de chaves ===');
assert(keys.length >= 30, `pelo menos 30 chaves extraídas (achadas: ${keys.length})`, keys);
assert(keys.includes('SYSTEM_PROMPT'), 'SYSTEM_PROMPT está entre as chaves gravadas', keys);

console.log('\n=== S276.3 — toda chave gravada é lida de volta no boot ===');
const neverRead = keys.filter(k => !bootConfig.includes(`process.env.${k}`));
assert(neverRead.length === 0, 'nenhuma chave gravada fica sem leitura em src/index.ts', neverRead);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
