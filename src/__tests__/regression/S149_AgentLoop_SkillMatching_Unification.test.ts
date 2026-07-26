/// <reference types="node" />
/**
 * S149 — Unificação do matching de skill em AgentLoop.ts com SkillDiscovery.
 *
 * Contexto: `AgentLoop.ts` (~L2876) reimplementava inline a mesma lógica de trigger-matching que
 * `SkillDiscovery.matchSkillByTrigger()` já implementa (`SkillDiscovery.ts:157-160`) — duas cópias
 * do mesmo algoritmo (substring case-insensitive de cada trigger no texto do usuário). Sprint 002
 * substituiu o filtro inline por `discoverSkills(manualSkills, userText).byTrigger`.
 *
 * Ponto crítico validado aqui: `discoverSkills()` também retorna `.byCapability`/`.all` (match por
 * tag/capacidade) — algo que este call site NUNCA fez. Usar `.all` por engano adicionaria skills
 * que o comportamento antigo nunca selecionava. Este teste trava que:
 *   1. `byTrigger` é idêntico, skill a skill e em ordem, ao filtro inline antigo, para uma
 *      variedade de mensagens/skills sintéticas;
 *   2. existe pelo menos um caso sintético onde `.all` DIFERE de `.byTrigger` (prova de que a
 *      escolha de usar só `.byTrigger` era uma decisão real, não uma coincidência sem efeito);
 *   3. as 6 skills reais do repositório continuam sendo descobertas por trigger exatamente como
 *      antes, para uma amostra de mensagens reais já usadas nos logs desta sessão.
 */
import * as fs from 'fs';
import * as path from 'path';
import { discoverSkills } from '../../skills/SkillDiscovery';
import type { Skill } from '../../skills/SkillLoader';

let failures = 0;
function check(ok: boolean, label: string, detail = ''): void {
  if (ok) {
    console.log(`  OK   ${label}`);
  } else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

/** Réplica exata do filtro inline que existia em AgentLoop.ts antes da unificação (S149). */
function oldInlineMatch(skills: Skill[], userText: string): Skill[] {
  return skills.filter(s =>
    s.triggers?.some(t => userText.toLowerCase().includes(t.toLowerCase()))
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

console.log('\n=== S149-1 — byTrigger é idêntico ao filtro inline antigo (sintético) ===');
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
    const actual = discoverSkills(skills, msg).byTrigger.map(s => s.name);
    check(
      JSON.stringify(actual) === JSON.stringify(expected),
      `"${msg.slice(0, 40)}" → mesmas skills, mesma ordem`,
      `esperado=${JSON.stringify(expected)} obtido=${JSON.stringify(actual)}`,
    );
  }
}

console.log('\n=== S149-2 — .all difere de .byTrigger em pelo menos um caso (prova que a escolha importa) ===');
{
  // system-provisioner tem tag "install"/"setup"/"environment" — uma query que NÃO bate nenhum
  // trigger mas cujas palavras (após stemming) batem as tags deve aparecer em .all e não em
  // .byTrigger, demonstrando que usar .all mudaria o comportamento.
  const skills = [
    makeSkill('system-provisioner', ['instalar', 'install', 'configurar', 'setup', 'dependência', 'pip', 'npm', 'apt'], ['install', 'setup', 'environment', 'dependency', 'package', 'configure', 'provision']),
  ];
  // Deliberadamente sem nenhum trigger literal ("instalar/install/configurar/setup/pip/npm/apt")
  // mas contendo "environment", que é uma tag da skill — deve bater por capacidade, não por trigger.
  const query = 'preciso saber mais sobre o environment disponível agora';
  const discovery = discoverSkills(skills, query);
  const differs = JSON.stringify(discovery.all.map(s => s.name)) !== JSON.stringify(discovery.byTrigger.map(s => s.name));
  check(differs, '.all inclui matches por capacidade que .byTrigger não inclui', `byTrigger=${JSON.stringify(discovery.byTrigger.map(s => s.name))} all=${JSON.stringify(discovery.all.map(s => s.name))}`);
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
    const actual = discoverSkills(realSkills, msg).byTrigger.map(s => s.name);
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
