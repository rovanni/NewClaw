#!/usr/bin/env node
'use strict';

// Verificação do ambiente antes da instalação. AVISA, não bloqueia (decisão da mantenedora, 14/10/2026: "incorporar sem
// exigir npm 12"): com npm 12.2+, a lista `allowScripts` do package.json decide quais pacotes podem rodar scripts de
// instalação; com npm anterior, a lista é ignorada e os scripts rodam como sempre rodaram — a instalação funciona.

const manifest = require('../package.json');

/** Mínimo de npm que aplica `allowScripts` (não é exigência: abaixo disso a instalação segue sem a lista). */
const NPM_COM_ALLOWSCRIPTS = '>=12.2.0';

function parseVersion(value) {
  const match = String(value || '').match(/(\d+)\.(\d+)\.(\d+)/);
  return match ? match.slice(1).map(Number) : null;
}

function compareVersions(left, right) {
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  }
  return 0;
}

function supportsNodeVersion(version, range = manifest.engines.node) {
  const current = parseVersion(version);
  if (!current) return false;
  return range.split('||').some((part) => {
    const match = part.trim().match(/^\^(\d+)\.(\d+)\.(\d+)$/);
    if (!match) return false;
    const minimum = match.slice(1).map(Number);
    return current[0] === minimum[0] && compareVersions(current, minimum) >= 0;
  });
}

function supportsNpmVersion(version, range = NPM_COM_ALLOWSCRIPTS) {
  const current = parseVersion(version);
  const match = range.match(/^>=(\d+)\.(\d+)\.(\d+)$/);
  return !!current && !!match && compareVersions(current, match.slice(1).map(Number)) >= 0;
}

function verifyRuntime(nodeVersion, userAgent) {
  const npmMatch = String(userAgent || '').match(/(?:^|\s)npm\/(\d+\.\d+\.\d+)/);
  const npmVersion = npmMatch?.[1];
  const issues = [];
  if (!supportsNodeVersion(nodeVersion)) issues.push(`Node.js ${nodeVersion} está fora da faixa testada (${manifest.engines.node}); a instalação continua, mas atualize se algo falhar.`);
  if (npmVersion && !supportsNpmVersion(npmVersion)) issues.push(`npm ${npmVersion}: a lista de scripts de instalação permitidos (allowScripts) só é aplicada a partir do npm 12.2 — a instalação continua normalmente.`);
  return issues;
}

if (require.main === module) {
  for (const issue of verifyRuntime(process.version, process.env.npm_config_user_agent)) console.warn(`⚠️  ${issue}`);
}

module.exports = { parseVersion, compareVersions, supportsNodeVersion, supportsNpmVersion, verifyRuntime, NPM_COM_ALLOWSCRIPTS };
