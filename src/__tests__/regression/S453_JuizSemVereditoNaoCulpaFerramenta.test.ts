/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S453 (28/10/2026)
 *
 * O juiz que NÃO CONCLUIU (estado UNVALIDATED: prazo, provedor, saída inválida) não disse nada da ferramenta. Gravar isso
 * como falha da ferramenta no ReflectionMemory a faz "falhar" em `findToolFailures` — e a dica volta ao planejamento
 * ("Ferramenta: exec_command | Falha: 100%") contra uma ferramenta que funcionou.
 *
 * ORIGEM: instalação Windows, 25/10/2026. Três etapas com o juiz cortado pelo limite de saída (ver S452) gravaram
 * `[REFLECT] Falha registrada: tool=exec_command|read|memory_write pattern=grounding_blocked reason="juiz não concluiu…"`.
 *
 * REGRESSÃO SE: o registro de falha `grounding_blocked` do AgentLoop voltar a ser gravado para UNVALIDATED. REJECTED e
 * NOT_EVALUABLE (o juiz concluiu e achou problema) continuam registrados.
 *
 * Execução: npx ts-node src/__tests__/regression/S453_JuizSemVereditoNaoCulpaFerramenta.test.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { ReflectionMemory } from '../../memory/ReflectionMemory';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

function main(): void {
    console.log('\n=== S453 — juiz sem veredito não culpa a ferramenta ===\n');

    console.log('Controle: falha gravada na ferramenta vira dica contra ela');
    {
        const db = new Database(':memory:');
        const rm = new ReflectionMemory({ getDatabase: () => db } as any);
        for (let i = 0; i < 2; i++) {
            rm.record({ traceId: `t${i}`, conversationId: 'c', userInput: 'rode o script', intent: 'exec', toolUsed: 'exec_command', toolOutput: 'ok',
                finalResponse: 'feito', approved: false, reason: 'juiz não concluiu: modelo não concluiu (error)', confidence: 0, pattern: 'grounding_blocked', outcome: 'failure' } as any);
        }
        const dica = rm.findToolFailures('exec_command');
        assert(/exec_command.*Falha: 100%/.test(dica), 'duas falhas do juiz bastam para a dica "exec_command falha 100%"', dica);
        db.close();
    }

    console.log('\nAgentLoop: o registro grounding_blocked não é gravado quando o juiz não concluiu');
    {
        const src = fs.readFileSync(path.join(__dirname, '..', '..', 'loop', 'AgentLoop.ts'), 'utf-8');
        const i = src.indexOf("pattern: 'grounding_blocked'");
        const trecho = src.slice(Math.max(0, i - 900), i);
        assert(i > 0, 'o registro grounding_blocked existe');
        assert(/if \(g\.state !== 'UNVALIDATED'\) this\.reflectionMemory\.record\(\{[\s\S]*$/.test(trecho), 'gravado só para REJECTED/NOT_EVALUABLE', trecho.slice(-300));
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S453 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    process.exit(failed > 0 ? 1 : 0);
}
main();
