/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S391: SKILL.md gravado com BOM (UTF-8 com assinatura) é carregado.
 *
 * Produção, Windows, 11/10/2026 14:00–23:51 (newclaw-audit.log): a skill `gmail-himalaya`, criada pelo NewClaw de outra máquina e
 * repassada ao do PC, foi gravada com BOM (EF BB BF) antes do `---`. O SkillLoader não reconhecia o cabeçalho, registrava
 * "SKILL.md sem nome" (43 vezes) e descartava a skill — durante essas ~10 horas o agente tentou acessar o Gmail sem o manual que já
 * estava na pasta de skills. A correção (remover o BOM antes de ler o cabeçalho, em `parseFrontmatter` e `stripFrontmatter`) entrou
 * em 4f2af6e sem teste; depois da atualização a skill passou a carregar.
 *
 * Editores e o PowerShell do Windows gravam BOM e CRLF com frequência; skills são compartilhadas entre Windows, Linux e macOS.
 *
 * REGRESSÃO SE: um SKILL.md com BOM (com LF ou CRLF) voltar a ser descartado; o BOM vazar para o nome ou para o conteúdo; ou um
 * SKILL.md realmente sem nome passar a ser aceito.
 *
 * Execução: npx ts-node src/__tests__/regression/S391_SkillLoader_BomFrontmatter.test.ts
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SkillLoader } from '../../skills/SkillLoader';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

const BOM = '﻿';
const cabecalho = (fim: string, nome = 'skill-de-teste') =>
    [`---`, `name: ${nome}`, `description: Skill usada só pelo teste S391.`, `triggers: alfa, beta`, `tools: read`, `---`, ``,
        `# Manual`, `Passo 1: conferir a configuração.`].join(fim) + fim;

function carregar(arquivos: Record<string, string>): { loader: SkillLoader; dir: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-s391-'));
    for (const [pasta, conteudo] of Object.entries(arquivos)) {
        fs.mkdirSync(path.join(dir, pasta), { recursive: true });
        fs.writeFileSync(path.join(dir, pasta, 'SKILL.md'), conteudo, 'utf-8');
    }
    const loader = new SkillLoader(dir);
    loader.loadAll();
    return { loader, dir };
}

const casos: Array<[string, string]> = [
    ['BOM + LF', BOM + cabecalho('\n')],
    ['BOM + CRLF (editor/PowerShell do Windows)', BOM + cabecalho('\r\n')],
    ['sem BOM (controle)', cabecalho('\n')],
];

for (const [rotulo, conteudo] of casos) {
    console.log(`\n=== S391 — ${rotulo} ===`);
    const { loader, dir } = carregar({ 'skill-de-teste': conteudo });
    try {
        const skill = loader.getSkill('skill-de-teste');
        assert(skill !== undefined, `${rotulo}: a skill é carregada (não é descartada como "sem nome")`, loader.getSkillNames());
        assert(!!skill && !skill.name.includes(BOM) && skill.name === 'skill-de-teste', `${rotulo}: o nome sai limpo, sem o BOM`, skill?.name);
        assert(!!skill && skill.description === 'Skill usada só pelo teste S391.', `${rotulo}: a descrição é lida`, skill?.description);
        assert(!!skill && !skill.content.includes(BOM) && !skill.content.startsWith('---') && skill.content.includes('Passo 1'),
            `${rotulo}: o conteúdo sai sem o BOM e sem o cabeçalho, com o manual inteiro`, skill?.content.slice(0, 80));
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

console.log('\n=== S391 — SKILL.md realmente sem nome continua recusado ===');
{
    const semNome = BOM + ['---', 'description: sem nome', '---', '', 'corpo'].join('\n');
    const { loader, dir } = carregar({ 'sem-nome': semNome, 'skill-de-teste': BOM + cabecalho('\n') });
    try {
        assert(loader.getSkillNames().length === 1 && loader.getSkill('skill-de-teste') !== undefined,
            'só a skill com nome é carregada; a sem nome é descartada', loader.getSkillNames());
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S391 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;
