/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S385 (RFC-010 / Sprint S3)
 *
 * Incidente real em produção (11/10/2026, turno "E meus e-mails alguma novidade?"):
 * O AgentLoop esgotou o orçamento de passos (4 passos) chamando memory_search e read (lendo check_inbox_himalaya.py).
 * Como 'read' não constava em INFO_TOOLS, a síntese pós-ação tratou a leitura como uma AÇÃO realizada
 * ("Confirme ao usuário O QUE foi realizado... você JÁ fez") e não informou que o orçamento de passos esgotou.
 * O modelo inventou que a checagem da caixa havia retornado 0 mensagens.
 *
 * Este teste valida:
 *   1 → 'read', 'read_document', 'list_workspace' ativam o ramo de recuperação de informação (isInfoRetrieval);
 *   2 → Quando o orçamento de passos é atingido (stepCount >= maxSteps), o aviso objetivo de limite de passos é injetado;
 *   3 → O aviso proíbe afirmar ações/checagens que foram apenas lidas no código mas não executadas;
 *   4 → O ramo de operação/ação também inclui a regra contra afirmar ações não executadas.
 *
 * Execução: npx ts-node src/__tests__/regression/S385_Synthesis_ReadIsInfoRetrievalAndStepLimitNotice.test.ts
 */
process.env.WORKSPACE_DIR = process.env.WORKSPACE_DIR || 'D:/IA/newclaw/workspace';

import { AgentLoop } from '../../loop/AgentLoop';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

type Msg = { role: string; content?: string; tool_call_id?: string };
type Hist = { step: number; tool: string; input: string; status: string };

async function runSynthesis(history: Hist[], toolOutputs: string[], stepCount: number, maxSteps: number): Promise<Msg[]> {
    let captured: Msg[] = [];
    const fakeThis = {
        ts: () => 'T',
        getTurnState: () => ({ lastToolExecution: undefined }),
        profileRegistry: { getProfileByCategory: () => ({ category: 'execution', model: 'fake', provider: 'fake' }) },
        callLLMWithFallback: async (messages: Msg[]) => {
            captured = messages;
            return { status: 'success', content: 'Resposta final de teste com mais de vinte caracteres para a síntese.' };
        },
        persistTrace: () => undefined,
        commitResponse: async (...a: unknown[]) => a[0],
        activeTurns: new Map(),
    };
    const loopMessages: Msg[] = [
        { role: 'system', content: 'SISTEMA' },
        { role: 'user', content: 'E meus e-mails alguma novidade?' },
        ...toolOutputs.map((c, i) => ({ role: 'tool', content: c, tool_call_id: `call_${i}` })),
    ];
    const trace = {} as never;
    const move = (): void => undefined;
    try {
        await (AgentLoop.prototype as unknown as { runSynthesisAndFallbackPhase: (...a: unknown[]) => Promise<unknown> })
            .runSynthesisAndFallbackPhase.call(
                fakeThis, 'conv-test', 'E meus e-mails alguma novidade?', history, loopMessages, '', false, '',
                { category: 'conversation', model: 'fake' }, new AbortController().signal, trace, undefined, stepCount, maxSteps, 0, move, false,
            );
    } catch {
        // Simulação da fase
    }
    return captured;
}

const sysText = (m: Msg[]): string => m.filter(x => x.role === 'system').map(x => x.content ?? '').join('\n');
const toolText = (m: Msg[]): string[] => m.filter(x => x.role === 'tool').map(x => x.content ?? '');

(async () => {
    console.log('\n[1] Turno com memory_search + read (caso real de 11/10/2026 23:51)');
    {
        const history: Hist[] = [
            { step: 1, tool: 'memory_search', input: 'gmail', status: 'success' },
            { step: 2, tool: 'read', input: 'check_inbox_himalaya.py', status: 'success' },
        ];
        const outputs = ['Config do himalaya na memória', 'conteudo do script python'];
        const msgs = await runSynthesis(history, outputs, 4, 4);
        const sys = sysText(msgs);

        assert(sys.includes('Você consultou as seguintes fontes:'), 'ativou ramo de recuperação de informação (infoRetrieval), não ação');
        assert(!sys.includes('Confirme ao usuário O QUE foi realizado'), 'NÃO usa a instrução de "confirmar ação já feita"');
        assert(sys.includes('REGRA ABSOLUTA — NÃO FABRIQUE DADO'), 'contém a regra contra fabricação de dados');
        assert(sys.includes('ATENÇÃO AO LIMITE DE PASSOS'), 'informa que o limite de passos foi atingido');
        assert(sys.includes('NÃO afirme que executou a checagem ou o script'), 'alerta para não confundir ler script com executar');
        assert(toolText(msgs).length === 2, 'todos os resultados lidos são mantidos no contexto para a síntese');
    }

    console.log('\n[2] Turno com passos restantes (stepCount < maxSteps)');
    {
        const history: Hist[] = [
            { step: 1, tool: 'memory_search', input: 'gmail', status: 'success' },
        ];
        const outputs = ['Config do himalaya na memória'];
        const msgs = await runSynthesis(history, outputs, 1, 4);
        const sys = sysText(msgs);

        assert(!sys.includes('ATENÇÃO AO LIMITE DE PASSOS'), 'sem esgotamento: não injeta aviso de limite');
        assert(sys.includes('Você consultou as seguintes fontes:'), 'continua como recuperação de informação');
    }

    console.log('\n[3] Turno com ferramenta de escrita/operação (write / exec_command)');
    {
        const history: Hist[] = [
            { step: 1, tool: 'write', input: 'teste.txt', status: 'success' },
        ];
        const outputs = ['Arquivo criado com sucesso.'];
        const msgs = await runSynthesis(history, outputs, 2, 2);
        const sys = sysText(msgs);

        assert(sys.includes('Confirme ao usuário O QUE foi realizado'), 'ferramenta de escrita usa o ramo de confirmação de ação');
        assert(sys.includes('REGRA ABSOLUTA — NÃO AFIRME AÇÕES NÃO EXECUTADAS'), 'ramo de ação proíbe afirmar ações não executadas');
        assert(sys.includes('ATENÇÃO AO LIMITE DE PASSOS'), 'aviso de limite presente também no ramo de ação quando esgotado');
    }

    console.log(`\n${passed} passaram, ${failed} falharam`);
    process.exit(failed > 0 ? 1 : 0);
})().catch(err => {
    console.error('Erro no teste S385:', err);
    process.exit(1);
});
