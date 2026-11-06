/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S480 (achado da medição dos juízes, 05/11/2026; correção aprovada pela operadora em 06/11/2026)
 *
 * Nos tipos que agregam o veredito pelos itens (`agregacao: 'itens'`: `saida_contra_evidencia`, `suficiencia_do_pedido`,
 * `resultado_do_passo`), `lerSaidaDoModelo` tratava a FALTA do campo `itens` como lista vazia — e lista vazia agrega como
 * aprovado (no juiz de grounding, NOT_APPLICABLE: resposta liberada). "Nenhuma afirmação a conferir" e "o modelo não
 * devolveu a lista" ficavam iguais: falha aberta. Medição de 05/11: o Bonsai devolveu um veredito sem itens cujo motivo
 * citava três afirmações sem evidência; na produção, 0 de 369 vereditos gravados vieram assim (a porta estava aberta, não
 * usada).
 *
 * Agora a falta da lista é saída inválida (o motor tenta o outro modo e, sem veredito, aplica a política do tipo); `itens`
 * que não é lista também. `"itens": []` continua sendo o jeito de dizer "nada a listar". Tipos com `agregacao: 'modelo'`
 * seguem aceitando o veredito sem itens (o estado vem do modelo).
 *
 * Real: `lerSaidaDoModelo`, ValidationEngine, o descritor e o adaptador de `saida_contra_evidencia`. Imitado: só o provedor.
 *
 * REGRESSÃO SE: um veredito sem `itens` (ou com `itens` que não é lista) voltar a ser lido como lista vazia num tipo que
 * agrega pelos itens; ou `"itens": []` deixar de ser aceito; ou um tipo `agregacao: 'modelo'` passar a exigir a lista.
 *
 * Execução: npx ts-node src/__tests__/regression/S480_VereditoSemItensNaoViraAprovacao.test.ts
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ValidationEngine } from '../../validation/ValidationEngine';
import { RegistroDeValidacoes, lerSaidaDoModelo } from '../../validation/contratoDeValidacao';
import { descritorSaidaContraEvidencia, estadoDeGrounding, type DecisaoDeGrounding } from '../../validation/tipos/saidaContraEvidencia';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}
const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
    const orig = process.stdout.write.bind(process.stdout);
    (process.stdout.write as unknown) = (): boolean => true;
    try { return await fn(); } finally { process.stdout.write = orig; }
};

function fabrica(saida: string) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getBudgetAuxiliar } = require('../../shared/auxTimeout');
    return {
        chatWithFallback: async () => ({ status: 'success', content: saida, attempts: [] }),
        getBudgetAuxiliar: (p: 'classificacao' | 'validacao') => getBudgetAuxiliar(p, null, null),
    } as any;
}

async function main(): Promise<void> {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 's480-'));
    const logOrig = process.env.LOG_FILE;
    process.env.LOG_FILE = path.join(base, 'newclaw-audit.log');
    try {
        console.log('\n=== S480-1 — leitor: tipo que agrega pelos itens exige a lista ===');
        {
            const semItens = JSON.stringify({ estado: 'aprovado', confianca: 0.9, motivo: 'A maioria dos dados é sustentada; três afirmações não têm evidência.' });
            const diag: { motivo?: string } = {};
            assert(lerSaidaDoModelo(semItens, [], diag, { exigeItens: true }) === null, 'sem "itens" e exigeItens → saída inválida (null)');
            assert(/itens/.test(diag.motivo ?? ''), 'o diagnóstico diz que faltou o campo "itens"', diag.motivo);
            const vazio = lerSaidaDoModelo(JSON.stringify({ estado: 'aprovado', itens: [], motivo: 'nada a conferir' }), [], {}, { exigeItens: true });
            assert(!!vazio && vazio.itens.length === 0, '"itens": [] continua aceito (o jeito de dizer "nada a listar")');
        }

        console.log('\n=== S480-2 — leitor: "itens" que não é lista é inválido em qualquer tipo ===');
        {
            for (const itens of [{ item: 'x', confere: 'sim' }, 'nenhum', 3]) {
                const diag: { motivo?: string } = {};
                assert(lerSaidaDoModelo(JSON.stringify({ estado: 'aprovado', itens }), [], diag) === null && /lista/.test(diag.motivo ?? ''), `itens=${JSON.stringify(itens)} → null, com motivo`, diag.motivo);
            }
        }

        console.log('\n=== S480-3 — leitor: tipo que agrega pelo modelo segue aceitando veredito sem itens ===');
        {
            const lido = lerSaidaDoModelo(JSON.stringify({ estado: 'reprovado', motivo: 'o plano apaga dados' }));
            assert(!!lido && lido.estadoDoModelo === 'reprovado' && lido.itens.length === 0, 'sem exigeItens: estado do modelo lido, itens = []', lido);
        }

        console.log('\n=== S480-4 — motor: saida_contra_evidencia sem itens não vira NOT_APPLICABLE ===');
        {
            const reg = new RegistroDeValidacoes();
            reg.registrar(descritorSaidaContraEvidencia);
            const saida = JSON.stringify({ estado: 'aprovado', confianca: 1, motivo: 'A maioria dos dados é sustentada. Porém, três afirmações importantes não têm evidência direta.' });
            const r = await quiet(() => new ValidationEngine(fabrica(saida), reg, () => 'modelo-s480')
                .validar<DecisaoDeGrounding>('saida_contra_evidencia', { pedido: 'p', resposta: 'O deck tem 188 slides, fundo branco.', evidencias: '[E1] ferramenta=read\n188 slides' }));
            const estado = estadoDeGrounding(r.veredito);
            assert(estado !== 'NOT_APPLICABLE' && estado !== 'VALIDATED', 'o estado NÃO é NOT_APPLICABLE nem VALIDATED (antes: NOT_APPLICABLE → resposta liberada)', estado);
            assert(estado === 'UNVALIDATED', 'é UNVALIDATED: o juiz não chegou a veredito (a política do tipo decide, com aviso)', { estado, porque: r.veredito.naoAvaliavelPorque });
            assert(/itens/.test(r.veredito.naoAvaliavelPorque ?? ''), 'o motivo registrado aponta o campo que faltou', r.veredito.naoAvaliavelPorque);
        }

        console.log('\n=== S480-5 — motor: "itens": [] continua sendo NOT_APPLICABLE ===');
        {
            const reg = new RegistroDeValidacoes();
            reg.registrar(descritorSaidaContraEvidencia);
            const r = await quiet(() => new ValidationEngine(fabrica(JSON.stringify({ estado: 'aprovado', itens: [], confianca: 1, motivo: 'só texto redigido' })), reg, () => 'modelo-s480')
                .validar<DecisaoDeGrounding>('saida_contra_evidencia', { pedido: 'p', resposta: 'Bom dia!', evidencias: '[E1] ferramenta=read\nok' }));
            assert(estadoDeGrounding(r.veredito) === 'NOT_APPLICABLE', 'lista vazia declarada → NOT_APPLICABLE (comportamento mantido)', estadoDeGrounding(r.veredito));
        }
    } finally {
        if (logOrig === undefined) delete process.env.LOG_FILE; else process.env.LOG_FILE = logOrig;
        // A pasta temporária NÃO é apagada (mesmo padrão do S363/S479): o stream de auditoria abre o arquivo de forma assíncrona.
    }
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S480 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    if (failed > 0) process.exitCode = 1;
}
main().catch((err) => { console.error('S480 erro inesperado:', err); process.exitCode = 1; });
