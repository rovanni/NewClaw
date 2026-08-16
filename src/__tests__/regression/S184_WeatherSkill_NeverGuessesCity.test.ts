/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S184
 * Nenhum template de skill embarcado no código pode nomear uma cidade — e a ferramenta de
 * clima não pode ganhar uma cidade de exemplo que vire palpite.
 *
 * CONTEXTO (incidente real, 03/08/2026, 05:02, logs/newclaw-audit.log):
 *
 *     usuário: "Vai chover hoje, qual a temperatura para hoje?"
 *     05:02:39  [FAST-PATH] No city in intent or memory — falling back to cognition loop
 *     05:03:44  [TOOL] weather -> ✓ São Paulo, São Paulo - Brasil | 15.1°C
 *     usuário: "Mas moro em cornélio procópio"
 *
 * O caminho rápido acertou: sem cidade na mensagem nem na memória, recusou-se a adivinhar. A
 * ferramenta `weather` também está correta — exige `city` e devolve "Cidade não informada" sem
 * ela. Quem inventou a cidade foi o MODELO, e ele estava seguindo instruções escritas:
 *
 *  1. O template de skill `weather` em SkillLearner.ts dizia literalmente
 *     `Use web_search com {"query": "São Paulo Brasil weather"} para clima`.
 *  2. A descrição do parâmetro `city` oferecia `(ex: São Paulo, Curitiba)` — e num parâmetro
 *     obrigatório o exemplo vira o palpite. O modelo escolheu o primeiro.
 *
 * GRAVIDADE PARA UM PROJETO ABERTO: o template está no CÓDIGO-FONTE, não é algo que uma
 * instalação aprendeu. Toda pessoa que instala o NewClaw, em qualquer país, recebia São Paulo
 * como padrão de clima. O mesmo template ainda mandava usar `web_search`, contra a instrução
 * explícita da própria ferramenta ("Sempre use esta ferramenta para clima — NÃO use web_search").
 *
 * PRINCÍPIO: "Nunca Adivinhar" (docs/ARCHITECTURE/NUNCA_ADIVINHAR.md) — diante de um dado
 * necessário que não foi observado nem configurado, reportar ausência (aqui: perguntar), nunca
 * inferir um valor plausível e apresentá-lo como fato.
 *
 * REGRESSÃO SE: qualquer template de skill voltar a nomear uma cidade; se a descrição de `city`
 * voltar a trazer exemplos; ou se o template de clima voltar a apontar para web_search.
 *
 * Execução: npx ts-node src/__tests__/regression/S184_WeatherSkill_NeverGuessesCity.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

const LEARNER = fs.readFileSync(path.join(process.cwd(), 'src', 'loop', 'SkillLearner.ts'), 'utf-8');
const WEATHER = fs.readFileSync(path.join(process.cwd(), 'src', 'tools', 'weather.ts'), 'utf-8');

/** Só o bloco de templates — comentários explicativos PODEM citar a cidade do incidente. */
function blocoDeTemplates(): string {
    // S237 moveu os templates de dentro de createSkillFromPattern() para uma constante estática
    // de classe (SkillLearner.SKILL_DEFS), compartilhada com tryCreateSkillProposal() — mesmos
    // dados, marcadores de texto atualizados.
    const ini = LEARNER.indexOf('private static readonly SKILL_DEFS');
    const fim = LEARNER.indexOf('const def = SkillLearner.SKILL_DEFS[pattern];');
    return LEARNER.slice(ini, fim);
}

/** Linhas de dados dos templates (name/trigger/description/prompt/toolSeq), sem comentários. */
function linhasDeDados(): string[] {
    return blocoDeTemplates()
        .split('\n')
        .map(l => l.trim())
        .filter(l => l && !l.startsWith('//') && !l.startsWith('*') && !l.startsWith('/*'));
}

console.log('\n=== S184-1 — nenhum template embarcado nomeia uma cidade ===');
{
    // Lista das capitais/cidades que mais aparecem como "exemplo" e viram padrão. Não pretende
    // ser exaustiva: a garantia forte é S184-2, que proíbe a FORMA da consulta com local fixo.
    const cidades = [
        'São Paulo', 'Sao Paulo', 'Rio de Janeiro', 'Brasília', 'Brasilia', 'Curitiba',
        'New York', 'London', 'Madrid', 'Lisboa', 'Buenos Aires', 'Ciudad de México',
    ];
    const dados = linhasDeDados().join('\n');
    for (const cidade of cidades) {
        assert(
            !dados.includes(cidade),
            `nenhum template menciona "${cidade}"`,
        );
    }
}

console.log('\n=== S184-2 — a forma "consulta com local fixo" não voltou ===');
{
    const dados = linhasDeDados().join('\n');
    assert(
        !/"query":\s*"[A-ZÀ-Ú][^"]*weather"/.test(dados),
        'nenhum template embute uma query de clima com local escrito',
    );
    assert(
        !/cidade padrão|cidade padrao|default city/i.test(dados),
        'nenhum template promete "cidade padrão" — era a descrição do template quebrado',
    );
}

console.log('\n=== S184-3 — o template de clima manda PERGUNTAR quando não sabe ===');
{
    const bloco = blocoDeTemplates();
    const weather = bloco.slice(bloco.indexOf('weather: {'), bloco.indexOf('audio_request: {'));
    assert(weather.length > 0, 'o template de clima existe');
    assert(
        /PERGUNTE ao usuário/.test(weather),
        'instrui a perguntar quando nenhuma cidade for conhecida',
    );
    assert(
        /nunca escolha uma cidade por conta própria/i.test(weather),
        'proíbe explicitamente escolher por conta própria',
    );
    assert(
        /toolSeq: \['weather'\]/.test(weather),
        'aponta para a ferramenta dedicada, não para web_search',
    );
    assert(
        !/toolSeq: \['web_search'\]/.test(weather),
        'não volta a contradizer a própria descrição da ferramenta weather',
    );
}

console.log('\n=== S184-4 — a ferramenta não oferece cidade de exemplo ===');
{
    const params = WEATHER.slice(WEATHER.indexOf('parameters = {'), WEATHER.indexOf('private getWeatherDescription'));
    assert(
        !/ex:\s*São Paulo/.test(params),
        'o exemplo "(ex: São Paulo, Curitiba)" foi removido — num parâmetro obrigatório o exemplo vira o palpite',
    );
    assert(
        /NUNCA invente nem use uma cidade de exemplo/.test(params),
        'a descrição instrui explicitamente a não inventar',
    );
    assert(
        /pergunte ao usuário em vez de chamar esta ferramenta/.test(params),
        'e diz o que fazer no lugar: perguntar',
    );
}

console.log('\n=== S184-5 — a ferramenta continua recusando execução sem cidade ===');
{
    // Esta guarda já existia e é a última linha de defesa: mesmo que o modelo tente chamar sem
    // cidade, nada é inventado do lado de cá.
    assert(
        /if \(!city\) \{\s*\n\s*return \{ success: false, output: '', error: 'Cidade não informada\.' \};/.test(WEATHER),
        'sem cidade, a ferramenta falha explicitamente em vez de assumir um padrão',
    );
    assert(
        /required: \['city'\]/.test(WEATHER),
        'city continua sendo parâmetro obrigatório',
    );
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S184 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
console.log(`\nCOBERTURA:`);
console.log(`  Nenhum template nomeia cidade: testado`);
console.log(`  Forma "query com local fixo" proibida: testado`);
console.log(`  Template de clima manda perguntar: testado`);
console.log(`  Ferramenta sem cidade de exemplo: testado`);
console.log(`  Recusa sem cidade preservada: testado`);
if (failed > 0) process.exit(1);
