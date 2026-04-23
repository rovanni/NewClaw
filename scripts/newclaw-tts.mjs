#!/usr/bin/env node
// newclaw-tts.mjs - Gerar áudio com edge-tts via tts()

import { tts } from 'edge-tts';
import { createWriteStream } from 'fs';

const text = process.argv[2];
const output = process.argv[3];
const voice = process.argv[4] || 'pt-BR-ThalitaMultilingualNeural';

if (!text || !output) {
  console.error('Uso: node --import tsx/esm newclaw-tts.mjs "texto" saida.mp3 [voz]');
  process.exit(1);
}

const audio = await tts({ text, voice });
const writable = createWriteStream(output);
audio.audioStream.pipe(writable);

await new Promise((resolve, reject) => {
  writable.on('finish', resolve);
  writable.on('error', reject);
});

console.log('OK: ' + output);