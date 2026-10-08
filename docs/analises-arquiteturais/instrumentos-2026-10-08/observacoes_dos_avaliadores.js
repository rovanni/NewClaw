/* Relatório das observações "faltou" dos avaliadores (Sprint C, 08/10/2026).
 *
 * Lê o gravador de voo (<pasta do LOG_FILE>/avaliadores/*.jsonl) e mostra, por avaliador, quantos julgamentos houve,
 * em quantos o modelo disse que faltou informação, e as observações agrupadas (texto idêntico) da mais repetida para
 * a menos. O texto só existe com TRACE_CONTENT=true; sem ele, aparece apenas a contagem (faltouInformado).
 *
 * Uso: node docs/analises-arquiteturais/instrumentos-2026-10-08/observacoes_dos_avaliadores.js <pasta avaliadores> [dias]
 * Ex.: node .../observacoes_dos_avaliadores.js C:/caminho/do/NewClaw/logs/avaliadores 7
 */
const fs = require('fs');
const path = require('path');

const pasta = process.argv[2];
const dias = Number(process.argv[3] || 7);
if (!pasta || !fs.existsSync(pasta)) {
    console.error('Informe a pasta logs/avaliadores do NewClaw.');
    process.exit(1);
}
const limite = Date.now() - dias * 86_400_000;
const porAvaliador = {};

for (const nome of fs.readdirSync(pasta).filter(n => n.endsWith('.jsonl'))) {
    for (const linha of fs.readFileSync(path.join(pasta, nome), 'utf8').split('\n')) {
        if (!linha.trim()) continue;
        let r;
        try { r = JSON.parse(linha); } catch { continue; }
        if (r.tipo !== 'avaliacao' || new Date(r.ts).getTime() < limite) continue;
        const a = (porAvaliador[r.avaliador] ??= { total: 0, comFaltou: 0, textos: new Map() });
        a.total++;
        if (r.depois?.fatos?.faltouInformado) {
            a.comFaltou++;
            const t = r.depois?.conteudo?.faltou;
            if (t) a.textos.set(t, (a.textos.get(t) ?? 0) + 1);
        }
    }
}

console.log(`Observações "faltou" dos avaliadores — últimos ${dias} dias\n`);
for (const [avaliador, a] of Object.entries(porAvaliador)) {
    const pct = a.total ? Math.round((a.comFaltou / a.total) * 100) : 0;
    console.log(`■ ${avaliador}: ${a.total} julgamentos, ${a.comFaltou} com "faltou" (${pct}%)`);
    for (const [texto, n] of [...a.textos.entries()].sort((x, y) => y[1] - x[1]).slice(0, 20)) {
        console.log(`   ${String(n).padStart(3)}×  ${texto}`);
    }
    if (a.comFaltou && !a.textos.size) console.log('   (texto não gravado — ligue TRACE_CONTENT=true para ver o que faltou)');
    console.log('');
}
if (!Object.keys(porAvaliador).length) console.log('Nenhum julgamento no período.');
