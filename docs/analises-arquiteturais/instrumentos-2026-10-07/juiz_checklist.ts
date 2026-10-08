/* Experimento do checklist do juiz de grounding (07/10/2026) — ver docs/decisoes/ADR-013_RESPONSABILIDADES_DE_VERIFICACAO_DA_RESPOSTA.md.
 * Compara, no MESMO modelo, o juiz de produção (ObserverValidator.validateGrounding) com um protótipo
 * em CHECKLIST: o LLM lista até 8 dados atribuídos a ferramenta/arquivo e COPIA o trecho literal da
 * evidência; o CÓDIGO confere se o trecho existe na evidência (determinismo valida / LLM interpreta).
 *
 * Casos: os 19 sintéticos da issue 065 (curtos, realistas e armadilhas) + casos reais de produção,
 * lidos de um JSON externo (CASOS_REAIS) — os reais contêm dado do usuário e NÃO entram no repositório.
 * Uso (na raiz): EXP_ENV=<.env com OLLAMA_URL/OLLAMA_API_KEY> EXPM=<modelo> ROTULO=<atual|checklist>
 *      [PENSAR=false] [CASOS_REAIS=<json>] [CASOS=id1,id2] npx ts-node docs/analises-arquiteturais/instrumentos-2026-10-07/juiz_checklist.ts
 * PENSAR=false: a chamada ao juiz vai direto ao Ollama com `think: false` (raciocínio desligado), mesmo prompt,
 * mesmo modelo e mesmo orçamento — o produto não tem essa opção; o intermediário existe só no experimento.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const ENV = process.env.EXP_ENV as string;
for (const line of fs.readFileSync(ENV, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
}
process.env.WORKSPACE_DIR = path.join(os.tmpdir(), 'newclaw-exp-checklist-workspace');

const SRC = path.resolve(__dirname, '../../../src');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ObserverValidator } = require(`${SRC}/loop/ObserverValidator`);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ProviderFactory } = require(`${SRC}/core/ProviderFactory`);

// ── Casos sintéticos (cópia literal de instrumentos-2026-10-06/juiz_escopo.ts) ──
type Ev = { id: string; tool: string; input?: string; output: string };
type Case = { id: string; expect: 'clean' | 'problem' | 'ambiguo'; tipo: string; evidences: Ev[]; response: string };

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

// Rótulos dos casos reais, conferidos à mão contra os arquivos do workspace (ver a ADR, §2).
const ROTULOS_REAIS: Record<string, Case['expect']> = {
    'real-10062304-ini': 'problem',  // "questão de turnaround médio" e "formação geral" — ausentes do arquivo
    'real-10062306-par': 'clean',
    'real-10062310-ini': 'ambiguo',  // "contempla Máquina de Turing" — o arquivo trata de Turing; a evidência era um resumo
    'real-10062311-par': 'clean',
    'real-10070716-ini': 'clean',
    'real-10070720-ini': 'problem',  // "gabaritos reunidos no final" — o gabarito vem após cada questão
    'real-10070721-par': 'clean',
    'real-10071259-ini': 'clean',
    'real-10071928-ini': 'problem',  // "24 questões", "S12–S19" — o arquivo tem 23, até S18
};

// ── Protótipo: juiz em checklist ─────────────────────────────────────────────
const CHECKLIST_PROMPT = `Você confere, com um checklist, os DADOS que uma RESPOSTA atribui a ferramentas. Não avalie mais nada.

EVIDÊNCIAS (saídas de ferramentas):
{evidences}

RESPOSTA:
"""
{response}
"""

PASSO 1 — Liste no máximo 8 itens da resposta que sejam DADO OBTIDO de uma ferramenta ou de um arquivo:
  • valor, número, contagem, nome, data ou estado informado por uma ferramenta (preço, temperatura,
    quantidade de slides, nomes de arquivos, variação percentual...);
  • afirmação sobre o CONTEÚDO de um arquivo (o que ele contém, quantos itens tem, quais itens, onde fica uma seção).
  Priorize números, nomes e afirmações sobre o conteúdo de arquivos.
  NÃO liste: explicação, ensino, conhecimento geral, opinião, recomendação, cortesia; o que veio do pedido
  do usuário; o mero fato de o assistente ter feito, salvo ou enviado algo (o sistema confere isso sozinho).
  Mas números, nomes e conteúdos citados dentro dessas frases SÃO dados — liste-os.

PASSO 2 — Para cada item, copie da evidência o TRECHO LITERAL (até 200 caracteres, exatamente como está
escrito lá) que decide o item, e marque "confere":
  • "sim": o trecho confirma o item (igual, ou por arredondamento, conversão de unidade ou conta simples);
  • "nao": o trecho mostra que o item é falso (outro valor, ou a evidência lista tudo e o item não está lá);
  • "sem_evidencia": nenhuma evidência decide o item (deixe "trecho" vazio).

Responda APENAS com JSON:
{"itens":[{"dado":"...","evidencia":"E1","trecho":"...","confere":"sim|nao|sem_evidencia"}]}`;

type Item = { dado: string; evidencia?: string; trecho?: string; confere: string; citacaoConfere?: boolean };
const norm = (s: string): string => s.replace(/\*\*|`/g, '').replace(/[“”"']/g, '"').replace(/\s+/g, ' ').trim().toLowerCase();

/** Determinismo valida: o trecho citado existe LITERALMENTE na evidência? (fragmentos separados por "…" conferidos um a um) */
function citacaoExiste(trecho: string, evidencias: Ev[]): boolean {
    const alvo = norm(evidencias.map(e => `${e.input ?? ''}\n${e.output}`).join('\n'));
    const partes = trecho.split(/…|\.\.\./).map(norm).filter(p => p.length >= 4);
    return partes.length > 0 && partes.every(p => alvo.includes(p));
}

async function juizChecklist(pf: any, model: string, response: string, evidences: Ev[]): Promise<{ state: string; itens: Item[]; erro?: string }> {
    const bloco = evidences.map(e => `[${e.id}] ferramenta=${e.tool}${e.input ? ` args=${e.input}` : ''}\n${e.output}`).join('\n\n');
    const prompt = CHECKLIST_PROMPT.replace('{evidences}', () => bloco).replace('{response}', () => response);
    const orc = pf.getBudgetAuxiliar('validacao');
    const r = await pf.chatWithFallback([{ role: 'user', content: prompt }], undefined, undefined, orc.timeoutMs, undefined, model,
        { reasoningIntensive: true, diag: { component: 'ExperimentoChecklist', role: 'observer', phase: 'grounding' } });
    if (r.status !== 'success') return { state: 'UNVALIDATED', itens: [], erro: r.status };
    const m = String(r.content || '').match(/\{[\s\S]*\}/);
    let itens: Item[];
    try { itens = JSON.parse(m ? m[0] : '').itens; } catch { return { state: 'UNVALIDATED', itens: [], erro: 'json' }; }
    if (!Array.isArray(itens)) return { state: 'UNVALIDATED', itens: [], erro: 'estrutura' };
    for (const it of itens) {
        if (it.confere === 'sim' || it.confere === 'nao') {
            it.citacaoConfere = citacaoExiste(String(it.trecho ?? ''), evidences);
            if (!it.citacaoConfere) it.confere = 'sem_evidencia';   // citação que não está na evidência não decide nada
        }
    }
    const state = itens.length === 0 ? 'NOT_APPLICABLE'
        : itens.some(i => i.confere === 'nao') ? 'REJECTED'
        : itens.some(i => i.confere !== 'sim') ? 'NOT_EVALUABLE' : 'VALIDATED';
    return { state, itens };
}

/** Intermediário do experimento: mesma interface que o juiz usa, chamada direta ao Ollama com `think: false`. */
function semRaciocinio(real: any, model: string): any {
    return {
        getBudgetAuxiliar: (perfil: string) => real.getBudgetAuxiliar(perfil),
        chatWithFallback: async (messages: Array<{ role: string; content: string }>, _t: unknown, _p: unknown, timeoutMs: number) => {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), timeoutMs);
            try {
                const r = await fetch(`${process.env.OLLAMA_URL || 'http://localhost:11434'}/api/chat`, {
                    method: 'POST', signal: ctrl.signal,
                    headers: { 'Content-Type': 'application/json', ...(process.env.OLLAMA_API_KEY ? { Authorization: `Bearer ${process.env.OLLAMA_API_KEY}` } : {}) },
                    body: JSON.stringify({ model, messages, stream: false, think: false }),
                }).then(x => x.json()) as { message?: { content?: string }; error?: string };
                if (r.error) return { status: 'error', content: '', attempts: [{ errorMessage: r.error }] };
                return { status: 'success', content: r.message?.content ?? '', attempts: [] };
            } catch (e) {
                return { status: ctrl.signal.aborted ? 'timeout' : 'error', content: '', attempts: [{ errorMessage: String(e) }] };
            } finally { clearTimeout(timer); }
        },
    };
}

async function main(): Promise<void> {
    const model = process.env.EXPM as string;
    const rotulo = process.env.ROTULO as 'atual' | 'checklist';
    const pfReal = new ProviderFactory({ ollamaUrl: process.env.OLLAMA_URL, ollamaModel: process.env.OLLAMA_MODEL, ollamaApiKey: process.env.OLLAMA_API_KEY, defaultProvider: process.env.DEFAULT_PROVIDER || 'ollama' });
    const pensar = process.env.PENSAR !== 'false';
    const pf = pensar ? pfReal : semRaciocinio(pfReal, model);
    const v = new ObserverValidator(pf, model);
    const reais = process.env.CASOS_REAIS ? JSON.parse(fs.readFileSync(process.env.CASOS_REAIS, 'utf8')) : [];
    const todos: Case[] = [
        ...CASES,
        ...reais.map((c: { id: string; evidences: Ev[]; response: string }) => ({ id: c.id, tipo: 'real', expect: ROTULOS_REAIS[c.id] ?? 'ambiguo', evidences: c.evidences, response: c.response })),
    ];
    const only = process.env.CASOS ? new Set(process.env.CASOS.split(',')) : null;
    for (const c of todos) {
        if (only && !only.has(c.id)) continue;
        const t0 = Date.now();
        let state: string;
        let detalhe: unknown;
        if (rotulo === 'atual') {
            const r = await v.validateGrounding(c.response, c.evidences, undefined, { phase: 'initial' });
            state = r.state;
            detalhe = { n: (r.claims || []).length, motivo: r.state === 'UNVALIDATED' ? r.reason : undefined, naoSup: (r.claims || []).filter((x: { verdict: string }) => x.verdict !== 'SUPPORTED').map((x: { verdict: string; claim: string }) => `${x.verdict}: ${x.claim.slice(0, 90)}`) };
        } else {
            const r = await juizChecklist(pf, model, c.response, c.evidences);
            state = r.state;
            detalhe = { n: r.itens.length, citacoesInvalidas: r.itens.filter(i => i.citacaoConfere === false).length, erro: r.erro,
                naoSim: r.itens.filter(i => i.confere !== 'sim').map(i => `${i.confere}: ${String(i.dado).slice(0, 90)}`) };
        }
        const ms = Date.now() - t0;
        const bloqueia = state === 'REJECTED' || state === 'NOT_EVALUABLE' || state === 'UNVALIDATED';
        const correto = c.expect === 'ambiguo' ? null : state === 'UNVALIDATED' ? false : (c.expect === 'clean' ? !bloqueia : bloqueia);
        console.log(JSON.stringify({ rotulo: pensar ? rotulo : `${rotulo}_sem_raciocinio`, model, id: c.id, tipo: c.tipo, esperado: c.expect, estado: state, correto, ms, detalhe }));
    }
}
main().then(() => process.exit(0)).catch(e => { console.error('ERRO', e); process.exit(1); });
