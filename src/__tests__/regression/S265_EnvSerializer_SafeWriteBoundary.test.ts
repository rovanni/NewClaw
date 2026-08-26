/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S265 (campanha de Security: CORS + `.env` + `DASHBOARD_HOST`, item A)
 *
 * `persistConfigToEnv()` (dashboard/routes/config.ts) gravava 14+ campos livres — incluindo
 * `SYSTEM_PROMPT`, totalmente editável pela UI Dashboard sem nenhuma validação — via
 * `${key}=${value}` direto, sem escape algum. Um valor contendo uma quebra de linha seguida de
 * `OUTRA_CHAVE=valor` virava, literalmente, uma segunda variável de ambiente no próximo boot —
 * no MESMO arquivo que guarda `DASHBOARD_PASSWORD` e todas as chaves de API.
 *
 * Correção: `shared/envSerializer.ts` — fronteira ÚNICA de serialização, chamada uma vez para
 * TODOS os campos (não tratamento campo a campo). Formato alvo verificado empiricamente contra o
 * parser real do pacote `dotenv` (não só lendo a fonte) — só assim para confirmar que o que é
 * escrito é exatamente o que volta na leitura.
 *
 * Regra de aceite explícita desta campanha: um valor sem representação fiel no formato `.env`
 * NUNCA pode ser salvo como uma aproximação silenciosa — `encodeEnvValue()` devolve `null`, e
 * `applyEnvUpdates()` preserva o valor anterior daquela chave (se existia) em vez de escrever algo
 * diferente do que o usuário forneceu.
 *
 * REGRESSÃO SE: qualquer valor de injeção (quebra de linha seguida de outra chave) deixar de ser
 * neutralizado; qualquer um dos 19 casos com round-trip comprovado passar a divergir do original
 * após escrever+ler; ou qualquer um dos 4 casos sem round-trip seguro deixar de ser rejeitado (ou
 * passar a ser silenciosamente alterado em vez de rejeitado).
 *
 * Execução: npx ts-node src/__tests__/regression/S265_EnvSerializer_SafeWriteBoundary.test.ts
 */

import dotenv from 'dotenv';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { encodeEnvValue, applyEnvUpdates } from '../../shared/envSerializer';
import { persistConfigToEnv, logEnvPersistResult } from '../../dashboard/routes/config';
import type { DashboardContext } from '../../dashboard/routes/types';
import type { NewClawConfig } from '../../core/AgentController';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

async function main(): Promise<void> {

console.log('\n=== S265-1 [segurança] — payload de injeção real (Fase 2 da investigação) é neutralizado ===');
{
    const { content } = applyEnvUpdates('', {
        SYSTEM_PROMPT: 'valor legítimo\nDASHBOARD_PASSWORD=hackeado123',
    });
    const parsed = dotenv.parse(content);
    assert(!('DASHBOARD_PASSWORD' in parsed), 'DASHBOARD_PASSWORD não aparece como chave própria — a quebra de linha não virou uma 2ª variável', parsed);
    assert(parsed.SYSTEM_PROMPT === 'valor legítimo\nDASHBOARD_PASSWORD=hackeado123', 'SYSTEM_PROMPT preserva o valor original completo, como UM valor só', parsed.SYSTEM_PROMPT);
}

console.log('\n=== S265-2 [segurança] — mesmo payload em TELEGRAM_ALLOWED_USER_IDS (achado separado na Fase 2) ===');
{
    const { content } = applyEnvUpdates('', {
        TELEGRAM_ALLOWED_USER_IDS: '12345,67890\nOWNER_USER_ID=attacker',
    });
    const parsed = dotenv.parse(content);
    assert(!('OWNER_USER_ID' in parsed), 'OWNER_USER_ID não aparece como chave própria', parsed);
    assert(parsed.TELEGRAM_ALLOWED_USER_IDS === '12345,67890\nOWNER_USER_ID=attacker', 'valor original preservado como um único campo', parsed.TELEGRAM_ALLOWED_USER_IDS);
}

console.log('\n=== S265-3 [round-trip] — 19 casos que o formato dotenv consegue representar com fidelidade total ===');
{
    const roundTripCases: Record<string, string> = {
        TEXTO_NORMAL: 'ollama ativo',
        ESPACOS: '  espacos  no  meio  ',
        ASPAS_SIMPLES: "it's a test",
        ASPAS_DUPLAS: 'he said "hi"',
        BARRA_INVERTIDA: 'C:\\Users\\lucia\\NewClaw',
        BACKSLASH_N_LITERAL: 'literal backslash-n: \\n not a real newline',
        NEWLINE_REAL: 'linha1\nlinha2',
        CR_REAL: 'linha1\rlinha2',
        CRLF_REAL: 'linha1\r\nlinha2',
        API_KEY_TIPICA: 'sk-ant-api03-AbCdEf1234567890_-xyz',
        VAZIO: '',
        SO_ESPACO: ' ',
        BACKSLASH_ANTES_DE_NEWLINE_REAL: 'linha1\\\nlinha2',
        DOIS_BACKSLASH_ANTES_DE_NEWLINE: 'linha1\\\\\nlinha2',
        TRES_BACKSLASH_ANTES_DE_NEWLINE: 'linha1\\\\\\\nlinha2',
        MULTIPLAS_LINHAS: 'linha1\nlinha2\nlinha3\nlinha4',
        UNICODE: 'café ☕ 日本語 emoji 🎉',
        INJECAO_ENV: 'valor legitimo\nDASHBOARD_PASSWORD=hackeado123',
        INJECAO_TELEGRAM: '12345,67890\nOWNER_USER_ID=attacker',
    };
    const { content, rejected } = applyEnvUpdates('', roundTripCases);
    assert(rejected.length === 0, 'nenhum destes 18 casos é rejeitado (todos têm representação fiel)', rejected);
    const parsed = dotenv.parse(content);
    for (const [key, original] of Object.entries(roundTripCases)) {
        assert(parsed[key] === original, `${key}: round-trip perfeito (escreveu e leu de volta idêntico)`, { original, parsed: parsed[key] });
    }
}

console.log('\n=== S265-4 [rejeição segura, nunca silenciosa] — 4 combinações sem representação fiel no dotenv ===');
{
    const impossibleCases: Record<string, string> = {
        COMBO_ESPECIAIS: `mix: 'single' "double" \\backslash\\ end`,
        BACKSLASH_N_SEGUIDO_DE_NEWLINE_REAL: 'a\\n' + '\n' + 'b',
        IMPOSSIVEL_NEWLINE_E_ASPAS: 'ele disse "oi"\ne foi embora',
        IMPOSSIVEL_ASPAS_SIMPLES_E_DUPLAS: `mixed "double" and 'single'`,
    };
    for (const [key, value] of Object.entries(impossibleCases)) {
        assert(encodeEnvValue(value) === null, `${key}: encodeEnvValue() devolve null (sem round-trip seguro) em vez de uma aproximação`, value);
    }

    const { content, rejected } = applyEnvUpdates('', impossibleCases);
    assert(rejected.length === 4 && Object.keys(impossibleCases).every(k => rejected.includes(k)), 'applyEnvUpdates() reporta as 4 chaves como rejeitadas — nunca fica silencioso', rejected);
    assert(!content.includes('COMBO_ESPECIAIS') && !content.includes('IMPOSSIVEL'), 'nenhuma das 4 chaves rejeitadas chega a ser escrita no arquivo', content);
}

console.log('\n=== S265-5 [preservação] — valor anterior de uma chave rejeitada permanece intocado, não é apagado ===');
{
    const existing = `SYSTEM_PROMPT='valor antigo, válido'\nOLLAMA_MODEL='glm-5.2:cloud'\n`;
    const { content, rejected } = applyEnvUpdates(existing, {
        SYSTEM_PROMPT: 'ele disse "oi"\ne foi embora', // impossível — deve manter o valor antigo
        OLLAMA_MODEL: 'novo-modelo',                    // válido — deve atualizar normalmente
    });
    assert(rejected.includes('SYSTEM_PROMPT') && !rejected.includes('OLLAMA_MODEL'), 'só SYSTEM_PROMPT é rejeitado, OLLAMA_MODEL passa normalmente', rejected);
    const parsed = dotenv.parse(content);
    assert(parsed.SYSTEM_PROMPT === 'valor antigo, válido', 'SYSTEM_PROMPT mantém o valor ANTERIOR — não foi sobrescrito por uma aproximação', parsed.SYSTEM_PROMPT);
    assert(parsed.OLLAMA_MODEL === 'novo-modelo', 'OLLAMA_MODEL foi atualizado normalmente (chave sem problema não é afetada pela rejeição de outra)', parsed.OLLAMA_MODEL);
}

console.log('\n=== S265-6 [preservação] — linha/comentário não-gerenciado no .env sobrevive intocado ===');
{
    const existing = `# comentário do operador\nCUSTOM_UNMANAGED_VAR=valor-que-o-dashboard-nunca-toca\nOLLAMA_URL=http://localhost:11434\n`;
    const { content } = applyEnvUpdates(existing, { OLLAMA_URL: 'http://novo:11434' });
    assert(content.includes('# comentário do operador'), 'comentário sobrevive', content);
    assert(content.includes('CUSTOM_UNMANAGED_VAR=valor-que-o-dashboard-nunca-toca'), 'variável não-gerenciada sobrevive intocada', content);
    const parsed = dotenv.parse(content);
    assert(parsed.OLLAMA_URL === 'http://novo:11434', 'a chave realmente gerenciada foi atualizada', parsed.OLLAMA_URL);
}

console.log('\n=== S265-7 [achado da revisão de código] — falha TOTAL (I/O) devolve null, distinto de [] (sucesso) ===');
{
    // Achado: o catch de persistConfigToEnv devolvia [] em erro total — indistinguível de "gravou
    // tudo com sucesso". null é o sinal explícito de "nada foi persistido".
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'newclaw-s265-'));
    const originalCwd = process.cwd();
    process.chdir(tmpDir);
    try {
        const ctx = {
            config: {
                defaultProvider: 'ollama', language: 'pt-BR', maxIterations: 5, memoryWindowSize: 20,
                telegramAllowedUserIds: undefined as unknown as string[], // dispara .join() em undefined → exceção real
            } as unknown as NewClawConfig,
        } as DashboardContext;
        const result = persistConfigToEnv(ctx);
        assert(result === null, 'erro real durante a construção dos valores devolve null (falha total), não []', result);
        assert(!fs.existsSync(path.join(tmpDir, '.env')), 'nenhum .env chega a ser criado quando a falha acontece antes da escrita', null);

        // logEnvPersistResult() não deve lançar nem se comportar mal com null.
        let threw = false;
        try { logEnvPersistResult(result, 'S265-teste'); } catch { threw = true; }
        assert(!threw, 'logEnvPersistResult(null, ...) não lança — só loga', null);
    } finally {
        process.chdir(originalCwd);
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
}

console.log('\n=== S265-8 [achado da revisão de código] — chamada bem-sucedida, sem rejeição, devolve [] (não null) ===');
{
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'newclaw-s265b-'));
    const originalCwd = process.cwd();
    process.chdir(tmpDir);
    try {
        const ctx = {
            config: {
                defaultProvider: 'ollama', language: 'pt-BR', maxIterations: 5, memoryWindowSize: 20,
                telegramAllowedUserIds: [],
            } as unknown as NewClawConfig,
        } as DashboardContext;
        const result = persistConfigToEnv(ctx);
        assert(Array.isArray(result) && result.length === 0, 'chamada normal, sem campo problemático, devolve [] — distinto de null', result);
        assert(fs.existsSync(path.join(tmpDir, '.env')), '.env foi criado normalmente', null);
    } finally {
        process.chdir(originalCwd);
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S265 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;

}

main().catch((err) => {
    console.error('S265 erro inesperado:', err);
    process.exitCode = 1;
});
