/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S479 (A1-r, decisão da operadora em 05/11/2026)
 *
 * O juiz `saida_contra_evidencia` concluiu, não achou contradição, mas não confirmou parte das afirmações (`NOT_EVALUABLE`):
 * antes a resposta era bloqueada quando a parcial não passava — em produção (22/10–04/11), 19 dos 21 bloqueios por
 * NOT_EVALUABLE não tinham contradição nenhuma. Agora, depois da tentativa de resposta parcial, ela sai com o aviso dos pontos
 * não confirmados.
 *
 * A regra olha o veredito do MODELO antes do rebaixamento pela conferência literal da citação: 2 contradições reais viraram
 * "sem evidência" em produção porque a citação não conferiu (fonte com `�` em 30/10; trecho "342", curto demais, em 04/11).
 * Qualquer item que o juiz marcou `nao` impede a liberação.
 *
 * Real: ValidationEngine (com a pré-verificação de citação), o descritor e o adaptador de `saida_contra_evidencia`,
 * `AgentLoop.liberavelComAviso` / `comAvisoNaoConfirmado`. Imitado: só o provedor (devolve o JSON do juiz).
 *
 * REGRESSÃO SE: um REJECTED (ou um `nao` com citação que não confere) passar a ser liberado; o veredito original do modelo
 * sumir do item; o aviso não listar os pontos não confirmados; ou o ramo da A1-r vier antes da tentativa de resposta parcial.
 *
 * Execução: npx ts-node src/__tests__/regression/S479_A1r_NaoAvaliavelSemContradicaoSaiComAviso.test.ts
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ValidationEngine } from '../../validation/ValidationEngine';
import { RegistroDeValidacoes } from '../../validation/contratoDeValidacao';
import { descritorSaidaContraEvidencia, type DecisaoDeGrounding } from '../../validation/tipos/saidaContraEvidencia';
import { AgentLoop } from '../../loop/AgentLoop';

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

type Item = { item: string; confere: 'sim' | 'nao' | 'sem_evidencia'; evidencia?: string; trecho?: string };
const reg = new RegistroDeValidacoes();
reg.registrar(descritorSaidaContraEvidencia);

async function julgar(evidencias: string, resposta: string, itens: Item[]) {
    const saida = JSON.stringify({ estado: itens.some(i => i.confere === 'nao') ? 'reprovado' : 'aprovado', itens, confianca: 0.8, motivo: 'teste' });
    const r = await quiet(() => new ValidationEngine(fabrica(saida), reg, () => 'modelo-s479')
        .validar<DecisaoDeGrounding>('saida_contra_evidencia', { pedido: 'p', resposta, evidencias }));
    return r;
}

async function main(): Promise<void> {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 's479-'));
    const logOrig = process.env.LOG_FILE;
    process.env.LOG_FILE = path.join(base, 'newclaw-audit.log');
    try {
        console.log('\n=== S479-1 — contradição real com citação válida: REJECTED, nunca liberada ===');
        {
            const ev = '[E1] ferramenta=read\nFeriados: Finados é 02/11; 01/11/2026 é domingo.';
            const r = await julgar(ev, '01/11/2026 é feriado de Finados.', [
                { item: '01/11/2026 é feriado de Finados.', confere: 'nao', evidencia: 'E1', trecho: 'Finados é 02/11; 01/11/2026 é domingo' },
            ]);
            assert(r.adaptado.state === 'REJECTED', 'estado REJECTED', r.adaptado.state);
            assert(r.adaptado.claims[0].contradicaoApontada === true, 'a afirmação leva contradicaoApontada');
            assert(!AgentLoop.liberavelComAviso(r.adaptado), 'A1-r NÃO libera');
        }

        console.log('\n=== S479-2 — contradição real cuja citação não passa na conferência literal ===');
        {
            // Produção 30/10: a fonte veio com "�" (arquivo lido com a codificação errada) e o juiz citou sem ele.
            const ev1 = '[E1] ferramenta=exec_command\nhelp.html:490: Quando o grafo tem centenas de n�s, tudo fica amontoado. O Modo Foco resolve isso.';
            const r1 = await julgar(ev1, 'O Modo Foco que você usa é o do chat.', [
                { item: 'O Modo Foco é do chat, não do grafo', confere: 'nao', evidencia: 'E1', trecho: 'Quando o grafo tem centenas de nós, tudo fica amontoado. O Modo Foco resolve isso' },
            ]);
            const c1 = r1.veredito.itens[0];
            assert(c1.confere === 'sem_evidencia' && c1.citacaoConfere === false, 'o motor rebaixou o item (citação não confere)', c1);
            assert(c1.confereDoModelo === 'nao', 'o veredito original do modelo (nao) fica no item', c1);
            assert(r1.adaptado.state === 'NOT_EVALUABLE', 'o estado agregado é NOT_EVALUABLE', r1.adaptado.state);
            assert(r1.adaptado.claims[0].contradicaoApontada === true && !AgentLoop.liberavelComAviso(r1.adaptado), 'A1-r NÃO libera: o juiz apontou contradição');
            // Produção 04/11: trecho curto demais para conferir ("342").
            const ev2 = '[E2] ferramenta=exec_command\nExtraídas 342 linhas; gravado tmp_plano.txt';
            const r2 = await julgar(ev2, 'As três tentativas de extrair o texto falharam.', [
                { item: 'As três tentativas de extração falharam', confere: 'nao', evidencia: 'E2', trecho: '342' },
            ]);
            assert(r2.veredito.itens[0].confereDoModelo === 'nao' && !AgentLoop.liberavelComAviso(r2.adaptado), 'trecho curto: o `nao` original também impede a liberação');
        }

        console.log('\n=== S479-3 — afirmação verdadeira, citação com diferença de forma: sai com aviso ===');
        {
            const ev = '[E1] ferramenta=weather\nAmanhã (2026-11-03): Trovoada leve ou moderada 🌩️, 18.5°C–29.4°C, chuva 16%\n' +
                '[E2] ferramenta=read\nInstrutora Monique Em�dio de Oliveira: 36 h em 9 aulas\n' +
                '[E3] ferramenta=exec_command\n  Luciano: 15 x 4 h = 60 h\n' +
                '[E4] ferramenta=web_search\nquando o dispositivo está no Ambiente de Recuperação do Windows ( Windows RE).';
            const r = await julgar(ev, 'Previsão, carga horária e recuperação.', [
                { item: 'Amanhã: trovoada leve ou moderada, 18,5–29,4 °C, chuva 16%', confere: 'sim', evidencia: 'E1', trecho: 'Amanhã (2026-11-03): Trovoada leve ou moderada, 18.5°C–29.4°C, chuva 16%' },
                { item: 'Monique tem 36 h em 9 aulas', confere: 'sim', evidencia: 'E2', trecho: 'Monique Emdio de Oliveira: 36 h em 9 aulas' },
                { item: 'Luciano tem 60 h', confere: 'sim', evidencia: 'E3', trecho: 'Luciano: 15 aulas -> 60 h' },
                { item: 'A recuperação ocorre no Windows RE', confere: 'sim', evidencia: 'E4', trecho: 'Ambiente de Recuperacao do Windows (Windows RE)' },
            ]);
            const itens = r.veredito.itens;
            assert(itens.every(i => i.confere === 'sem_evidencia' && i.confereDoModelo === 'sim'), 'emoji, codificação, formatação e acento: os 4 rebaixados, com o "sim" do modelo guardado', itens.map(i => [i.confere, i.confereDoModelo]));
            assert(r.adaptado.state === 'NOT_EVALUABLE' && r.adaptado.claims.every(c => !c.contradicaoApontada), 'NOT_EVALUABLE sem contradição apontada');
            assert(AgentLoop.liberavelComAviso(r.adaptado), 'A1-r libera com aviso');
            const naoConfirmadas = r.adaptado.claims.filter(c => c.verdict === 'NOT_EVALUABLE').map(c => c.claim);
            const texto = AgentLoop.comAvisoNaoConfirmado('Resposta original.', naoConfirmadas, 'pt-BR');
            assert(texto.startsWith('Resposta original.'), 'a resposta original sai inteira');
            assert(naoConfirmadas.every(c => texto.includes(c)), 'o aviso lista cada afirmação não confirmada', texto);
            assert(texto.includes(AgentLoop.AVISO_NAO_CONFIRMADO['pt-BR'].titulo), 'com o título do aviso');
        }

        console.log('\n=== S479-4 — várias afirmações, pelo menos uma contraditória ===');
        {
            const ev = '[E1] ferramenta=read\n5 | 13/11/2026 | Sexta-feira | Excel (4 h)\n6 | 16/11/2026 | Segunda-feira | Excel (4 h)';
            const itensBase: Item[] = [
                { item: 'Aula 6 em 16/11', confere: 'sim', evidencia: 'E1', trecho: '6 | 16/11/2026 | Segunda-feira' },
                { item: 'Aulas de Word nas 16–19', confere: 'sem_evidencia' },
            ];
            const rValida = await julgar(ev, 'Aula 5: Windows; aula 6 em 16/11; Word nas 16–19.', [
                ...itensBase, { item: 'Aula 5: Windows', confere: 'nao', evidencia: 'E1', trecho: '5 | 13/11/2026 | Sexta-feira | Excel (4 h)' },
            ]);
            assert(rValida.adaptado.state === 'REJECTED' && !AgentLoop.liberavelComAviso(rValida.adaptado), 'uma contradição com citação válida entre sim e sem_evidencia: REJECTED, não liberada');
            const rInvalida = await julgar(ev, 'Aula 5: Windows; aula 6 em 16/11; Word nas 16–19.', [
                ...itensBase, { item: 'Aula 5: Windows', confere: 'nao', evidencia: 'E1', trecho: 'Aula 5 é de Excel' },
            ]);
            assert(rInvalida.adaptado.state === 'NOT_EVALUABLE', 'a contradição com citação inválida vira NOT_EVALUABLE no agregado', rInvalida.adaptado.state);
            assert(!AgentLoop.liberavelComAviso(rInvalida.adaptado), '…e mesmo assim NÃO é liberada');
        }

        console.log('\n=== S479-5 — A1-r nunca transforma REJECTED em liberação ===');
        {
            const c = (verdict: 'SUPPORTED' | 'NOT_SUPPORTED' | 'NOT_EVALUABLE', contradicaoApontada?: true) => ({ verdict, contradicaoApontada });
            assert(!AgentLoop.liberavelComAviso({ state: 'REJECTED', claims: [c('NOT_SUPPORTED', true)] }), 'REJECTED com contradição');
            assert(!AgentLoop.liberavelComAviso({ state: 'REJECTED', claims: [c('SUPPORTED'), c('NOT_EVALUABLE')] }), 'REJECTED mesmo sem item NOT_SUPPORTED na lista (estado manda)');
            assert(!AgentLoop.liberavelComAviso({ state: 'NOT_EVALUABLE', claims: [c('NOT_EVALUABLE'), c('NOT_SUPPORTED')] }), 'NOT_EVALUABLE com um NOT_SUPPORTED');
            assert(!AgentLoop.liberavelComAviso({ state: 'NOT_EVALUABLE', claims: [c('SUPPORTED')] }), 'NOT_EVALUABLE sem nenhum ponto não confirmado (nada a listar)');
            assert(!AgentLoop.liberavelComAviso({ state: 'UNVALIDATED', claims: [] }) && !AgentLoop.liberavelComAviso({ state: 'VALIDATED', claims: [c('SUPPORTED')] }), 'UNVALIDATED e VALIDATED seguem os próprios caminhos');
            assert(AgentLoop.liberavelComAviso({ state: 'NOT_EVALUABLE', claims: [c('SUPPORTED'), c('NOT_EVALUABLE')] }), 'só NOT_EVALUABLE sem contradição apontada é liberável');
        }

        console.log('\n=== S479-6 — no AgentLoop: depois da parcial, antes do bloqueio; REJECTED continua bloqueando ===');
        {
            const fonte = fs.readFileSync(path.join(process.cwd(), 'src', 'loop', 'AgentLoop.ts'), 'utf-8');
            const iParcial = fonte.indexOf('const partial = await this.trySynthesizePartialResponse(');
            const iUnvalidated = fonte.indexOf("if (g.state === 'UNVALIDATED') {", iParcial);
            const iA1r = fonte.indexOf('if (AgentLoop.liberavelComAviso(g)) {');
            const iBloqueio = fonte.indexOf('turnState.groundingBlock = {', iA1r);
            assert(iParcial > -1 && iA1r > iParcial, 'a resposta parcial é tentada antes (decisão: parcial primeiro)');
            assert(iA1r > iUnvalidated && iUnvalidated > -1, 'depois do ramo UNVALIDATED (que mantém o aviso de "não conferida")');
            assert(iBloqueio > iA1r, 'antes do bloqueio, que continua para REJECTED e para contradição apontada');
            const bloco = fonte.slice(iA1r, iBloqueio);
            assert(/comAvisoNaoConfirmado\(response, naoConfirmadas\)/.test(bloco) && /resposta_entregue_com_aviso_nao_confirmada/.test(bloco), 'entrega com o aviso e registra o efeito no gravador de voo');
            assert(!/validateGrounding\(|trySynthesizePartialResponse\(/.test(bloco), 'nenhum mecanismo novo de recuperação no ramo (sem nova chamada do juiz nem nova síntese)');
        }

        console.log('\n=== S479-7 — o aviso nos três idiomas ===');
        {
            for (const l of ['pt-BR', 'en-US', 'es-ES']) {
                const t = AgentLoop.comAvisoNaoConfirmado('ok', ['ponto A'], l);
                assert(t.includes(AgentLoop.AVISO_NAO_CONFIRMADO[l].titulo) && t.includes('• ponto A'), l);
            }
            assert(AgentLoop.comAvisoNaoConfirmado('ok', ['x'], 'xx-YY').includes(AgentLoop.AVISO_NAO_CONFIRMADO['pt-BR'].titulo), 'idioma desconhecido → pt-BR');
            const muitos = AgentLoop.comAvisoNaoConfirmado('ok', Array.from({ length: 11 }, (_, i) => `p${i}`), 'pt-BR');
            assert(muitos.includes('• p7') && !muitos.includes('• p8') && muitos.includes('…e mais 3'), 'mais de 8: mostra 8 e diz quantos faltam');
        }
    } finally {
        if (logOrig === undefined) delete process.env.LOG_FILE; else process.env.LOG_FILE = logOrig;
        // A pasta temporária NÃO é apagada aqui (mesmo padrão do S363): o stream de auditoria do AppLogger abre o arquivo de forma
        // assíncrona e, com a pasta já removida, emitia ENOENT sem handler e derrubava o processo (visto só dentro do executor).
    }
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S479 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error('S479 erro inesperado:', e); process.exit(1); });
