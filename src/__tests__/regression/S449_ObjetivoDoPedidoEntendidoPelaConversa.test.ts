/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S449 (ADR-029, 24/10/2026)
 *
 * O objetivo nasce do pedido ENTENDIDO PELA CONVERSA, não do texto cru — o padrão "standalone question" da
 * LangChain/LlamaIndex, escrito pelo juiz de suficiência (ADR-015), que já recebe a conversa e já resolvia o referente.
 *
 * ORIGEM: VPS, Telegram, 24/10/2026. "Pode fazer?" (depois de "criar uma versão do CamScanner em Rust e HTML") virou o
 * objetivo literal "Pode fazer?" — plano "confirmação de capacidades", passos com rustscan. "Essa porta é muito comum…"
 * começou pela porta 30000 do Luanti. O juiz tinha escrito, nos dois casos, o que era pedido; só `acao` era usada.
 *
 * REGRESSÃO SE: o tipo deixar de pedir `pedido_completo`; a decisão não o devolver ao seguir; ele valer quando o juiz manda
 * perguntar ou fica sem veredito; o objetivo voltar a ser o texto cru com o pedido completo disponível; ou o texto literal
 * deixar de ir junto (`userIntent`, lido pelo planejador como INTENÇÃO ORIGINAL).
 *
 * Execução: npx ts-node src/__tests__/regression/S449_ObjetivoDoPedidoEntendidoPelaConversa.test.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { ValidationEngine } from '../../validation/ValidationEngine';
import { criarRegistroPadrao } from '../../validation/motorPadrao';
import { validarDescritor } from '../../validation/contratoDeValidacao';
import { descritorSuficienciaDoPedido, TIPO_SUFICIENCIA_DO_PEDIDO, type DecisaoDeSuficiencia } from '../../validation/tipos/suficienciaDoPedido';

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string, detail?: unknown): void {
    if (cond) { console.log(`  ✅ ${msg}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${msg}`, detail ?? ''); failed++; }
}

function motorCom(resposta: object | null, status = 'success'): { motor: ValidationEngine; prompts: string[] } {
    const prompts: string[] = [];
    const pf = {
        getBudgetAuxiliar: () => ({ timeoutMs: 30_000, origem: 'padrao', latenciaTipicaMs: null }),
        chatWithFallback: async (msgs: Array<{ content: string }>) => {
            prompts.push(msgs[0].content);
            return { status, content: resposta ? JSON.stringify(resposta) : '', attempts: [] };
        },
    } as any;
    return { motor: new ValidationEngine(pf, criarRegistroPadrao(), () => undefined), prompts };
}

// A conversa real das 11:24–11:29 (resumida nas falas, literal no essencial).
const CONVERSA = [
    'Usuário: Conhece o aplicativo camscanner?',
    'Assistente: Sim, conheço bem o CamScanner: ele transforma o celular num scanner de documentos.',
    'Usuário: Eu queria criar uma versão desse programa, utilizando Rust e HTML é possível?',
    'Assistente: Sim, é possível: um servidor em Rust que faz o tratamento da imagem e uma interface em HTML.',
].join('\n');
const COMPLETO = 'Criar uma versão do aplicativo CamScanner usando Rust e HTML';

async function main(): Promise<void> {
    const validar = (m: ValidationEngine, entradas: Record<string, string>) =>
        m.validar<DecisaoDeSuficiencia>(TIPO_SUFICIENCIA_DO_PEDIDO, entradas).then(r => r.adaptado);

    console.log('\n=== S449-1 — o tipo pede o pedido completo, com a regra do padrão "standalone question" ===');
    {
        assert(validarDescritor(descritorSuficienciaDoPedido as never).length === 0, 'o tipo continua válido com o campo novo');
        const p = new ValidationEngine({} as any, criarRegistroPadrao()).montarPrompt(descritorSuficienciaDoPedido as never, { pedido: 'Pode fazer?', conversa: CONVERSA });
        assert(/"pedido_completo"/.test(p) && /que se entenda SEM a conversa/.test(p), 'o formato pede pedido_completo, entendível sem a conversa');
        assert(/Não acrescente nada que não esteja escrito, não responda ao pedido/.test(p) && /já se entende sozinho, copie-o igual/.test(p),
            'não inventa, não responde; pedido autônomo é copiado igual');
        assert(p.includes('Eu queria criar uma versão desse programa'), 'a conversa recente chega ao juiz (a evidência da reescrita)');
    }

    console.log('\n=== S449-2 — decisões: o pedido completo só vale quando o juiz manda seguir ===');
    {
        const caso = motorCom({ estado: 'aprovado', itens: [], pedido_completo: `  ${COMPLETO}  ` });
        const d = await validar(caso.motor, { pedido: 'Pode fazer?', conversa: CONVERSA });
        assert(d.acao === 'seguir' && d.pedidoCompleto === COMPLETO, 'o caso real: "Pode fazer?" → o pedido completo, sem espaços nas pontas', d);

        const vazio = motorCom({ estado: 'aprovado', itens: [], pedido_completo: '   ' });
        assert((await validar(vazio.motor, { pedido: 'Pode fazer?' })).pedidoCompleto === undefined, 'em branco → ausente (vale o texto do pedido)');

        const semCampo = motorCom({ estado: 'aprovado', itens: [] });
        assert((await validar(semCampo.motor, { pedido: 'Pode fazer?' })).pedidoCompleto === undefined, 'modelo não escreveu o campo → ausente');

        const pergunta = motorCom({ estado: 'reprovado', itens: [{ item: 'qual programa', confere: 'nao' }], pergunta_ao_usuario: 'Qual programa?', pedido_completo: 'Criar algo' });
        const dp = await validar(pergunta.motor, { pedido: 'Pode fazer?' });
        assert(dp.acao === 'perguntar' && dp.pedidoCompleto === undefined, 'faltou dado → pergunta; o pedido completo não vale (não há objetivo)', dp);

        const fora = motorCom(null, 'timeout');
        const df = await validar(fora.motor, { pedido: 'Pode fazer?' });
        assert(df.acao === 'sem_veredito' && df.pedidoCompleto === undefined, 'sem veredito → ausente (comportamento de antes)', df);
    }

    console.log('\n=== S449-3 — encaixe: o objetivo nasce do pedido completo; o literal vai junto ===');
    {
        const src = fs.readFileSync(path.join(process.cwd(), 'src', 'loop', 'GoalOrchestrator.ts'), 'utf-8');
        assert(/pedidoCompleto = decisao\.pedidoCompleto;/.test(src), 'a decisão do juiz de suficiência é guardada (antes: só `acao`)');
        assert(/const objetivo = pedidoCompleto \|\| classification\.objective \|\| message;/.test(src), 'objetivo: pedido completo → objetivo do classificador → texto cru');
        const iCreate = src.indexOf('const goal = this.goalStore.create({');
        const bloco = src.slice(iCreate, iCreate + 300);
        assert(/userIntent: message,/.test(bloco) && /objective: objetivo,/.test(bloco), 'userIntent continua o texto literal; objective recebe o pedido entendido');
        assert(/\[PEDIDO-COMPLETO\] cru=/.test(src), 'cru e completo vão para o log (auditoria da reescrita)');
        const planner = fs.readFileSync(path.join(process.cwd(), 'src', 'loop', 'GoalPlanner.ts'), 'utf-8');
        assert(/OBJETIVO GLOBAL: \$\{goal\.objective\}\nINTENÇÃO ORIGINAL: \$\{goal\.userIntent\}/.test(planner),
            'o planejador lê os dois: o pedido entendido e o literal (proteção contra reescrita errada)');
    }

    console.log(`\nS449 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(e => { console.error(e); process.exitCode = 1; });
