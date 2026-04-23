#!/usr/bin/env node
// newclaw-tts.js - Gerar áudio com edge-tts
// Uso: node newclaw-tts.js "texto" saida.mp3 [voz] [rate]

const { MsEdgeTTS, OUTPUT_FORMAT } = require('edge-tts');
const { createWriteStream } = require('fs');

async function main() {
  const text = process.argv[2];
  const output = process.argv[3];
  const voice = process.argv[4] || 'pt-BR-ThalitaNeural';

  if (!text || !output) {
    console.error('Uso: node newclaw-tts.js "texto" saida.mp3 [voz]');
    process.exit(1);
  }

  const tts = new MsEdgeTTS();
  await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
  const readable = tts.toStream(text);
  const writable = createWriteStream(output);
  readable.pipe(writable);
  
  await new Promise((resolve, reject) => {
    writable.on('finish', resolve);
    writable.on('error', reject);
  });
  
  console.log('OK: ' + output);
}

main().catch(e => { console.error(e.message); process.exit(1); });