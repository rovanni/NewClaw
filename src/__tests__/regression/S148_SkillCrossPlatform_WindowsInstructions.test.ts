/// <reference types="node" />
/**
 * S148 — Suporte Windows/Linux/macOS em system-provisioner e skill-manager.
 *
 * Contexto: as duas skills tinham instruções exclusivamente Linux (`pip3`, `sudo apt-get`,
 * `mkdir -p`, `rm -rf`, `cp -r`, `ls -la`, `grep`) — reproduzido em produção (log real,
 * 2026-07-25): `pip3` e `python` falham no Windows (ausência do binário / redirecionamento para
 * o stub da Microsoft Store), forçando o agente a pedir instrução manual ao usuário em vez de
 * seguir o passo a passo da própria skill. Mesmo padrão OS-aware já validado em
 * `GoalEvaluator.ts` (`KNOWN_DEPS['edge-tts'].manualInstructions`, formato
 * "Windows: X | Linux: Y | macOS: Z") foi replicado aqui.
 *
 * Este teste trava que nenhum comando exclusivamente Linux permaneça como única opção nas duas
 * skills — cada instrução de instalação/manipulação de arquivo precisa ter um equivalente
 * Windows visível no mesmo arquivo.
 */
import * as fs from 'fs';
import * as path from 'path';

const SKILLS_DIR = path.join(__dirname, '..', '..', '..', 'skills');
const SYSTEM_PROVISIONER = path.join(SKILLS_DIR, 'system-provisioner', 'SKILL.md');
const SKILL_MANAGER = path.join(SKILLS_DIR, 'skill-manager', 'SKILL.md');

let failures = 0;
function check(ok: boolean, label: string, detail = ''): void {
  if (ok) {
    console.log(`  OK   ${label}`);
  } else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function hasAll(content: string, needles: string[]): string[] {
  return needles.filter(n => !content.includes(n));
}

console.log('\n=== S148-1 — system-provisioner/SKILL.md tem instrução por SO ===');
{
  const content = fs.readFileSync(SYSTEM_PROVISIONER, 'utf-8');

  const missingWindows = hasAll(content, [
    'python -m pip install',
    'winget install',
    'where COMANDO',
  ]);
  check(missingWindows.length === 0, 'contém comandos Windows (python -m pip / winget / where)', missingWindows.join(', '));

  const missingLinuxMac = hasAll(content, [
    'python3 -m pip install',
    'pip3 show PACOTE',
    'sudo apt-get install',
    'brew install',
  ]);
  check(missingLinuxMac.length === 0, 'contém comandos Linux/macOS (python3 -m pip / pip3 / apt-get / brew)', missingLinuxMac.join(', '));

  // Nenhum comando de instalação de sistema deve sobrar como única opção sem par Windows.
  check(
    !/Sistema:\s*`sudo apt-get/.test(content),
    'não restou a forma antiga "Sistema: sudo apt-get" sem branch por SO',
  );
}

console.log('\n=== S148-2 — skill-manager/SKILL.md tem instrução por SO ===');
{
  const content = fs.readFileSync(SKILL_MANAGER, 'utf-8');

  const missingWindows = hasAll(content, [
    'New-Item -ItemType Directory',
    'Copy-Item -Recurse',
    'Remove-Item -Recurse -Force',
    'Get-ChildItem',
    'Select-String',
  ]);
  check(missingWindows.length === 0, 'contém equivalentes PowerShell (New-Item/Copy-Item/Remove-Item/Get-ChildItem/Select-String)', missingWindows.join(', '));

  const missingLinuxMac = hasAll(content, [
    'mkdir -p',
    'cp -r',
    'rm -rf',
    'ls -la',
    'grep -rniE',
  ]);
  check(missingLinuxMac.length === 0, 'mantém os comandos bash originais (mkdir -p/cp -r/rm -rf/ls -la/grep)', missingLinuxMac.join(', '));

  // As 7 auditorias de segurança (Etapa 4) precisam ter par Select-String — não só o grep.
  const grepCount = (content.match(/grep -rniE/g) || []).length;
  const selectStringCount = (content.match(/Select-String -Pattern/g) || []).length;
  check(
    grepCount === 7 && selectStringCount === 7,
    'os 7 padrões de auditoria de segurança existem em bash (grep) e PowerShell (Select-String)',
    `grep=${grepCount} select-string=${selectStringCount}`,
  );
}

console.log('\n=== S148-3 — mesmo padrão de GoalEvaluator.ts (Windows: X | Linux: Y | macOS: Z) ===');
{
  const goalEvaluator = fs.readFileSync(
    path.join(__dirname, '..', '..', 'loop', 'GoalEvaluator.ts'),
    'utf-8',
  );
  check(
    /Windows:.*\|.*Linux:.*\|.*macOS:/.test(goalEvaluator),
    'GoalEvaluator.ts ainda contém o padrão de referência "Windows: X | Linux: Y | macOS: Z"',
  );
  const systemProvisioner = fs.readFileSync(SYSTEM_PROVISIONER, 'utf-8');
  check(
    /Windows:.*\|.*Linux\/macOS:/.test(systemProvisioner) || /Windows.*Linux:.*macOS:/.test(systemProvisioner),
    'system-provisioner/SKILL.md segue o mesmo estilo de instrução inline por SO',
  );
}

console.log(`\n${'─'.repeat(60)}`);
console.log(failures === 0 ? '✅ S148 passou' : `❌ S148: ${failures} falha(s)`);
process.exit(failures === 0 ? 0 : 1);
