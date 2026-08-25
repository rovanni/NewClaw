/// <reference types="node" />
/**
 * S147 — Paridade de chaves i18n do Dashboard (pt-BR / en-US / es-ES).
 *
 * Contexto: o NewClaw é open source e o Dashboard é servido em três idiomas. `t()` em
 * `shared.js` faz fallback silencioso (idioma atual → en-US → a própria chave), então uma chave
 * esquecida em es-ES não quebra nada de forma visível em desenvolvimento — ela simplesmente
 * aparece em inglês (ou como `ml_filter_label` cru) para o usuário final. Não havia nenhuma
 * verificação automática disso: as regressões de dashboard existentes (S129/S131/S137) cobrem
 * autenticação e rate limit, nunca tradução.
 *
 * Este teste trava duas invariantes que uma mudança de UI pode violar sem perceber:
 *   1. os três dicionários de TRANSLATIONS têm exatamente o mesmo conjunto de chaves;
 *   2. toda chave usada em `t('...')` pelo frontend de config existe nos três dicionários.
 *
 * Origem: auditoria de UX da tela Config → Modelos (2026-07-24/25), onde textos hardcoded em
 * português (aviso de modelos internos, toasts de pull/sync/remoção) foram convertidos para
 * chaves i18n — exatamente a classe de mudança que este teste protege daqui em diante.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'dashboard', 'public');
const SHARED_JS = path.join(PUBLIC_DIR, 'shared.js');

/** Arquivos do frontend que consomem t() e devem ter todas as suas chaves resolvíveis. */
const CONSUMERS = [
  path.join(PUBLIC_DIR, 'config', 'app.js'),
  ...fs.readdirSync(path.join(PUBLIC_DIR, 'config', 'views'))
    .filter(f => f.endsWith('.js'))
    .map(f => path.join(PUBLIC_DIR, 'config', 'views', f)),
  // Lacuna encontrada durante a campanha do Wizard (2026-08-23): components/ nunca foi varrido —
  // LocalModelWizard.js e ConfigWizard.js chamam t() tanto quanto qualquer view, mas nenhum erro
  // de digitação de chave neles seria pego aqui antes. Corrigido dentro da própria campanha C2.
  ...fs.readdirSync(path.join(PUBLIC_DIR, 'config', 'components'))
    .filter(f => f.endsWith('.js'))
    .map(f => path.join(PUBLIC_DIR, 'config', 'components', f)),
];

let failures = 0;
function check(ok: boolean, label: string, detail = '') {
  if (ok) {
    console.log(`  OK   ${label}`);
  } else {
    failures++;
    console.error(`  FALHOU: ${label}${detail ? ' → ' + detail : ''}`);
  }
}

/**
 * Extrai TRANSLATIONS executando shared.js num contexto isolado com stubs de browser.
 * Evita regex/parse manual do literal — o que o teste valida é o objeto real que o browser vê.
 */
function loadTranslations(): Record<string, Record<string, string>> {
  const source = fs.readFileSync(SHARED_JS, 'utf-8');
  const sandbox: any = {
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    document: { addEventListener: () => {}, documentElement: {}, querySelectorAll: () => [], getElementById: () => null },
    window: {},
    console: { log: () => {}, warn: () => {}, error: () => {} },
    fetch: () => Promise.reject(new Error('no network in test')),
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  // `;TRANSLATIONS` no fim faz o valor do const de módulo ser o resultado da avaliação.
  return vm.runInContext(source + '\n;TRANSLATIONS;', sandbox, { timeout: 5000 });
}

console.log('S147 — Paridade de chaves i18n do Dashboard\n');

const TRANSLATIONS = loadTranslations();
const langs = Object.keys(TRANSLATIONS);

check(
  langs.length === 3 && ['pt-BR', 'en-US', 'es-ES'].every(l => langs.includes(l)),
  'os três idiomas suportados estão presentes',
  `encontrados: ${langs.join(', ')}`,
);

// ── 1. Paridade entre dicionários ────────────────────────────────────────────
const reference = 'en-US'; // fallback final de t() — é o dicionário que precisa ser superconjunto
const refKeys = new Set(Object.keys(TRANSLATIONS[reference]));

for (const lang of langs) {
  if (lang === reference) continue;
  const keys = new Set(Object.keys(TRANSLATIONS[lang]));
  const missing = [...refKeys].filter(k => !keys.has(k));
  const extra = [...keys].filter(k => !refKeys.has(k));
  check(missing.length === 0, `${lang}: nenhuma chave faltando em relação a ${reference}`, missing.slice(0, 10).join(', '));
  check(extra.length === 0, `${lang}: nenhuma chave órfã (ausente em ${reference})`, extra.slice(0, 10).join(', '));
}

// ── 2. Toda chave usada por t() existe nos três dicionários ──────────────────
// Só literais estáticos — t(varName) é dinâmico e não é verificável estaticamente.
const T_CALL = /\bt\(\s*'([a-zA-Z0-9_]+)'|\bt\(\s*"([a-zA-Z0-9_]+)"/g;

for (const file of CONSUMERS) {
  const src = fs.readFileSync(file, 'utf-8');
  const used = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = T_CALL.exec(src)) !== null) used.add(m[1] || m[2]);

  const unresolved: string[] = [];
  for (const key of used) {
    for (const lang of langs) {
      if (!(key in TRANSLATIONS[lang])) unresolved.push(`${key} (${lang})`);
    }
  }
  check(
    unresolved.length === 0,
    `${path.basename(file)}: ${used.size} chaves t() resolvem nos 3 idiomas`,
    unresolved.slice(0, 10).join(', '),
  );
}

console.log(failures === 0 ? '\n✅ S147 passou' : `\n❌ S147: ${failures} falha(s)`);
process.exit(failures === 0 ? 0 : 1);
