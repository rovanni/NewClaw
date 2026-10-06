/*
 * Issue 065 — o juiz de grounding pega erro de verdade ou bloqueia à toa?
 *
 * Lê o log de auditoria e lista, para cada julgamento real (não sombra) que BLOQUEOU a entrega (REJECTED,
 * NOT_EVALUABLE, UNVALIDATED), as afirmações reprovadas com a evidência que o juiz viu e o trecho da resposta.
 * Só monta o material: decidir "acerto" × "bloqueio à toa" é julgamento semântico — fica com quem revisa.
 *
 * O texto (resposta/evidência) só existe no log com TRACE_CONTENT=true. Sem ele, sai só a estrutura.
 *
 * Uso: node revisar_bloqueios_do_juiz.js <newclaw-audit.log> [AAAA-MM-DD]   (data = só julgamentos a partir dela)
 */
'use strict';
const fs = require('fs');

const [, , logPath, desde] = process.argv;
if (!logPath) { console.error('uso: node revisar_bloqueios_do_juiz.js <newclaw-audit.log> [AAAA-MM-DD]'); process.exit(1); }

const linhas = fs.readFileSync(logPath, 'utf8').replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/);
const BLOQUEIO = new Set(['REJECTED', 'NOT_EVALUABLE', 'UNVALIDATED']);
const total = { julgamentos: 0, bloqueios: 0, comTexto: 0, porEstado: {}, tempos: [] };
const casos = [];

for (const l of linhas) {
    const i = l.indexOf('[GROUNDING-TRACE] ');
    if (i < 0) continue;
    const data = l.slice(1, 20);
    if (desde && data < desde) continue;
    let j;
    try { j = JSON.parse(l.slice(i + 18)); } catch { continue; }
    if (!j.state || j.phase === 'shadow-model' || j.phase === 'shadow-extended' || j.phase === 'decision') continue;
    total.julgamentos++;
    total.porEstado[j.state] = (total.porEstado[j.state] || 0) + 1;
    if (typeof j.elapsedMs === 'number') total.tempos.push(j.elapsedMs);
    if (!BLOQUEIO.has(j.state)) continue;
    total.bloqueios++;
    if (j.responseText) total.comTexto++;
    casos.push({ data, j });
}

const t = total.tempos.sort((a, b) => a - b);
const mediana = t.length ? Math.round(t[Math.floor(t.length / 2)] / 1000) : 0;
console.log(`# Bloqueios do juiz de grounding${desde ? ` desde ${desde}` : ''}\n`);
console.log(`Julgamentos reais: ${total.julgamentos} · bloqueios: ${total.bloqueios} · mediana de tempo: ${mediana} s`);
console.log(`Por estado: ${Object.entries(total.porEstado).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
console.log(`Bloqueios com texto (TRACE_CONTENT): ${total.comTexto} de ${total.bloqueios}\n`);
console.log('Para cada caso: marque ACERTO (a resposta tinha mesmo um dado errado/sem base) ou À TOA (a resposta estava certa).\n');

casos.forEach(({ data, j }, n) => {
    console.log(`## ${n + 1}. ${data} — ${j.state} — ${Math.round((j.elapsedMs || 0) / 1000)} s — conversa ${j.conversationId || '?'}${j.goalId ? ` — goal ${j.goalId}` : ''}`);
    if (j.reason) console.log(`Motivo: ${j.reason}`);
    const reprovadas = (j.claims || []).filter(c => c.verdict !== 'SUPPORTED');
    for (const c of reprovadas) console.log(`- **${c.verdict}** — "${c.claim}" (evidência citada: ${(c.evidence || []).join(', ') || 'nenhuma'})`);
    if (j.evidenceSent) for (const e of j.evidenceSent) console.log(`  - ${e.id} [${e.tool}] ${String(e.output).replace(/\s+/g, ' ').slice(0, 400)}`);
    if (j.responseText) console.log(`  - Resposta: ${String(j.responseText).replace(/\s+/g, ' ').slice(0, 600)}`);
    console.log('- Revisão: [ ] ACERTO  [ ] À TOA\n');
});
