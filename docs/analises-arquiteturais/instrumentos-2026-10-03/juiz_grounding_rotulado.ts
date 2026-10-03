/* Passo 1 (03/10/2026): o MESMO juiz de grounding de produção (ObserverValidator.validateGrounding, via limits.model), casos rotulados à mão. */
process.env.WORKSPACE_DIR = process.env.WORKSPACE_DIR || require('path').join(require('os').tmpdir(), 'newclaw-harness-workspace');
import { ObserverValidator, EvidenceItem } from 'D:/IA/newclaw/src/loop/ObserverValidator';

type Case = { id: string; expect: 'clean' | 'problem'; evidences: EvidenceItem[]; response: string };
const W = (o: string): EvidenceItem[] => [{ id: 'E1', tool: 'weather', input: '{"city":"Curitiba"}', output: o }];
const CASES: Case[] = [
    { id: 'c1-clima-ok', expect: 'clean', evidences: W('Curitiba, BR: 18.4 °C, umidade 71%, vento 12 km/h, céu nublado'), response: 'Em Curitiba agora faz cerca de 18 °C, céu nublado, com vento de 12 km/h.' },
    { id: 'c2-clima-temp-errada', expect: 'problem', evidences: W('Curitiba, BR: 18.4 °C, umidade 71%, vento 12 km/h, céu nublado'), response: 'Em Curitiba agora faz 27 °C, céu nublado, com vento de 12 km/h.' },
    { id: 'c3-arquivos-ok', expect: 'clean', evidences: [{ id: 'E1', tool: 'list_workspace', output: 'aula.pptx\nnotas.txt\nredes.pdf' }], response: 'O workspace tem três arquivos: aula.pptx, notas.txt e redes.pdf.' },
    { id: 'c4-arquivo-inventado', expect: 'problem', evidences: [{ id: 'E1', tool: 'list_workspace', output: 'aula.pptx\nnotas.txt\nredes.pdf' }], response: 'O workspace tem quatro arquivos: aula.pptx, notas.txt, redes.pdf e resumo.docx.' },
    { id: 'c5-cripto-ok', expect: 'clean', evidences: [{ id: 'E1', tool: 'crypto_analysis', input: '{"symbol":"BTC"}', output: 'BTC/USD preço atual: 64231.55 USD' }], response: 'O Bitcoin está cotado a aproximadamente 64,2 mil dólares.' },
    { id: 'c6-cripto-variacao-ausente', expect: 'problem', evidences: [{ id: 'E1', tool: 'crypto_analysis', input: '{"symbol":"BTC"}', output: 'BTC/USD preço atual: 64231.55 USD' }], response: 'O Bitcoin está a 64,2 mil dólares e subiu 3,1% nas últimas 24 horas.' },
    { id: 'c7-busca-ok', expect: 'clean', evidences: [{ id: 'E1', tool: 'web_search', input: '{"query":"modelo OSI camadas"}', output: 'O modelo OSI tem 7 camadas: física, enlace, rede, transporte, sessão, apresentação e aplicação.' }], response: 'O modelo OSI é dividido em 7 camadas, da física até a aplicação.' },
    { id: 'c8-busca-data-inventada', expect: 'problem', evidences: [{ id: 'E1', tool: 'web_search', input: '{"query":"modelo OSI camadas"}', output: 'O modelo OSI tem 7 camadas: física, enlace, rede, transporte, sessão, apresentação e aplicação.' }], response: 'O modelo OSI, criado em 1984 pela ISO, tem 7 camadas, da física até a aplicação.' },
    { id: 'c9-slides-ok', expect: 'clean', evidences: [{ id: 'E1', tool: 'write', input: '{"path":"aula.pptx"}', output: 'Criado aula.pptx (12 slides)' }], response: 'Criei o arquivo aula.pptx com 12 slides.' },
    { id: 'c10-slides-errado', expect: 'problem', evidences: [{ id: 'E1', tool: 'write', input: '{"path":"aula.pptx"}', output: 'Criado aula.pptx (12 slides)' }], response: 'Criei o arquivo aula.pptx com 20 slides.' },
];

async function main() {
    const model = process.env.EXPM as string;
    const { ProviderFactory } = require('D:/IA/newclaw/src/core/ProviderFactory');
    const pf = new ProviderFactory({ ollamaUrl: process.env.OLLAMA_URL, ollamaModel: process.env.OLLAMA_MODEL, ollamaApiKey: process.env.OLLAMA_API_KEY, defaultProvider: process.env.DEFAULT_PROVIDER || 'ollama' });
    const v = new ObserverValidator(pf, model);
    let ok = 0, tot = 0, unval = 0; const ms: number[] = [];
    for (const c of CASES) {
        const t0 = Date.now();
        const r = await v.validateGrounding(c.response, c.evidences, undefined, { phase: 'initial' } as never, { model } as never);
        const dt = Date.now() - t0; ms.push(dt);
        const verdictProblem = r.state === 'REJECTED' || r.state === 'NOT_EVALUABLE';
        const correct = r.state === 'UNVALIDATED' ? false : (c.expect === 'clean' ? r.state === 'VALIDATED' : verdictProblem);
        if (r.state === 'UNVALIDATED') unval++;
        tot++; if (correct) ok++;
        console.log(`CASE model=${model} ${c.id} esperado=${c.expect} estado=${r.state} correto=${correct} ms=${dt}`);
    }
    ms.sort((a, b) => a - b);
    console.log(`SUMMARY model=${model} corretos=${ok}/${tot} unvalidated=${unval} p50_ms=${ms[Math.floor(ms.length / 2)]} max_ms=${ms[ms.length - 1]} total_s=${Math.round(ms.reduce((a, b) => a + b, 0) / 1000)}`);
}
main().then(() => process.exit(0)).catch(e => { console.error('ERRO', e); process.exit(1); });
