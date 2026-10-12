/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S389 (Campanha 2 — Sprint J1)
 *
 * Incidente real (12/10/2026 07:46):
 * O agente coletou com sucesso os 5 e-mails reais do usuário via CLI himalaya logo no 1º minuto.
 * A resposta final foi gerada com base nesses fatos. Porém, a verificação de groundedness
 * sofreu timeout no modo de raciocínio livre do juiz, gerando veredito inicial `UNVALIDATED`.
 *
 * No código anterior, `UNVALIDATED` caía diretamente no descarte da resposta e na emissão de
 * mensagem de bloqueio, fazendo o GoalExecutionLoop descartar todo o trabalho das ferramentas
 * e replanejar criando scripts repetitivos em disco até estourar 33 minutos de timeout.
 *
 * Correção J1:
 * Conforme ADR-010 §9, `UNVALIDATED` representa uma falha puramente transitória do verificador
 * (estouro de tempo limite ou recurso indisponível), e não falsidade das afirmações da resposta.
 * O `AgentLoop` agora tenta uma revalidação imediata da MESMA resposta (`phase: 'revalidation'`).
 * Se o verificador concluir (`VALIDATED` ou `NOT_APPLICABLE`), a resposta original é aproveitada
 * e devolvida diretamente ao usuário.
 *
 * Execução: npx ts-node src/__tests__/regression/S389_AgentLoop_UnvalidatedRevalidation.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

const agentLoopPath = path.join(process.cwd(), 'src', 'loop', 'AgentLoop.ts');
const agentLoopSource = fs.readFileSync(agentLoopPath, 'utf-8');

async function main(): Promise<void> {
    console.log('\n=== S389-1 — Revalidação da mesma resposta após UNVALIDATED inicial ===');
    {
        const unvalidatedBlockIdx = agentLoopSource.indexOf("if (g.state === 'UNVALIDATED')");
        assert(unvalidatedBlockIdx > -1, "AgentLoop contém guard específico para 'UNVALIDATED'");

        const partialBlockIdx = agentLoopSource.indexOf('const supportedClaims = g.claims.filter');
        assert(unvalidatedBlockIdx > partialBlockIdx, 'o guard de UNVALIDATED fica após o tratamento de resposta parcial');

        const blockContent = agentLoopSource.slice(unvalidatedBlockIdx, unvalidatedBlockIdx + 2000);

        assert(/this\.observer\.validateGrounding\(response, evidences, signal/.test(blockContent),
            'AgentLoop chama validateGrounding passando a resposta original (response) e as evidências');

        assert(/phase:\s*'revalidation'/.test(blockContent),
            "chamada de revalidação especifica phase: 'revalidation'");

        assert(/if\s*\(reval\.state === 'VALIDATED' \|\| reval\.state === 'NOT_APPLICABLE'\)/.test(blockContent),
            'se a revalidação retornar VALIDATED ou NOT_APPLICABLE, aceita');

        assert(/return response;/.test(blockContent),
            'resposta original é liberada e retornada quando a revalidação tem sucesso');

        assert(/resposta_liberada_apos_unvalidated/.test(blockContent),
            'efeito no gravador de voo é registrado adequadamente');
    }

    console.log('\n=== S389-2 — Tipagem de ObserverValidator aceita fase revalidation ===');
    {
        const observerPath = path.join(process.cwd(), 'src', 'loop', 'ObserverValidator.ts');
        const observerSource = fs.readFileSync(observerPath, 'utf-8');

        assert(/phase\?:\s*'(initial|revalidation|partial-revalidation|shadow-extended|shadow-model)'[^;]*;/.test(observerSource) &&
               observerSource.includes("'revalidation'"),
            "GroundingContext em ObserverValidator.ts inclui 'revalidation' na união de tipos");
    }

    console.log(`\nResultado: ${passed} passaram, ${failed} falharam.`);
    if (failed > 0) process.exit(1);
}

main().catch(err => {
    console.error('Erro inesperado no teste S389:', err);
    process.exit(1);
});
