#!/usr/bin/env node
/*
 * Comparação ANTES × DEPOIS das correções de confiabilidade dos goals (issues 049–056), por período entre
 * deploys reais da produção. Somente leitura: abre o banco em modo readonly e lê o audit log em streaming.
 *
 * Uso (a partir da raiz do repositório):
 *   node docs/analises-arquiteturais/instrumentos-2026-10-05/comparar_antes_depois.js [C:/Users/lucia/NewClaw] [--desde 2026-09-01]
 *
 * Períodos: cada `pull` no `git reflog` da produção é um deploy; o período vai de um deploy ao seguinte.
 * Períodos sem nenhum goal são agrupados com o seguinte, para a tabela não virar uma lista de zeros.
 *
 * O que cada coluna mede (e qual correção ela observa):
 *   goals / ok / falha / aband.   desfecho dos goals criados no período (geral)
 *   txtGround                     tentativas agentloop cujo OUTPUT é a mensagem fixa do grounding (049 elimina)
 *   blkGround                     tentativas registradas como grounding_blocked:* (049 — o jeito novo)
 *   reexec                        steps agentloop concluídos com sucesso mais de uma vez na mesma geração (050)
 *   provOk                        tentativas 'success' cujo output é a frase de provedor indisponível (053 elimina)
 *   provFail                      tentativas provider_unavailable:* (053 — o jeito novo)
 *   julg / cortes / NE-corte      julgamentos de grounding, quantos com evidência cortada, afirmações NOT_EVALUABLE
 *                                 que citam evidência cortada (051)
 *   tool / ctx                    disparos de same_tool_limit / de trava de contexto (052)
 *   http429                       respostas HTTP 429 do provedor (contexto, não correção)
 *
 * Limites: o banco guarda attempts com output truncado; o log só tem [GROUNDING-TRACE] desde 26/09/2026;
 * métricas por período pequeno têm amostra pequena — ler junto da coluna "goals".
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { execSync } = require('child_process');

const prod = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'C:/Users/lucia/NewClaw';
const desdeArg = process.argv.indexOf('--desde');
const desde = desdeArg > 0 ? Date.parse(process.argv[desdeArg + 1] + 'T00:00:00-03:00') : Date.parse('2026-09-01T00:00:00-03:00');

const Database = require(path.join(__dirname, '../../../node_modules/better-sqlite3'));

const CANNED_GROUNDING = /^(Não consegui confirmar se a resposta|Não encontrei, nas fontes que consultei|A resposta que eu ia enviar continha uma afirmação)/;
const CANNED_PROVIDER = /^(Todos os providers estão temporariamente indisponíveis|Não foi possível obter resposta do provedor)/;

// ── Deploys (git reflog da produção) ────────────────────────────────────────────────────────────
function deploys() {
    const out = execSync(`git -C "${prod}" reflog --date=iso`, { encoding: 'utf8' });
    const list = [];
    for (const line of out.split('\n')) {
        const m = line.match(/^([0-9a-f]+) HEAD@\{(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{4})\}: pull/);
        if (m) list.push({ sha: m[1], at: Date.parse(m[2].replace(' ', 'T').replace(/ ([+-]\d{2})(\d{2})$/, '$1:$2')) });
    }
    return list.sort((a, b) => a.at - b.at);
}

// ── Banco: goals e tentativas ───────────────────────────────────────────────────────────────────
function fromDb() {
    const db = new Database(path.join(prod, 'data/newclaw.db'), { readonly: true, fileMustExist: true });
    const goals = db.prepare('select id, status, created_at, attempts from goals where created_at >= ?').all(desde);
    return goals.map(g => {
        let attempts = [];
        try { attempts = JSON.parse(g.attempts || '[]'); } catch { /* attempt ilegível conta como vazio */ }
        const agent = attempts.filter(a => a.toolName === 'agentloop');
        const okPorStep = {};
        for (const a of agent) if (a.result === 'success') { const k = `${a.planStepId}/${a.planGeneration ?? 0}`; okPorStep[k] = (okPorStep[k] || 0) + 1; }
        return {
            at: g.created_at, status: g.status,
            txtGround: agent.filter(a => CANNED_GROUNDING.test((a.output || '').trim())).length,
            blkGround: attempts.filter(a => String(a.error || '').startsWith('grounding_blocked:')).length,
            reexec: Object.values(okPorStep).filter(n => n > 1).length,
            provOk: agent.filter(a => a.result !== 'failure' && CANNED_PROVIDER.test((a.output || '').trim())).length,
            provFail: attempts.filter(a => String(a.error || '').startsWith('provider_unavailable:')).length,
        };
    });
}

// ── Log: grounding, travas, 429 ─────────────────────────────────────────────────────────────────
async function fromLog() {
    const events = [];
    const rl = readline.createInterface({ input: fs.createReadStream(path.join(prod, 'logs/newclaw-audit.log'), { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const raw of rl) {
        const line = raw.replace(/\x1b\[[0-9;]*m/g, '');
        const m = line.match(/^\[(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})\]/);
        if (!m) continue;
        const at = Date.parse(`${m[1]}T${m[2]}-03:00`);
        if (at < desde) continue;
        if (line.includes('[GROUNDING-TRACE] {') && /"phase":"(initial|partial-revalidation)"/.test(line) && line.includes('"evidences"')) {
            try {
                const j = JSON.parse(line.slice(line.indexOf('[GROUNDING-TRACE] ') + 18));
                const cut = new Set((j.evidences || []).filter(e => e.truncated).map(e => e.id));
                const neCut = (j.claims || []).filter(c => c.verdict === 'NOT_EVALUABLE' && (c.evidence || []).some(e => cut.has(e))).length;
                events.push({ at, kind: 'julg', cortes: cut.size > 0 ? 1 : 0, neCut });
            } catch { /* linha de trace truncada */ }
        } else if (line.includes('[SAFETY-GUARD]') && line.includes('reason=same_tool_limit')) {
            events.push({ at, kind: 'tool' });
        } else if (line.includes('[SAFETY-GUARD]') && line.includes('type=context_growth')) {
            events.push({ at, kind: 'ctx' });
        } else if (line.includes('HTTP 429')) {
            events.push({ at, kind: '429' });
        }
    }
    return events;
}

function fmt(at) { return new Date(at - 3 * 3600e3).toISOString().slice(0, 16).replace('T', ' '); }

(async () => {
    const dep = deploys().filter(d => d.at >= desde);
    const goals = fromDb();
    const events = await fromLog();
    const bounds = [desde, ...dep.map(d => d.at), Date.now() + 1];
    let rows = [];
    for (let i = 0; i < bounds.length - 1; i++) {
        const a = bounds[i], b = bounds[i + 1];
        const g = goals.filter(x => x.at >= a && x.at < b);
        const e = events.filter(x => x.at >= a && x.at < b);
        const sum = (arr, k) => arr.reduce((s, x) => s + (x[k] || 0), 0);
        rows.push({
            de: fmt(a), deploy: i === 0 ? '(início)' : dep[i - 1].sha,
            goals: g.length, ok: g.filter(x => x.status === 'completed').length,
            falha: g.filter(x => x.status === 'failed').length, aband: g.filter(x => x.status === 'abandoned').length,
            txtGround: sum(g, 'txtGround'), blkGround: sum(g, 'blkGround'), reexec: sum(g, 'reexec'),
            provOk: sum(g, 'provOk'), provFail: sum(g, 'provFail'),
            julg: e.filter(x => x.kind === 'julg').length, cortes: sum(e.filter(x => x.kind === 'julg'), 'cortes'),
            'NE-corte': sum(e.filter(x => x.kind === 'julg'), 'neCut'),
            tool: e.filter(x => x.kind === 'tool').length, ctx: e.filter(x => x.kind === 'ctx').length, http429: e.filter(x => x.kind === '429').length,
        });
    }
    // Agrupa períodos sem goals com o seguinte (mantém o deploy mais recente do grupo).
    const merged = [];
    for (const r of rows) {
        const prev = merged[merged.length - 1];
        if (prev && prev.goals === 0) {
            for (const k of Object.keys(r)) if (typeof r[k] === 'number') r[k] += prev[k];
            r.de = prev.de;
            merged[merged.length - 1] = r;
        } else merged.push(r);
    }
    const cols = Object.keys(merged[0] || {});
    console.log(`Produção: ${prod} | desde ${fmt(desde)} | deploys no período: ${dep.length}\n`);
    console.log(cols.join('\t'));
    for (const r of merged) console.log(cols.map(c => r[c]).join('\t'));
})().catch(err => { console.error(err); process.exitCode = 1; });
