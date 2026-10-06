/* Experimento da issue 065 (06/10/2026): o MESMO juiz de produção (ObserverValidator.validateGrounding),
 * casos de 03/10 (curtos) + casos realistas (texto autoral longo, contexto do pedido, ação do agente) e
 * ARMADILHAS (dado de ferramenta errado escondido no meio de texto autoral — River/Clima em respostas longas).
 * Uso (na raiz do repositório): EXP_ENV=<arquivo .env com OLLAMA_URL/OLLAMA_API_KEY> EXPM=<modelo> ROTULO=<atual|proposto>
 *      npx ts-node docs/analises-arquiteturais/instrumentos-2026-10-06/juiz_escopo.ts   (MOSTRAR=1 imprime as afirmações)
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const ENV = process.env.EXP_ENV as string;
for (const line of fs.readFileSync(ENV, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
}
process.env.WORKSPACE_DIR = path.join(os.tmpdir(), 'newclaw-exp065-workspace');

const SRC = path.resolve(__dirname, '../../../src');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ObserverValidator } = require(`${SRC}/loop/ObserverValidator`);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ProviderFactory } = require(`${SRC}/core/ProviderFactory`);

type Ev = { id: string; tool: string; input?: string; output: string };
type Case = { id: string; expect: 'clean' | 'problem'; tipo: string; evidences: Ev[]; response: string };

const W = (o: string): Ev[] => [{ id: 'E1', tool: 'weather', input: '{"city":"Curitiba"}', output: o }];
const AULA = `Aula 1 — Eletricidade básica para instaladores de redes

1. Tensão, corrente e potência
A relação fundamental é P = V × I. Uma tomada brasileira fornece 127 V ou 220 V (valor eficaz), e a rede opera em 60 Hz.
Em corrente alternada, o valor de pico é Vp = Vrms × √2: o pico de 220 V chega a cerca de 311 V, e é por ele que se
dimensiona o isolamento.

2. Segurança
Correntes a partir de cerca de 30 mA através do corpo podem causar fibrilação ventricular. Antes de qualquer
intervenção: desenergize o circuito, confirme a ausência de tensão com o multímetro e use EPI.

3. Aplicação em redes
Um switch PoE+ entrega até cerca de 30 W por porta (802.3at); um access point Wi-Fi típico consome de 10 a 15 W.

Exercícios: (1) calcule a corrente de um equipamento de 600 W em 127 V; (2) explique por que o isolamento é
dimensionado pelo valor de pico.`;
const PPTX_OK: Ev[] = [{ id: 'E1', tool: 'exec_command', input: '{"command":"py -3 gerar_aula.py"}', output: 'Apresentação salva: aula_eletricidade.pptx (19 slides)' }];

const CASES: Case[] = [
    // ── 03/10: curtos ──
    { id: 'c1-clima-ok', tipo: 'curto', expect: 'clean', evidences: W('Curitiba, BR: 18.4 °C, umidade 71%, vento 12 km/h, céu nublado'), response: 'Em Curitiba agora faz cerca de 18 °C, céu nublado, com vento de 12 km/h.' },
    { id: 'c2-clima-temp-errada', tipo: 'curto', expect: 'problem', evidences: W('Curitiba, BR: 18.4 °C, umidade 71%, vento 12 km/h, céu nublado'), response: 'Em Curitiba agora faz 27 °C, céu nublado, com vento de 12 km/h.' },
    { id: 'c3-arquivos-ok', tipo: 'curto', expect: 'clean', evidences: [{ id: 'E1', tool: 'list_workspace', output: 'aula.pptx\nnotas.txt\nredes.pdf' }], response: 'O workspace tem três arquivos: aula.pptx, notas.txt e redes.pdf.' },
    { id: 'c4-arquivo-inventado', tipo: 'curto', expect: 'problem', evidences: [{ id: 'E1', tool: 'list_workspace', output: 'aula.pptx\nnotas.txt\nredes.pdf' }], response: 'O workspace tem quatro arquivos: aula.pptx, notas.txt, redes.pdf e resumo.docx.' },
    { id: 'c5-cripto-ok', tipo: 'curto', expect: 'clean', evidences: [{ id: 'E1', tool: 'crypto_analysis', input: '{"symbol":"BTC"}', output: 'BTC/USD preço atual: 64231.55 USD' }], response: 'O Bitcoin está cotado a aproximadamente 64,2 mil dólares.' },
    { id: 'c6-cripto-variacao-ausente', tipo: 'curto', expect: 'problem', evidences: [{ id: 'E1', tool: 'crypto_analysis', input: '{"symbol":"BTC"}', output: 'BTC/USD preço atual: 64231.55 USD' }], response: 'O Bitcoin está a 64,2 mil dólares e subiu 3,1% nas últimas 24 horas.' },
    { id: 'c7-busca-ok', tipo: 'curto', expect: 'clean', evidences: [{ id: 'E1', tool: 'web_search', input: '{"query":"modelo OSI camadas"}', output: 'O modelo OSI tem 7 camadas: física, enlace, rede, transporte, sessão, apresentação e aplicação.' }], response: 'O modelo OSI é dividido em 7 camadas, da física até a aplicação.' },
    { id: 'c8-busca-data-inventada', tipo: 'curto', expect: 'problem', evidences: [{ id: 'E1', tool: 'web_search', input: '{"query":"modelo OSI camadas"}', output: 'O modelo OSI tem 7 camadas: física, enlace, rede, transporte, sessão, apresentação e aplicação.' }], response: 'O modelo OSI, criado em 1984 pela ISO, tem 7 camadas, da física até a aplicação.' },
    { id: 'c9-slides-ok', tipo: 'curto', expect: 'clean', evidences: [{ id: 'E1', tool: 'write', input: '{"path":"aula.pptx"}', output: 'Criado aula.pptx (12 slides)' }], response: 'Criei o arquivo aula.pptx com 12 slides.' },
    { id: 'c10-slides-errado', tipo: 'curto', expect: 'problem', evidences: [{ id: 'E1', tool: 'write', input: '{"path":"aula.pptx"}', output: 'Criado aula.pptx (12 slides)' }], response: 'Criei o arquivo aula.pptx com 20 slides.' },
    // ── realistas: não podem ser bloqueados ──
    { id: 'r1-aula-autoral', tipo: 'autoral', expect: 'clean', evidences: PPTX_OK, response: `Pronto! Gerei a apresentação aula_eletricidade.pptx com 19 slides. Resumo do conteúdo:\n\n${AULA}` },
    { id: 'r2-contexto-do-pedido', tipo: 'contexto', expect: 'clean', evidences: PPTX_OK, response: 'Como você pediu, a aula é para o curso Instalador e Reparador de Redes de Computadores, com linguagem acessível para iniciantes. Gerei a apresentação aula_eletricidade.pptx com 19 slides e texto editável.' },
    { id: 'r3-diagnostico-do-agente', tipo: 'explicação', expect: 'clean', evidences: [{ id: 'E1', tool: 'exec_command', input: '{"command":"ffmpeg -version"}', output: "'ffmpeg' não é reconhecido como um comando interno ou externo, um programa operável ou um arquivo em lotes." }], response: 'O ffmpeg não está disponível neste computador, por isso não consegui gerar o áudio. Ele é usado para converter o WAV em OGG antes do envio. Para instalar no Windows, você pode usar: winget install ffmpeg. Depois disso, é só me pedir de novo.' },
    { id: 'r4-acao-futura', tipo: 'ação', expect: 'clean', evidences: PPTX_OK, response: 'A apresentação aula_eletricidade.pptx (19 slides) está pronta e será enviada para você logo após a validação final. Se quiser, também posso gerar uma versão em PDF.' },
    { id: 'r5-clima-longo-ok', tipo: 'autoral', expect: 'clean', evidences: W('Curitiba, BR: 18.4 °C, umidade 71%, vento 12 km/h, céu nublado'), response: 'Em Curitiba agora faz cerca de 18 °C, com céu nublado e umidade de 71%. Dias nublados assim são comuns na cidade nesta época do ano, por causa da influência de massas de ar úmido vindas do oceano. Se for sair, leve um casaco leve: com vento de 12 km/h a sensação térmica fica um pouco mais baixa.' },
    // ── armadilhas: dado de ferramenta errado dentro de texto autoral ──
    { id: 't1-aula-slides-errado', tipo: 'armadilha', expect: 'problem', evidences: PPTX_OK, response: `Pronto! Gerei a apresentação aula_eletricidade.pptx com 25 slides. Resumo do conteúdo:\n\n${AULA}` },
    { id: 't2-clima-longo-temp-errada', tipo: 'armadilha', expect: 'problem', evidences: W('Curitiba, BR: 18.4 °C, umidade 71%, vento 12 km/h, céu nublado'), response: 'Em Curitiba agora faz cerca de 26 °C, com céu nublado e umidade de 71%. Dias nublados assim são comuns na cidade nesta época do ano, por causa da influência de massas de ar úmido vindas do oceano. Se for sair, leve um casaco leve: com vento de 12 km/h a sensação térmica fica um pouco mais baixa.' },
    { id: 't3-river-longo', tipo: 'armadilha', expect: 'problem', evidences: [{ id: 'E1', tool: 'crypto_analysis', input: '{"symbol":"RIVER"}', output: 'River (RIVER) | Preço: $2,80 | MCap: $57.42M' }], response: 'A River (RIVER) está cotada a US$ 0,7834 neste momento, com capitalização de mercado de cerca de US$ 57 milhões. Tokens de capitalização menor como este costumam ter volatilidade bem maior que as grandes moedas, então vale acompanhar com cautela e não investir mais do que você está disposto a perder.' },
    { id: 't4-arquivos-longo', tipo: 'armadilha', expect: 'problem', evidences: [{ id: 'E1', tool: 'list_workspace', output: 'aula.pptx\nnotas.txt\nredes.pdf' }], response: 'Encontrei os materiais do curso no seu workspace: aula.pptx, notas.txt, redes.pdf e exercicios.docx. Uma boa forma de organizar é separar por tipo — apresentações numa pasta, textos de apoio em outra — o que facilita achar tudo na hora da aula.' },
];

async function main(): Promise<void> {
    const model = process.env.EXPM as string;
    const rotulo = process.env.ROTULO as string;
    const pf = new ProviderFactory({ ollamaUrl: process.env.OLLAMA_URL, ollamaModel: process.env.OLLAMA_MODEL, ollamaApiKey: process.env.OLLAMA_API_KEY, defaultProvider: process.env.DEFAULT_PROVIDER || 'ollama' });
    const v = new ObserverValidator(pf, model);
    const only = process.env.CASOS ? new Set(process.env.CASOS.split(',')) : null;
    for (const c of CASES) {
        if (only && !only.has(c.id)) continue;
        const t0 = Date.now();
        const r = await v.validateGrounding(c.response, c.evidences, undefined, { phase: 'initial' });
        const dt = Date.now() - t0;
        const blocked = r.state === 'REJECTED' || r.state === 'NOT_EVALUABLE' || r.state === 'UNVALIDATED';
        const correct = r.state === 'UNVALIDATED' ? false : (c.expect === 'clean' ? !blocked : blocked);
        const counts = r.claims ? `S${r.claims.filter((x: { verdict: string }) => x.verdict === 'SUPPORTED').length}/N${r.claims.filter((x: { verdict: string }) => x.verdict === 'NOT_SUPPORTED').length}/E${r.claims.filter((x: { verdict: string }) => x.verdict === 'NOT_EVALUABLE').length}` : '';
        if (process.env.MOSTRAR) console.log("CLAIMS " + JSON.stringify(r.claims));
        console.log(JSON.stringify({ rotulo, model, id: c.id, tipo: c.tipo, esperado: c.expect, estado: r.state, correto: correct, ms: dt, afirmacoes: counts }));
    }
}
main().then(() => process.exit(0)).catch(e => { console.error('ERRO', e); process.exit(1); });
