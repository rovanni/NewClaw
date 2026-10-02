/* S-A4 / 4a — replay do ponto de replan do incidente (goal_1790214597600_ov9eh, replan após o attempt 8).
 *
 *   --dry  : provider FALSO; só mede o prompt (off vs on). Não chama LLM.         (padrão)
 *   --real : provider REAL (ProviderFactory), N execuções por braço. Exige .env/OLLAMA_* da instância isolada.
 *
 * Uso (a partir da RAIZ do repositório; o caminho é relativo a ela):
 *   TS_NODE_PROJECT=tsconfig.json TS_NODE_TRANSPILE_ONLY=true \
 *     node node_modules/ts-node/dist/bin.js docs/<pasta-da-campanha>/instrumentos/replay.ts <copia.db> [--dry|--real] [N]
 * `<copia.db>` = CÓPIA (com os arquivos -wal/-shm) de um banco que contenha o goal do incidente; abre só em leitura.
 * Em --real: OLLAMA_URL, OLLAMA_MODEL, PLANNER_MODEL e DEFAULT_PROVIDER no ambiente (nenhuma credencial é gravada aqui).
 * Só imprime métricas agregadas; não imprime conteúdo de conversa.
 * Resultado da execução de 02/10/2026 (N=10 por braço): ver `resultados/replay-4a-resumo.txt` e a §11 do documento da campanha.
 *
 * AVISO (02/10/2026, §12.7 do documento da campanha): este replay registra APENAS 5 ferramentas (edit, send_document,
 * list_workspace, read, exec_command), não as ~22 de produção. Medido: com as 22 o prompt `off` vai de 8 907 para 10 310 chars
 * (+16%). O efeito disso no resultado da §11 é desconhecido. O replay do RC1 (`replay_rc1.ts`) usa o conjunto completo.
 *
 * LIMITE CONHECIDO (declarado no plano): o banco não guarda o runtimeContext (memória), o contexto de
 * capacidades nem a reflexão do replan original. O replay roda com o prompt MAIS LEVE que o de produção
 * (a parte estática real é 64–79% do prompt) → tende a SUPERESTIMAR o efeito do bloco. É um limite superior.
 */
process.env.WORKSPACE_DIR = process.env.WORKSPACE_DIR || require('path').join(require('os').tmpdir(), 'newclaw-harness-workspace');
import { GoalPlanner } from '../../../src/loop/GoalPlanner';
import { ToolRegistry } from '../../../src/core/ToolRegistry';
import { EditTool } from '../../../src/tools/edit_tool';
import { SendDocumentTool } from '../../../src/tools/send_document';
import { ListWorkspaceTool } from '../../../src/tools/list_workspace';
import { ReadTool } from '../../../src/tools/read_tool';
import { ExecCommandTool } from '../../../src/tools/exec_command';
import { Goal, GoalBlocker } from '../../../src/loop/GoalTypes';

const Database = require('better-sqlite3');
const GOAL_ID = 'goal_1790214597600_ov9eh';
const REPLAN_AFTER_ATTEMPT = 8;                    // a `read` de aulas_extraidas.md que falhou
const ARTIFACT_RE = /extracao_aulas/i;             // o caminho tmp/extracao_aulas.txt do attempt 7

const dbPath = process.argv[2];
const mode = process.argv.includes('--real') ? 'real' : 'dry';
const N = Number(process.argv.find(a => /^\d+$/.test(a)) ?? (mode === 'real' ? 10 : 1));

for (const mk of [() => new EditTool(), () => new SendDocumentTool({} as never), () => new ListWorkspaceTool(), () => new ReadTool()]) {
    try { ToolRegistry.register(mk() as never); } catch { /* já registrado */ }
}
try { ToolRegistry.register(new ExecCommandTool() as never); } catch { /* já registrado ou exige args */ }

function loadGoal(): { goal: Goal; blocker: GoalBlocker; meta: Record<string, unknown> } {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const r = db.prepare('select * from goals where id = ?').get(GOAL_ID);
    if (!r) throw new Error(`goal ${GOAL_ID} não está na cópia`);
    const j = (s: string | null, d: unknown) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
    const attempts = (j(r.attempts, []) as never[]).slice(0, REPLAN_AFTER_ATTEMPT);
    const allBlockers = j(r.blockers, []) as GoalBlocker[];
    // O blocker do replan após o attempt 8 é o tool_error da `read` (índice 1 dos 3 gravados).
    const blockers = allBlockers.slice(0, 2);
    const blocker = blockers[blockers.length - 1];
    const now = Date.now();
    const goal = {
        id: r.id, sessionKey: r.session_key, conversationId: r.conversation_id,
        userIntent: r.user_intent, objective: r.objective, status: 'blocked',
        currentPlan: [], attempts, blockers,
        toolsTried: j(r.tools_tried, []),
        // ANACRONISMO evitado: no replan após o attempt 8 só existiam 2 estratégias (plano inicial + replan do 1º blocker);
        // as demais (inclusive a nº 6, que cita o artefato) e o current_plan FINAL são posteriores ao ponto reconstruído.
        strategiesTried: (j(r.strategies_tried, []) as string[]).slice(0, 2),
        successCriteria: j(r.success_criteria, []), sentArtifacts: j(r.sent_artifacts, []),
        retryBudget: 3, replanBudget: 5, confidence: r.confidence ?? 0.8,
        requiresAuth: false, authorizationScope: [],
        createdAt: now, updatedAt: now, expiresAt: now + 3_600_000,
    } as unknown as Goal;
    return { goal, blocker, meta: { attempts: attempts.length, blockers: blockers.length, blockerKind: blocker?.kind, blockerTool: (blocker as { toolName?: string }).toolName } };
}

function makePlanner(real: boolean): { planner: GoalPlanner; prompts: string[] } {
    const prompts: string[] = [];
    if (!real) {
        const OK = JSON.stringify({ steps: [{ id: 'step_1', description: 'x', toolName: 'read', toolArgs: { path: 'a.txt' } }], strategy: 'dry' });
        const chat = async (m: Array<{ content: string }>) => { prompts.push(m[0]?.content ?? ''); return { content: OK }; };
        const pf = { getProviderWithModel: () => ({ chat }), chatWithFallback: async (m: Array<{ content: string }>) => ({ status: 'success', content: (await chat(m)).content, attempts: [] }) } as never;
        return { planner: new GoalPlanner(pf, { findBlockerLessons: () => '', findHardConstraints: () => [] } as never), prompts };
    }
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { ProviderFactory } = require('../../../src/core/ProviderFactory');
    const pf = new ProviderFactory({
        ollamaUrl: process.env.OLLAMA_URL, ollamaModel: process.env.OLLAMA_MODEL, ollamaApiKey: process.env.OLLAMA_API_KEY,
        defaultProvider: process.env.DEFAULT_PROVIDER || 'ollama',
    });
    // Captura o 1º prompt REAL enviado ao LLM (no modo real o provider falso não existe): permite medir promptChars
    // e provar, em cada execução, se o artefato estava ou não no prompt do braço.
    const origChat = pf.chatWithFallback.bind(pf);
    pf.chatWithFallback = async (m: Array<{ content: string }>, ...rest: unknown[]) => { prompts.push(m[0]?.content ?? ''); return origChat(m, ...rest); };
    const planner = new GoalPlanner(pf, { findBlockerLessons: () => '', findHardConstraints: () => [] } as never);
    if (process.env.PLANNER_MODEL) (planner as unknown as { model?: string }).model = process.env.PLANNER_MODEL;
    return { planner, prompts };
}

async function arm(factsMode: 'off' | 'on'): Promise<{ promptChars: number[]; cites: number; total: number; ms: number[] }> {
    const out = { promptChars: [] as number[], cites: 0, total: 0, ms: [] as number[] };
    for (let i = 0; i < N; i++) {
        if (factsMode === 'on') process.env.REPLAN_FACTS = 'on'; else delete process.env.REPLAN_FACTS;
        const { goal, blocker } = loadGoal();
        const { planner, prompts } = makePlanner(mode === 'real');
        const t0 = Date.now();
        const plan = await planner.replan(goal, blocker);
        out.ms.push(Date.now() - t0);
        const steps = JSON.stringify(plan?.steps ?? []);
        out.total++;
        if (ARTIFACT_RE.test(steps)) out.cites++;
        if (prompts[0]) out.promptChars.push(prompts[0].length);
    }
    delete process.env.REPLAN_FACTS;
    return out;
}

async function main() {
    const { goal, blocker, meta } = loadGoal();
    console.log(`=== replay S-A4/4a — modo=${mode} N=${N} ===`);
    console.log('estado reconstruído:', JSON.stringify(meta), '| blocker presente:', !!blocker);
    if (mode === 'dry') {
        delete process.env.REPLAN_FACTS;
        const a = makePlanner(false); await a.planner.replan(structuredClone(goal), blocker);
        process.env.REPLAN_FACTS = 'on';
        const b = makePlanner(false); await b.planner.replan(structuredClone(goal), blocker);
        delete process.env.REPLAN_FACTS;
        const off = a.prompts[0] ?? '', on = b.prompts[0] ?? '';
        console.log(`prompt off: ${off.length} chars | on: ${on.length} chars | acréscimo: ${on.length - off.length} chars (≈ ${Math.ceil((on.length - off.length) / 3.5)} tokens)`);
        console.log(`artefato (extracao_aulas) no prompt — off: ${ARTIFACT_RE.test(off)} | on: ${ARTIFACT_RE.test(on)}`);
        const marker = 'FATOS DA EXECUÇÃO';
        console.log(`bloco presente — off: ${off.includes(marker)} | on: ${on.includes(marker)}`);
        return;
    }
    type Tally = { cites: number; uses: number; total: number; chars: number[]; ms: number[] };
    const tally: Record<'off' | 'on', Tally> = {
        off: { cites: 0, uses: 0, total: 0, chars: [], ms: [] },
        on: { cites: 0, uses: 0, total: 0, chars: [], ms: [] },
    };
    for (let i = 0; i < N; i++) {
        // alterna a ordem dos braços a cada rodada: sem viés de ordem nem de horário
        const order: Array<'off' | 'on'> = i % 2 === 0 ? ['off', 'on'] : ['on', 'off'];
        for (const m of order) {
            console.log(`ARM-START arm=${m} i=${i + 1} t=${new Date().toISOString()}`);
            if (m === 'on') process.env.REPLAN_FACTS = 'on'; else delete process.env.REPLAN_FACTS;
            const { goal, blocker } = loadGoal();
            const { planner, prompts } = makePlanner(true);
            const t0 = Date.now();
            let steps = '[]';
            let toolsList = '';
            let uses = false;
            try {
                const plan = await planner.replan(goal, blocker);
                steps = JSON.stringify(plan?.steps ?? []);
                toolsList = (plan?.steps ?? []).map((x: { toolName?: string }) => x.toolName ?? 'agentloop').join(',');
                // Critério ESTRITO (definido após a 1ª execução mostrar que a regex fraca casa com um plano que reextrai do zero):
                // o plano CONSOME o artefato existente = algum passo `read` cujo caminho cita o artefato, ou um `exec_command`
                // que cita o artefato SEM ser uma escrita dele. Heurística — por isso cada passo é logado para auditoria.
                const WRITE_RE = /open\([^)]*['"]\s*[wa]|write_text|\bSet-Content\b|\bOut-File\b|\btee\b|>\s*\S*extracao_aulas|extracao_aulas\S*\s*=\s*open/i;
                (plan?.steps ?? []).forEach((st: { toolName?: string; toolArgs?: Record<string, unknown>; description?: string }, k: number) => {
                    const args = JSON.stringify(st.toolArgs ?? {});
                    const mentions = ARTIFACT_RE.test(args) || ARTIFACT_RE.test(st.description ?? '');
                    const cmd = String(st.toolArgs?.command ?? '');
                    const writes = st.toolName === 'exec_command' && WRITE_RE.test(cmd);
                    const consumes = mentions && (st.toolName === 'read' || (st.toolName === 'exec_command' && !writes));
                    if (consumes) uses = true;
                    console.log(`STEP arm=${m} i=${i + 1} n=${k + 1} tool=${st.toolName ?? 'agentloop'} mentions=${mentions} writes=${writes} consumes=${consumes}`);
                });
            } catch (e) { console.log('RUN-ERRO ' + String(e).slice(0, 120)); }
            delete process.env.REPLAN_FACTS;
            const ms = Date.now() - t0;
            const cites = ARTIFACT_RE.test(steps);                      // critério FRACO (mantido só para comparação)
            const chars = prompts[0]?.length ?? 0;
            const promptHasArtifact = ARTIFACT_RE.test(prompts[0] ?? '');
            tally[m].total++; if (cites) tally[m].cites++; if (uses) tally[m].uses++; tally[m].chars.push(chars); tally[m].ms.push(ms);
            console.log(`RUN arm=${m} i=${i + 1} uses_existing=${uses} cites_weak=${cites} promptHasArtifact=${promptHasArtifact} promptChars=${chars} ms=${ms} tools=${toolsList}`);
        }
    }
    const med = (xs: number[]) => xs.length ? xs.slice().sort((x, y) => x - y)[Math.floor(xs.length / 2)] : 0;
    console.log(`RESULT OFF: consome o artefato em ${tally.off.uses}/${tally.off.total} (critério estrito) | cita em ${tally.off.cites}/${tally.off.total} (fraco) | prompt p50 ${med(tally.off.chars)} chars | tempo p50 ${med(tally.off.ms)} ms`);
    console.log(`RESULT ON : consome o artefato em ${tally.on.uses}/${tally.on.total} (critério estrito) | cita em ${tally.on.cites}/${tally.on.total} (fraco) | prompt p50 ${med(tally.on.chars)} chars | tempo p50 ${med(tally.on.ms)} ms`);
}

main().then(() => process.exit(0)).catch(e => { console.error('ERRO:', e); process.exit(1); });
