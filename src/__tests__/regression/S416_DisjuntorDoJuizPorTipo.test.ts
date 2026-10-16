/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S416
 * Disjuntor do juiz por TIPO de validação: um modelo que se perde num tipo não fica indisponível para os outros.
 *
 * INCIDENTE REAL (Windows, 16/10/2026 02:33–02:43, goal_1792128547107_ogo6t, glm-5.3-flash:cloud): a revisão de risco e a
 * conferência saída × evidência pensaram 32 mil e 48 mil caracteres sem concluir, nos dois modos. O disjuntor — que era
 * só por modelo — abriu e fechou TODOS os juízes por 5 min, embora o mesmo modelo tivesse dado 81 vereditos em 4–10 s nos
 * outros tipos naquele dia. A conclusão do objetivo nem foi conferida ("não chamado por mais 300 s"), virou "não
 * confirmado" e o objetivo, já feito, foi replanejado mais 3 vezes.
 *
 * REGRESSÃO SE: falhas de um tipo abrirem o disjuntor de outro tipo; ou o disjuntor do PRÓPRIO tipo deixar de abrir
 * (proteção contra o modelo que nunca conclui, ADR-016); ou o estado por tipo não sobreviver ao reinício.
 *
 * Execução: npx ts-node src/__tests__/regression/S416_DisjuntorDoJuizPorTipo.test.ts
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PerfilDoJuiz, DISJUNTOR_MS, FALHAS_PARA_DISJUNTOR } from '../../validation/perfilDoJuiz';
import { ValidationEngine } from '../../validation/ValidationEngine';
import { criarRegistroPadrao } from '../../validation/motorPadrao';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

const VEREDITO = JSON.stringify({ estado: 'aprovado', itens: [{ item: 'x', confere: 'sim' }], tipo_de_falha: 'none' });
const TIPO_PESADO = 'risco_do_plano';
const TIPO_LEVE = 'conclusao_do_objetivo';

/** Provedor simulado: o modelo se perde (não conclui na fatia) SÓ no tipo pesado; nos outros responde direto. */
function fabrica(chamadas: string[]) {
    return {
        getBudgetAuxiliar: () => ({ timeoutMs: 300, origem: 'padrao', latenciaTipicaMs: null }),
        chatWithFallback: async (_m: unknown, _t: unknown, _p: unknown, timeoutMs: number, sinal: AbortSignal | undefined, _modelo: unknown, opts: any) => {
            const tipo = opts?.diag?.phase as string;
            chamadas.push(tipo);
            if (tipo !== TIPO_PESADO) return { status: 'success', content: VEREDITO, attempts: [] };
            return new Promise(res => {
                const t = setTimeout(() => res({ status: 'timeout', content: '', attempts: [] }), timeoutMs);
                sinal?.addEventListener('abort', () => { clearTimeout(t); res({ status: 'cancelled', content: '', attempts: [] }); });
            });
        },
    } as any;
}

async function main(): Promise<void> {
    const registro = criarRegistroPadrao();
    const entradasDe = (tipo: string): Record<string, string> =>
        Object.fromEntries((registro.obter(tipo)?.entradas ?? []).filter(e => e.obrigatoria).map(e => [e.nome, `conteúdo de ${e.nome}`]));

    console.log('\n=== S416-1 — perfil: falhas de um tipo não abrem o disjuntor de outro ===');
    {
        let agora = 1_000_000;
        const p = new PerfilDoJuiz(undefined, () => agora);
        for (let i = 0; i < FALHAS_PARA_DISJUNTOR; i++) {
            p.registrar('m', 'livre', false, 1, TIPO_PESADO);
            p.registrar('m', 'desligado', false, 1, TIPO_PESADO);
        }
        assert(p.estadoDoDisjuntor('m', TIPO_PESADO).aberto, 'o tipo que falhou em todos os modos fica com o disjuntor aberto');
        assert(!p.estadoDoDisjuntor('m', TIPO_LEVE).aberto, 'outro tipo, com o mesmo modelo, continua sendo chamado');
        assert(p.estadoDoDisjuntor('m').aberto, 'sem tipo (tela do juiz): vale o histórico do modelo inteiro, como antes');
        p.registrar('m', 'livre', true, 1, TIPO_LEVE);
        assert(p.estadoDoDisjuntor('m', TIPO_PESADO).aberto, 'sucesso em OUTRO tipo não fecha o disjuntor do tipo que falhou');
        agora += DISJUNTOR_MS + 1;
        assert(!p.estadoDoDisjuntor('m', TIPO_PESADO).aberto, 'passado o prazo, o tipo pesado volta a ser sondado');
        p.registrar('m', 'desligado', true, 1, TIPO_PESADO);
        agora += 1;
        p.registrar('m', 'livre', false, 1, TIPO_PESADO);
        assert(!p.estadoDoDisjuntor('m', TIPO_PESADO).aberto, 'um sucesso do próprio tipo zera as falhas seguidas dele');

        const arq = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nc-s416-')), 'perfil.json');
        const gravado = new PerfilDoJuiz(arq, () => agora);
        for (let i = 0; i < FALHAS_PARA_DISJUNTOR; i++) {
            gravado.registrar('m', 'livre', false, 1, TIPO_PESADO);
            gravado.registrar('m', 'desligado', false, 1, TIPO_PESADO);
        }
        const relido = new PerfilDoJuiz(arq, () => agora);
        assert(relido.estadoDoDisjuntor('m', TIPO_PESADO).aberto && !relido.estadoDoDisjuntor('m', TIPO_LEVE).aberto, 'o estado por tipo sobrevive ao reinício');
        try { fs.rmSync(path.dirname(arq), { recursive: true, force: true }); } catch { /* temporário */ }
    }

    console.log('\n=== S416-2 — motor: o caso real (revisão pesada se perde; conclusão continua conferida) ===');
    {
        const chamadas: string[] = [];
        const perfil = new PerfilDoJuiz();
        const motor = new ValidationEngine(fabrica(chamadas), registro, () => 'modelo-teste', perfil);
        for (let i = 0; i < FALHAS_PARA_DISJUNTOR; i++) {
            const r = await motor.validar(TIPO_PESADO, entradasDe(TIPO_PESADO));
            assert(r.semVeredito === true, `revisão pesada nº ${i + 1}: sem veredito (o modelo se perdeu)`, r.desfecho);
        }
        const antes = chamadas.length;
        const pesada = await motor.validar(TIPO_PESADO, entradasDe(TIPO_PESADO));
        assert(pesada.desfecho === 'juiz_indisponivel' && chamadas.length === antes, 'a 3ª revisão pesada nem chama o modelo (disjuntor do tipo protege o tempo do usuário)', pesada.desfecho);
        const conclusao = await motor.validar(TIPO_LEVE, entradasDe(TIPO_LEVE));
        assert(chamadas.length === antes + 1 && chamadas[antes] === TIPO_LEVE, 'a conferência da CONCLUSÃO chama o modelo normalmente', chamadas);
        assert(conclusao.semVeredito === false && conclusao.desfecho === 'veredito', 'e chega ao veredito (antes: "não chamado por mais 300 s" → objetivo replanejado)', conclusao.desfecho);
    }

    console.log('\n=== S416-3 — mensagem nomeia o tipo ===');
    {
        const src = fs.readFileSync(path.join(process.cwd(), 'src', 'validation', 'ValidationEngine.ts'), 'utf-8');
        assert(/estadoDoDisjuntor\(chaveDoModelo, d\.tipo\)/.test(src), 'o motor consulta o disjuntor DO TIPO');
        assert((src.match(/this\.perfil\.registrar\([^)]*d\.tipo\)/g) ?? []).length === 2, 'e registra cada chamada com o tipo (sucesso e prazo)');
    }

    console.log(`\n=== S416: ${passed} passaram, ${failed} falharam ===`);
    if (failed > 0) process.exit(1);
}

main().catch(err => { console.error(err); process.exit(1); });
