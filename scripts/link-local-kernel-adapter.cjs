#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

function ensureOptionalAdapterLink(projectDir, adapterDir) {
  const manifestPath = path.join(adapterDir, 'package.json');
  if (!fs.existsSync(manifestPath)) return false;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.name !== 'newclaw-kernel-adapter') {
    throw new Error(`Pacote inesperado em ${adapterDir}: ${manifest.name || '(sem nome)'}`);
  }

  const modulesDir = path.join(projectDir, 'node_modules');
  const linkPath = path.join(modulesDir, 'newclaw-kernel-adapter');
  fs.mkdirSync(modulesDir, { recursive: true });
  try {
    fs.lstatSync(linkPath);
    const currentTarget = fs.realpathSync(linkPath);
    if (currentTarget === fs.realpathSync(adapterDir)) return true;
    throw new Error(`Não vou substituir o caminho já existente: ${linkPath} → ${currentTarget}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  fs.symlinkSync(path.resolve(adapterDir), linkPath, process.platform === 'win32' ? 'junction' : 'dir');
  return true;
}

if (require.main === module) {
  const projectDir = path.resolve(__dirname, '..');
  const adapterDir = path.resolve(projectDir, '..', 'newclaw-kernel-adapter');
  if (ensureOptionalAdapterLink(projectDir, adapterDir)) {
    console.log('Adaptador local opcional vinculado.');
  } else {
    console.log('Adaptador local opcional ausente; instalação principal segue sem ele.');
  }
}

module.exports = { ensureOptionalAdapterLink };
