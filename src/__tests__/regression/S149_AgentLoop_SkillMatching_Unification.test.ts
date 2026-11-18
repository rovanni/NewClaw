/// <reference types="node" />
/**
 * S149 — Unificação do matching de skill em AgentLoop.ts com SkillDiscovery.
 *
 * Contexto: `AgentLoop.ts` (~L2876) reimplementava inline a mesma lógica de trigger-matching que
 * `SkillDiscovery.matchSkillByTrigger()` já implementa (`SkillDiscovery.ts:157-160`) — duas cópias
 * do mesmo algoritmo (substring case-insensitive de cada trigger no texto do usuário). Sprint 002
 * substituiu o filtro inline por `discoverSkills(manualSkills, userText).byTrigger`.
 *
 * Até a ADR-040 (17/11/2026), `discoverSkills()` também devolvia `.byCapability`/`.all` (match por
 * tag/capacidade), que este call site nunca usou. A ADR-040 tirou esse casamento: `discoverSkills()`
 * devolve só as skills casadas por gatilho (frase). Este teste trava que:
 *   1. `discoverSkills` é idêntico, skill a skill e em ordem, à regra de referência (frase inteira,
 *      fronteira de palavra, sem diferença de acento), para uma variedade de mensagens/skills sintéticas;
 *   2. uma consulta que só casaria por etiqueta (sem gatilho no texto) não traz a skill;
 *   3. as 6 skills reais do repositório seguem a mesma regra para mensagens reais dos logs.
 */
import * as fs from 'fs';
import * as path from 'path';
import { discoverSkills } from '../../skills/SkillDiscovery';
import type { Skill } from '../../skills/SkillLoader';
import { keywordBoundaryMatches } from '../../shared/keywordBoundary';

let failures = 0;
function check(ok: boolean, label: string, detail = ''): void {
  if (ok) {
    console.log(`  OK   ${label}`);
  } else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

/**
 * A regra do AgentLoop para gatilho. Era a réplica do filtro inline antigo (substring); desde a ADR-040 (S488) é a frase
 * inteira com fronteira de palavra (`keywordBoundaryMatches`) e sem diferença de acento. `discoverSkills` segue
 * exatamente essa regra.
 */
function oldInlineMatch(skills: Skill[], userText: string): Skill[] {
  const semAcento = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  return skills.filter(s =>
    s.triggers?.some(t => keywordBoundaryMatches(semAcento(userText), semAcento(t)))
  );
}

function makeSkill(name: string, triggers: string[], tags: string[] = []): Skill {
  return {
    name,
    description: `descrição de ${name} com palavras longas suficientes para tags`,
    version: '1.0',
    triggers,
    tags,
    tools: [],
    content: `conteúdo de ${name}`,
    globalContent: `conteúdo global de ${name}`,
  } as unknown as Skill;
}

console.log('\n=== S149-1 — discoverSkills é idêntico à regra de referência (sintético) ===');
{
  const skills = [
    makeSkill('system-provisioner', ['instalar', 'install', 'configurar', 'setup', 'dependência', 'pip', 'npm', 'apt']),
    makeSkill('skill-manager', ['instalar skill', 'adicionar skill', 'nova skill', 'skills add', 'skill install', 'buscar skill', 'npx skills', 'skills.sh', 'habilidade nova', 'capacidade nova']),
    makeSkill('pptx-generator', ['criar pptx', 'gerar apresentação', 'powerpoint']),
    makeSkill('content-validator', ['validar arquivo', 'revisar html']),
  ];

  const messages = [
    'preciso instalar o pacote numpy',
    'tem um skill que te orienta com o passo a passo',
    'oi tudo bem, cria um pptx pra mim sobre python',
    'buscar skill de tradução em skills.sh',
    'só um oi mesmo, sem pedido nenhum',
    'INSTALAR o Node.js agora por favor',
  ];

  for (const msg of messages) {
    const expected = oldInlineMatch(skills, msg).map(s => s.name);
    const actual = discoverSkills(skills, msg).map(s => s.name);
    check(
      JSON.stringify(actual) === JSON.stringify(expected),
      `"${msg.slice(0, 40)}" → mesmas skills, mesma ordem`,
      `esperado=${JSON.stringify(expected)} obtido=${JSON.stringify(actual)}`,
    );
  }
}

console.log('\n=== S149-2 — etiqueta sem gatilho no texto não traz a skill (ADR-040) ===');
{
  // system-provisioner tem a tag "environment" — uma query sem nenhum gatilho ("instalar/install/configurar/setup/pip/
  // npm/apt") mas com "environment" trazia a skill pelo casamento por capacidade, que saiu.
  const skills = [
    makeSkill('system-provisioner', ['instalar', 'install', 'configurar', 'setup', 'dependência', 'pip', 'npm', 'apt'], ['install', 'setup', 'environment', 'dependency', 'package', 'configure', 'provision']),
  ];
  const achadas = discoverSkills(skills, 'preciso saber mais sobre o environment disponível agora').map(s => s.name);
  check(achadas.length === 0, 'a tag "environment" sozinha não traz system-provisioner', `obtido=${JSON.stringify(achadas)}`);
  check(discoverSkills(skills, 'o pacote foi instalado ontem').length === 0, '"instalado" não é o gatilho "instalar" (palavra inteira)');
  check(discoverSkills(skills, 'falta uma dependencia aqui').map(s => s.name).includes('system-provisioner'), 'o gatilho "dependência" casa escrito sem acento');
}

console.log('\n=== S149-3 — skills reais do repositório: mesmas mensagens da sessão continuam batendo os mesmos triggers ===');
{
  function loadRealSkill(dir: string): Skill | null {
    const skillPath = path.join(__dirname, '..', '..', '..', 'skills', dir, 'SKILL.md');
    if (!fs.existsSync(skillPath)) return null;
    const raw = fs.readFileSync(skillPath, 'utf-8');
    const frontmatter = raw.match(/^---\n([\s\S]*?)\n---/);
    if (!frontmatter) return null;
    const triggersLine = frontmatter[1].match(/^triggers:\s*(.+)$/m);
    const tagsLine = frontmatter[1].match(/^tags:\s*(.+)$/m);
    const triggers = triggersLine ? triggersLine[1].split(',').map(t => t.trim()) : [];
    const tags = tagsLine ? tagsLine[1].split(',').map(t => t.trim()) : [];
    return { name: dir, description: '', version: '1.0', triggers, tags, tools: [], content: '', globalContent: '' } as unknown as Skill;
  }

  const realSkills = ['system-provisioner', 'skill-manager', 'content-validator', 'html-pdf-converter', 'skill-auditor', 'pptx-generator']
    .map(loadRealSkill)
    .filter((s): s is Skill => s !== null);

  check(realSkills.length === 6, `6 skills reais carregadas do repositório`, `carregadas=${realSkills.length}`);

  // Mensagens reais de logs/newclaw-audit.log usadas nesta sessão (2026-07-25/26).
  const realMessages = [
    'tente instalar',
    'tem um skill que te orienta com o passo a passo',
    'Já consegui configurar minha dúvida é onde ficar o IDs Autor',
  ];

  for (const msg of realMessages) {
    const expected = oldInlineMatch(realSkills, msg).map(s => s.name);
    const actual = discoverSkills(realSkills, msg).map(s => s.name);
    check(
      JSON.stringify(actual) === JSON.stringify(expected),
      `mensagem real "${msg.slice(0, 40)}" → mesmo resultado do filtro antigo`,
      `esperado=${JSON.stringify(expected)} obtido=${JSON.stringify(actual)}`,
    );
  }
}

console.log(`\n${'─'.repeat(60)}`);
console.log(failures === 0 ? '✅ S149 passou' : `❌ S149: ${failures} falha(s)`);
process.exit(failures === 0 ? 0 : 1);
