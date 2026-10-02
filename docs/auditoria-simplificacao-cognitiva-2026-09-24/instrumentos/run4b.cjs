/* S-A4 / 4b — goals reais de ponta a ponta, REPLAN_FACTS off x on, dois braços SIMULTÂNEOS em instâncias isoladas.
 *
 * PROTOCOLO (pré-registrado, definido antes de qualquer execução):
 *  - braço off  : porta 3198, sem REPLAN_FACTS.     braço on : porta 3199, REPLAN_FACTS=on.
 *  - 3 cenários (A controle; B padrão do incidente; C handoff de arquivo) x 2 repetições, mesma ordem nos dois braços.
 *  - workspace re-semeado antes de cada goal (arquivos de aulas com tokens únicos).
 *  - sucesso = (a) goal terminou sem ficar bloqueado/timeout E (b) verificação por ARQUIVO no workspace (não só o status).
 *  - métricas por goal: status, ciclos, replans, duração, abortos de replan do planner, linhas [REPLAN-FACTS].
 *  - C6: `on` não conclui menos goals que `off` e não gera bloqueio novo. Amostra pequena => exploratório.
 * Só estatísticas/arquivos agregados; sem copiar conteúdo de conversa do usuário (os cenários são sintéticos).
 *
 * Uso (a partir da raiz do repositório): `node docs/<pasta-da-campanha>/instrumentos/run4b.cjs`
 *   NEWCLAW_REPO  = raiz do repositório (padrão: 3 níveis acima deste arquivo).
 *   HARNESS_ROOT  = pasta de trabalho (instâncias, bancos, workspaces, progress.log, results.json); padrão: <tmp do SO>/newclaw-verify-4b.
 * Exige as portas 3198 e 3199 livres e o Ollama local com o modelo `glm-5.3:cloud`. Encerra as instâncias ao fim.
 * Resultado da execução de 02/10/2026: ver `resultados/4b-results.json` e a §12 do documento da campanha.
 * ATENÇÃO — defeitos de método conhecidos (§12.4 do documento): timeout de 15 min curto para o cenário B e goals que
 * estouram o tempo continuam rodando durante o goal seguinte. Corrija antes de reutilizar para uma resposta decisiva.
 */
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = process.env.HARNESS_ROOT || path.join(require('os').tmpdir(), 'newclaw-verify-4b');
const REPO = process.env.NEWCLAW_REPO || path.resolve(__dirname, '..', '..', '..');
const GOAL_TIMEOUT_MS = 15 * 60 * 1000;
const ARMS = [{ name: 'off', port: 3198, env: {} }, { name: 'on', port: 3199, env: { REPLAN_FACTS: 'on' } }];

const AULAS = {
    'aula1.txt': 'AULA-1-TOKEN\nO modelo OSI divide a comunicação em sete camadas.\nA camada física trata dos sinais.',
    'aula2.txt': 'AULA-2-TOKEN\nO IPv4 usa endereços de 32 bits.\nO IPv6 usa endereços de 128 bits.',
    'aula3.txt': 'AULA-3-TOKEN\nO DHCP atribui endereços automaticamente.\nO DNS traduz nomes em endereços.',
    'aula4.txt': 'AULA-4-TOKEN\nUm firewall filtra o tráfego por regras.\nA DMZ isola serviços expostos.',
    'aula5.txt': 'AULA-5-TOKEN\nO TCP é orientado a conexão.\nO UDP não garante entrega.',
};
const SCENARIOS = [
    { id: 'A', message: 'Crie o arquivo notas.txt no workspace com a palavra teste e me envie.',
      check: (ws) => { const f = path.join(ws, 'notas.txt'); return fs.existsSync(f) && /teste/i.test(fs.readFileSync(f, 'utf8')); } },
    { id: 'B', message: 'Na pasta aulas do workspace há 5 arquivos de texto. Escreva um script Python que leia todos eles e grave o conteúdo reunido em tmp/extracao_aulas.txt, execute o script e depois leia esse arquivo e me envie um resumo de 5 linhas.',
      check: (ws) => { const f = path.join(ws, 'tmp', 'extracao_aulas.txt'); if (!fs.existsSync(f)) return false; const t = fs.readFileSync(f, 'utf8'); return [1, 2, 3, 4, 5].every(n => t.includes(`AULA-${n}-TOKEN`)); } },
    { id: 'C', message: 'Liste os arquivos da pasta aulas, salve a lista em tmp/lista.txt com um nome por linha, depois conte quantas linhas tem esse arquivo e me diga o número.',
      check: (ws) => { const f = path.join(ws, 'tmp', 'lista.txt'); if (!fs.existsSync(f)) return false; return fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(l => l.trim()).length === 5; } },
];
const REPS = 2;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const clean = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const progress = (m) => { const line = `${new Date().toISOString()} ${m}`; fs.appendFileSync(path.join(ROOT, 'progress.log'), line + '\n'); console.log(line); };

function armDir(a) { return path.join(ROOT, `arm-${a.name}`); }
function seed(a) {
    const ws = path.join(armDir(a), 'workspace');
    fs.rmSync(ws, { recursive: true, force: true });
    fs.mkdirSync(path.join(ws, 'aulas'), { recursive: true });
    for (const [n, c] of Object.entries(AULAS)) fs.writeFileSync(path.join(ws, 'aulas', n), c);
    return ws;
}
function setup(a) {
    const d = armDir(a);
    fs.rmSync(d, { recursive: true, force: true });
    for (const s of ['data', 'logs', 'tmp', 'workspace']) fs.mkdirSync(path.join(d, s), { recursive: true });
    fs.cpSync(path.join(REPO, 'skills'), path.join(d, 'skills'), { recursive: true });   // cópia: o aprendizado de skills não suja o repositório
    const env = [
        'DEFAULT_PROVIDER=ollama', 'OLLAMA_URL=http://localhost:11434', 'OLLAMA_MODEL=glm-5.2:cloud',
        'MODEL_CHAT=glm-5.3:cloud', 'MODEL_CODE=glm-5.3:cloud', 'MODEL_LIGHT=glm-5.3:cloud', 'MODEL_ANALYSIS=glm-5.3:cloud', 'MODEL_EXECUTION=glm-5.3:cloud',
        'PLANNER_MODEL=glm-5.3:cloud', 'RISK_MODEL=glm-5.3:cloud', 'OBSERVER_MODEL=glm-5.3:cloud',
        'OWNER_NAME=VerifyTester', 'OWNER_USER_ID=verify_owner',
        `DASHBOARD_PORT=${a.port}`, 'DASHBOARD_HOST=127.0.0.1',
        `SKILLS_DIR=${d.replace(/\\/g, '/')}/skills`, `WORKSPACE_DIR=${d.replace(/\\/g, '/')}/workspace`,
        `TMP_DIR=${d.replace(/\\/g, '/')}/tmp`, `LOG_FILE=${d.replace(/\\/g, '/')}/logs/newclaw-audit.log`,
        ...Object.entries(a.env).map(([k, v]) => `${k}=${v}`),
    ].join('\n') + '\n';
    fs.writeFileSync(path.join(d, '.env'), env);
}
function listenerPid(port) {
    const out = execSync('netstat -ano', { encoding: 'utf8' });
    const m = out.split('\n').find(l => l.includes(`:${port} `) && l.includes('LISTENING'));
    return m ? Number(m.trim().split(/\s+/).pop()) : null;
}
async function boot(a) {
    const d = armDir(a);
    if (listenerPid(a.port)) throw new Error(`porta ${a.port} já ocupada (PID ${listenerPid(a.port)})`);
    const out = fs.openSync(path.join(d, 'boot.log'), 'w');
    const child = spawn('node', [path.join(REPO, 'node_modules/ts-node/dist/bin.js'), path.join(REPO, 'src/index.ts')], {
        cwd: d, stdio: ['ignore', out, out], windowsHide: true,
        env: { ...process.env, TS_NODE_PROJECT: path.join(REPO, 'tsconfig.json'), TS_NODE_TRANSPILE_ONLY: 'true' },
    });
    a.child = child; a.pid = child.pid;
    for (let i = 0; i < 40; i++) {
        await sleep(3000);
        if (/Dashboard.*rodando/.test(clean(fs.readFileSync(path.join(d, 'boot.log'), 'utf8')))) break;
    }
    const owner = listenerPid(a.port);
    if (owner !== child.pid) throw new Error(`porta ${a.port}: dono=${owner} difere do filho=${child.pid}`);
    const r = await fetch(`http://127.0.0.1:${a.port}/api/system/capability-mode`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'developer' }) });
    progress(`arm=${a.name} boot ok pid=${child.pid} porta=${a.port} developer_mode_http=${r.status}`);
}
function stop(a) { try { execSync(`taskkill /F /T /PID ${a.pid}`, { stdio: 'ignore' }); } catch { /* já encerrado */ } }

function db(a) { const D = require(path.join(REPO, 'node_modules/better-sqlite3')); return new D(path.join(armDir(a), 'data', 'newclaw.db'), { readonly: true, fileMustExist: true }); }

async function runGoal(a, scn, rep) {
    const d = armDir(a);
    const sid = `v4b-${scn.id}-${rep}`;
    const ws = seed(a);
    const bootLog = path.join(d, 'boot.log');
    const t0 = Date.now();
    const res = await fetch(`http://127.0.0.1:${a.port}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: scn.message, sessionId: sid }) });
    let finished = false;
    while (Date.now() - t0 < GOAL_TIMEOUT_MS) {
        await sleep(5000);
        if (clean(fs.readFileSync(bootLog, 'utf8')).split('\n').some(l => l.includes('[USER-MESSAGE]') && l.includes(`session=web:${sid}`))) { finished = true; break; }
    }
    const ms = Date.now() - t0;
    const log = clean(fs.readFileSync(bootLog, 'utf8')).split('\n');
    let row = null;
    try { const x = db(a); row = x.prepare("select id,status,attempts,blockers from goals where session_key like ? order by created_at desc limit 1").get(`%${sid}%`); x.close(); } catch (e) { /* sem goal */ }
    const goalId = row?.id;
    const mine = goalId ? log.filter(l => l.includes(goalId)) : [];
    const res2 = mine.find(l => l.includes('[GOAL-RESULT]')) ?? '';
    const gm = res2.match(/success=(\w+) cycles=(\d+) replans=(\d+)/);
    const replanCalls = mine.filter(l => l.includes('[LLM-CALL]') && l.includes('component=GoalPlanner') && l.includes('phase=replan'));
    let fileOk = false; try { fileOk = !!scn.check(ws); } catch { fileOk = false; }
    return {
        arm: a.name, scenario: scn.id, rep, sid, http: res.status, finished, ms, route: goalId ? 'goal' : 'sem_goal(agentloop)',
        goalStatus: row?.status ?? null, goalSuccess: gm ? gm[1] === 'true' : null, cycles: gm ? +gm[2] : null, replans: gm ? +gm[3] : null,
        attempts: row ? JSON.parse(row.attempts || '[]').length : null, blockerKinds: row ? (JSON.parse(row.blockers || '[]')).map(b => b.kind) : [],
        replanLlmCalls: replanCalls.length, replanAborted: replanCalls.filter(l => l.includes('aborted=true')).length,
        replanFactsLines: mine.filter(l => l.includes('[REPLAN-FACTS]')).length, fileOk,
        ok: finished && fileOk && (row ? row.status === 'completed' : true),
    };
}

async function runArm(a, results) {
    for (const rep of Array.from({ length: REPS }, (_, i) => i + 1)) {
        for (const scn of SCENARIOS) {
            progress(`arm=${a.name} INÍCIO cenário=${scn.id} rep=${rep}`);
            let r;
            try { r = await runGoal(a, scn, rep); } catch (e) { r = { arm: a.name, scenario: scn.id, rep, erro: String(e).slice(0, 160), ok: false }; }
            results.push(r);
            fs.writeFileSync(path.join(ROOT, 'results.json'), JSON.stringify(results, null, 1));
            progress(`arm=${a.name} FIM cenário=${scn.id} rep=${rep} ok=${r.ok} status=${r.goalStatus} cycles=${r.cycles} replans=${r.replans} ms=${r.ms} replanAborted=${r.replanAborted}/${r.replanLlmCalls} factsLines=${r.replanFactsLines} fileOk=${r.fileOk}`);
        }
    }
}

(async () => {
    fs.mkdirSync(ROOT, { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'progress.log'), '');
    const results = [];
    try {
        for (const a of ARMS) setup(a);
        for (const a of ARMS) await boot(a);                       // sobe um por vez; depois rodam em paralelo
        await Promise.all(ARMS.map(a => runArm(a, results)));
        progress('TODOS OS BRAÇOS CONCLUÍDOS');
    } catch (e) {
        progress('ERRO FATAL: ' + String(e).slice(0, 300));
    } finally {
        for (const a of ARMS) if (a.pid) stop(a);
        await sleep(2000);
        for (const a of ARMS) progress(`encerrado arm=${a.name}; porta ${a.port} livre: ${!listenerPid(a.port)}`);
        progress('FIM');
    }
})();
