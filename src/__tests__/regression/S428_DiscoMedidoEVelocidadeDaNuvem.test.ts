/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S428
 * Dois achados do teste real "instalar o VoiceStudio" (Windows, 16/10/2026):
 * 1) DISCO: o planejador leu "disco com 0MB livre — risco crítico" com 238 GB livres. A medição usava `wmic`, que não existe
 *    no Windows 11 recente: falhava e virava 0 — repassado como FATO ao agente e aos juízes. Agora: `fs.statfs` do próprio
 *    Node, no disco do workspace; falhou = "não medido" (nunca um 0 inventado).
 * 2) VELOCIDADE NA NUVEM: o Ollama Cloud não devolve prompt_eval_duration/eval_duration (só total_duration) — a medição em
 *    tokens (ADR-024) ficava sem velocidade ("geracao=?"). Agora: relógio do cliente (até o 1º token = leitura; o resto =
 *    geração), declarado como tempos=cliente.
 *
 * Execução: npx ts-node src/__tests__/regression/S428_DiscoMedidoEVelocidadeDaNuvem.test.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { observacaoDaChamada, MedidorDeTrabalho } from '../../core/medidorDeTrabalho';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

async function main(): Promise<void> {
    console.log('\n=== S428-1 — disco medido pelo Node, no disco do workspace ===');
    {
        const { CapabilityRegistry } = require('../../core/CapabilityRegistry') as typeof import('../../core/CapabilityRegistry');
        const reg: any = new (CapabilityRegistry as any)();
        const hw = (reg.probe ?? reg).probeHardware();
        assert(typeof hw.diskFreeMB === 'number' && hw.diskFreeMB > 0, `disco livre medido de verdade (${hw.diskFreeMB} MB) — nesta máquina, nunca 0`, hw.diskFreeMB);
        const src = fs.readFileSync(path.join(process.cwd(), 'src', 'core', 'CapabilityRegistry.ts'), 'utf-8');
        assert(/fs\.statfsSync\(alvo\)/.test(src) && !/wmic logicaldisk/.test(src), 'mede com fs.statfs (sem wmic, ausente no Windows 11 recente)');
        assert(/disk:\$\{hw\.diskFreeMB !== undefined \? `\$\{hw\.diskFreeMB\}MB livre` : 'não medido'\}/.test(src), 'sem medição, o ambiente diz "não medido" — nunca "0MB livre"');
        const pc = fs.readFileSync(path.join(process.cwd(), 'src', 'core', 'PromptComposer.ts'), 'utf-8');
        assert(/disk_free:\$\{caps\.diskFreeMB !== undefined/.test(pc), 'o que o agente recebe também diz "não medido"');
    }

    console.log('\n=== S428-2 — velocidade na nuvem pelo relógio do cliente ===');
    {
        // Como o Ollama Cloud: tokens do servidor, sem durações; o NewClaw sabe quando chegou o 1º token.
        const o = observacaoDaChamada({ modelo: 'glm-5.3-flash:cloud', modo: 'livre', tipo: 'ValidationEngine:risco_do_plano', status: 'success',
            tentativa: { promptTokens: 1484, evalTokens: 2693, firstChunkMs: 1956, thinkingChars: 9000, contentChars: 2500, doneReason: 'stop' },
            charsDeEntrada: 5300, msTotal: 20682, canceladaPeloUsuario: false });
        assert(o.tempos === 'cliente' && o.msLeitura === 1956 && o.msGeracao === 20682 - 1956, 'sem tempos do servidor: leitura = até o 1º token; geração = o resto (tempos=cliente)', o);
        const m = new MedidorDeTrabalho();
        m.registrar(o);
        const v = m.velocidade('glm-5.3-flash:cloud', 'livre');
        assert(v.amostras === 1 && Math.abs((v.geracao ?? 0) - 2693 / ((20682 - 1956) / 1000)) < 0.01, `a velocidade passa a existir (${v.geracao?.toFixed(1)} tok/s)`, v);

        const local = observacaoDaChamada({ modelo: 'bonsai', modo: 'livre', tipo: 't', status: 'success',
            tentativa: { promptTokens: 1653, evalTokens: 6036, promptEvalMs: 4130, evalMs: 158000, firstChunkMs: 4200 },
            charsDeEntrada: 6000, msTotal: 162000, canceladaPeloUsuario: false });
        assert(local.tempos === 'servidor' && local.msGeracao === 158000, 'quando o servidor mede (local), valem os tempos dele');
    }

    console.log(`\n=== S428: ${passed} passaram, ${failed} falharam ===`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
