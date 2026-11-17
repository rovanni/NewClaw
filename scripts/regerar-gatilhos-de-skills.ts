/**
 * ADR-040 (D2) — regenera os gatilhos das skills aprendidas por trajetória (ADR-017), que perderam as frases (`join(' ')`).
 *
 * Roda a partir da pasta da instalação do NewClaw (lê o `.env`, `data/newclaw.db` e a pasta de skills dela). Três modos:
 *
 *   --previa <arquivo.json>    chama o modelo do planejador (PLANNER_MODEL, o mesmo do aprendizado) uma vez por skill e grava
 *                              a prévia: gatilhos de antes e propostos. NÃO grava nada nas skills.
 *   --aplicar <arquivo.json>   grava os gatilhos de uma prévia revisada (banco + SKILL.md). Não chama modelo. Antes de gravar,
 *                              escreve `<arquivo>.reversao.json` com o campo e o SKILL.md de antes de cada skill.
 *   --reverter <reversao.json> devolve campo e SKILL.md ao que estava.
 *
 * Exemplo (PowerShell, na pasta da instalação; o `ts-node` lê o tsconfig do repositório):
 *   $env:TS_NODE_PROJECT="<repo>\tsconfig.json"; npx ts-node "<repo>\scripts\regerar-gatilhos-de-skills.ts" --previa previa.json
 */
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import Database from 'better-sqlite3';

dotenv.config({ path: path.resolve('.env') });

import { ProviderFactory, modelosNativosDoAmbiente } from '../src/core/ProviderFactory';
import { buildLanguageDirective } from '../src/core/agentControllerSetup';
import { SkillLearner } from '../src/loop/SkillLearner';
import { montarPedidoDeGatilhos, interpretarGatilhos } from '../src/loop/aprendizadoDeSkills';
import { frasesDoCampoDeGatilhos } from '../src/skills/SkillDiscovery';
import { pastaDaSkill } from '../src/shared/pastaDaSkill';

interface ItemDaPrevia { id: string; nome: string; antes: string[]; propostos: string[] | null; erro?: string }
interface ItemDaReversao { id: string; nome: string; campoAntes: string; skillMdAntes: string | null; arquivo: string }

function falhar(msg: string): never { console.error(`ERRO: ${msg}`); process.exit(1); }

const [modo, arquivo] = process.argv.slice(2);
if (!['--previa', '--aplicar', '--reverter'].includes(modo ?? '') || !arquivo) {
    falhar('uso: --previa <arquivo.json> | --aplicar <arquivo.json> | --reverter <reversao.json>');
}

const raiz = process.cwd();
const dbPath = path.join(raiz, 'data', 'newclaw.db');
if (!fs.existsSync(dbPath)) falhar(`não achei ${dbPath} — rode na pasta da instalação do NewClaw`);
const skillsDir = path.resolve(raiz, process.env.SKILLS_DIR || './skills');
const db = new Database(dbPath);
const learner = new SkillLearner(db, skillsDir);

/** O SKILL.md de uma skill, como o SkillLearner o nomeia (mesma regra da exportação). */
function arquivoDaSkill(s: { name: string; source_pattern?: string | null }): string {
    return path.join(skillsDir, pastaDaSkill(s.source_pattern ?? s.name), 'SKILL.md');
}

async function previa(): Promise<void> {
    const modelo = (process.env.PLANNER_MODEL || '').trim();
    if (!modelo) falhar('PLANNER_MODEL não está configurado nesta instalação — o aprendizado usa esse modelo; nada foi chamado');
    const factory = new ProviderFactory({
        geminiKey: process.env.GEMINI_API_KEY, deepseekKey: process.env.DEEPSEEK_API_KEY, groqKey: process.env.GROQ_API_KEY,
        openrouterKey: process.env.OPENROUTER_API_KEY, anthropicKey: process.env.ANTHROPIC_API_KEY,
        ollamaUrl: process.env.OLLAMA_URL || 'http://localhost:11434', ollamaModel: process.env.OLLAMA_MODEL || '',
        ollamaApiKey: process.env.OLLAMA_API_KEY || '', defaultProvider: process.env.DEFAULT_PROVIDER || '',
        customProviders: (() => { try { const v = JSON.parse(process.env.CUSTOM_PROVIDERS || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } })(),
        modelosNativos: modelosNativosDoAmbiente(),
    });
    const idioma = buildLanguageDirective(process.env.APP_LANG || 'pt-BR');
    const skills = learner.skillsAprendidasPorTrajetoria();
    console.log(`${skills.length} skill(s) aprendidas por trajetória; modelo: ${modelo}`);
    const itens: ItemDaPrevia[] = [];
    for (const s of skills) {
        const pedido = montarPedidoDeGatilhos({ nome: s.name, descricao: s.description, corpo: s.prompt }, idioma);
        const antes = frasesDoCampoDeGatilhos(s.trigger);
        try {
            const { timeoutMs } = factory.getBudgetAuxiliar('validacao', pedido.length);
            const r = await factory.chatWithFallback([{ role: 'user', content: pedido }], undefined, undefined, timeoutMs, undefined, modelo,
                { reasoningIntensive: true, diag: { component: 'SkillLearner', role: 'skill_writer', phase: 'regerar_gatilhos' } });
            if (r.status !== 'success' || !r.content) {
                itens.push({ id: s.id, nome: s.name, antes, propostos: null, erro: `modelo: ${r.status}` });
            } else {
                const g = interpretarGatilhos(r.content);
                itens.push('erro' in g ? { id: s.id, nome: s.name, antes, propostos: null, erro: g.erro } : { id: s.id, nome: s.name, antes, propostos: g.gatilhos });
            }
        } catch (e) {
            // Uma skill que falha não perde as respostas já pagas das outras: a prévia é gravada no fim, com o erro desta.
            itens.push({ id: s.id, nome: s.name, antes, propostos: null, erro: `exceção: ${e instanceof Error ? e.message : String(e)}` });
        }
        const ultimo = itens[itens.length - 1];
        console.log(`- ${s.name}\n    antes:     ${antes.join(' | ')}\n    propostos: ${ultimo.propostos?.join(' | ') ?? `(nenhum — ${ultimo.erro})`}`);
    }
    fs.writeFileSync(arquivo, JSON.stringify({ geradoEm: new Date().toISOString(), modelo, itens }, null, 2), 'utf8');
    console.log(`\nPrévia gravada em ${path.resolve(arquivo)}. Nada foi alterado nas skills.`);
}

function aplicar(): void {
    const { itens } = JSON.parse(fs.readFileSync(arquivo, 'utf8')) as { itens: ItemDaPrevia[] };
    const reversao: ItemDaReversao[] = [];
    const comProposta = itens.filter(i => i.propostos && i.propostos.length);
    for (const i of comProposta) {
        const s = db.prepare('SELECT * FROM auto_skills WHERE id = ?').get(i.id) as { id: string; name: string; trigger: string; source_pattern?: string } | undefined;
        if (!s) { console.log(`- ${i.nome}: não existe mais no banco — pulada`); continue; }
        const arq = arquivoDaSkill(s);
        reversao.push({ id: s.id, nome: s.name, campoAntes: s.trigger, skillMdAntes: fs.existsSync(arq) ? fs.readFileSync(arq, 'utf8') : null, arquivo: arq });
    }
    const arqReversao = `${arquivo}.reversao.json`;
    fs.writeFileSync(arqReversao, JSON.stringify({ geradoEm: new Date().toISOString(), itens: reversao }, null, 2), 'utf8');
    console.log(`Reversão gravada em ${path.resolve(arqReversao)} (antes de qualquer mudança).`);
    for (const i of comProposta) {
        if (!reversao.some(r => r.id === i.id)) continue;
        try {
            const anterior = learner.trocarGatilhos(i.id, i.propostos!);
            console.log(`- ${i.nome}: ${anterior === null ? 'não encontrada' : `gravada (${i.propostos!.join(' | ')})`}`);
        } catch (e) {
            // trocarGatilhos grava o arquivo antes do banco: se o arquivo falhou, nada desta skill mudou.
            console.log(`- ${i.nome}: NÃO gravada — ${e instanceof Error ? e.message : String(e)}`);
            process.exitCode = 1;
        }
    }
    const semProposta = itens.filter(i => !i.propostos || !i.propostos.length);
    if (semProposta.length) console.log(`Sem proposta (nada mudou): ${semProposta.map(i => `${i.nome} (${i.erro ?? 'vazia'})`).join(', ')}`);
}

function reverter(): void {
    const { itens } = JSON.parse(fs.readFileSync(arquivo, 'utf8')) as { itens: ItemDaReversao[] };
    for (const r of itens) {
        db.prepare('UPDATE auto_skills SET trigger = ?, updated_at = ? WHERE id = ?').run(r.campoAntes, new Date().toISOString(), r.id);
        if (r.skillMdAntes !== null) fs.writeFileSync(r.arquivo, r.skillMdAntes, 'utf8');
        console.log(`- ${r.nome}: revertida`);
    }
}

(async () => {
    try {
        if (modo === '--previa') await previa();
        else if (modo === '--aplicar') aplicar();
        else reverter();
    } finally {
        db.close();
    }
    process.exit(process.exitCode ?? 0);
})().catch(e => { console.error(e); process.exit(1); });
