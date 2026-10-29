/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S463 (29/10/2026, ADR-019)
 *
 * O cofre troca <SEGREDO:nome> pelo valor nos argumentos de TODA ferramenta, no instante da execução (`comSegredos`). Para
 * uma ferramenta que executa (ssh, exec_command) é o que se quer; para uma que GUARDA o que recebe, é o vazamento: "anote a
 * senha do servidor" gravava o valor em claro em `memory_nodes`, no índice FTS e em `memory_index`.
 *
 * ORIGEM: validação real da campanha de 29/10/2026 (instância isolada, painel): depois das correções do cofre (S458–S460),
 * a senha e a senha de app sumiram de mensagens, transcrições e logs — mas estavam nos nós de memória.
 *
 * REGRESSÃO SE: memory_write/memory_admin voltarem a receber o valor; uma ferramenta comum deixar de recebê-lo; ou o
 * resultado deixar de voltar mascarado.
 *
 * Execução: npx ts-node src/__tests__/regression/S463_MemoriaGuardaOMarcadorDoSegredo.test.ts
 */
import { comSegredos } from '../../core/ToolRegistry';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

async function main(): Promise<void> {
    console.log('\n=== S463 — a memória guarda o marcador, não o valor ===\n');
    process.env.SEGREDO_S463 = 'Valor-Sintetico-463';   // sintético
    // A lista de segredos conhecidos fica em cache por 5 s (o logger já a calculou ao importar os módulos).
    await new Promise((r) => setTimeout(r, 5200));

    const visto: Record<string, unknown>[] = [];
    const ferramenta = (guarda: boolean): any => ({
        name: guarda ? 'guarda' : 'executa', description: '', parameters: {},
        ...(guarda ? { guardaOMarcador: true } : {}),
        execute: async (args: Record<string, unknown>) => { visto.push(args); return { success: true, output: `recebi ${args.texto}` }; },
    });

    const r1 = await comSegredos(ferramenta(false)).execute({ texto: 'senha <SEGREDO:s463>' });
    assert(visto[0].texto === 'senha Valor-Sintetico-463', 'ferramenta que executa recebe o valor', visto[0]);
    assert(r1.output === 'recebi senha <SEGREDO:s463>', 'e o resultado volta mascarado', r1.output);

    const r2 = await comSegredos(ferramenta(true)).execute({ texto: 'senha <SEGREDO:s463>' });
    assert(visto[1].texto === 'senha <SEGREDO:s463>', 'ferramenta que guarda recebe o marcador', visto[1]);
    assert(r2.output === 'recebi senha <SEGREDO:s463>', 'o resultado continua sem o valor', r2.output);

    const fs = require('fs'), path = require('path');
    for (const t of ['memory_write', 'memory_admin']) {
        const src = fs.readFileSync(path.join(__dirname, '..', '..', 'tools', `${t}.ts`), 'utf-8');
        assert(/guardaOMarcador = true as const;/.test(src), `${t} declara guardaOMarcador`);
    }
    const reg = fs.readFileSync(path.join(__dirname, '..', '..', 'core', 'ToolRegistry.ts'), 'utf-8');
    assert(/alvo\.guardaOMarcador \? args : resolverMarcadores\(args\)/.test(reg), 'comSegredos respeita guardaOMarcador');

    delete process.env.SEGREDO_S463;
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S463 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    process.exit(failed > 0 ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
