---
name: telegram-voice
description: Gera e envia mensagens de áudio (TTS) via Telegram usando Edge-TTS
version: "1.0"
triggers: áudio, voz, voice, tts, falar, ouvir, escutar
tools: exec_command
---

# Telegram Voice Skill

Quando o usuário pedir áudio ou voz:

1. Gere o texto da resposta normalmente
2. Use `edge-tts` para converter texto em áudio MP3:
   ```bash
   edge-tts --voice pt-BR-ThalitaNeural --rate=+0% --text "SEU_TEXTO" --write-media /tmp/audio_NNN.mp3
   ```
3. Converta para OGG (formato voice note do Telegram):
   ```bash
   ffmpeg -i /tmp/audio_NNN.mp3 -c:a libopus -b:a 64k /tmp/audio_NNN.ogg -y
   ```
4. Envie como voice note no Telegram

**Voz padrão:** pt-BR-ThalitaNeural
**Alternativa masculina:** pt-BR-AntonioNeural

Se o edge-tts não estiver instalado, instale com:
```bash
npm install -g edge-tts
```