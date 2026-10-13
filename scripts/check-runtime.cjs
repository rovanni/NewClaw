#!/usr/bin/env node
'use strict';

const manifest = require('../package.json');

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

function supportsNpmVersion(version, range = manifest.engines.npm) {
  const current = parseVersion(version);
  const match = range.match(/^>=(\d+)\.(\d+)\.(\d+)$/);
  return !!current && !!match && compareVersions(current, match.slice(1).map(Number)) >= 0;
}

function verifyRuntime(nodeVersion, userAgent) {
  const npmMatch = String(userAgent || '').match(/(?:^|\s)npm\/(\d+\.\d+\.\d+)/);
  const npmVersion = npmMatch?.[1];
  const issues = [];
  if (!supportsNodeVersion(nodeVersion)) issues.push(`Node.js ${nodeVersion} não suportado; use ${manifest.engines.node}.`);
  if (!supportsNpmVersion(npmVersion)) issues.push(`npm ${npmVersion || '(não identificado)'} não suportado; use ${manifest.engines.npm} (npm 12 habilita a política allowScripts do projeto).`);
  return issues;
}

if (require.main === module) {
  const issues = verifyRuntime(process.version, process.env.npm_config_user_agent);
  if (issues.length) {
    for (const issue of issues) console.error(`❌ ${issue}`);
    console.error('Atualize Node.js/npm e repita a instalação; nenhum pacote foi instalado por este preinstall.');
    process.exitCode = 1;
  }
}

module.exports = { parseVersion, compareVersions, supportsNodeVersion, supportsNpmVersion, verifyRuntime };
