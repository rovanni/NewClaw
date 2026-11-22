---
name: video-media
description: Baixa vídeos (YouTube, TikTok, Instagram e outros suportados pelo yt-dlp) em MP4 validado e transcreve vídeos ou áudios localmente (texto via servidor Whisper configurado ou texto com timestamps + legenda .srt via faster-whisper).
version: "1.0"
triggers: baixar vídeo, baixar vídeos, baixar o vídeo, baixar esse vídeo, baixa o vídeo, baixa esse vídeo, baixe o vídeo, baixe esse vídeo, transcrever vídeo, transcrever vídeos, transcrever o vídeo, transcrever esse vídeo, transcreve o vídeo, transcreve esse vídeo, transcrição do vídeo, transcrição de vídeo, transcrição de vídeos, gerar legenda, legenda srt, legendas sincronizadas, download video, transcribe video, descargar video, transcribir video, tiktok.com, youtu.be, youtube.com/watch, youtube.com/shorts, instagram.com/reel
tools: exec_command, send_document, read
tags: video, download, transcribe, transcription, subtitles, srt, audio, media, youtube, tiktok, instagram
plataformas: todas
formato_skill: 1
---

# Video Media (Download & Transcrição Local)

Use o script unificado `{NEWCLAW}/scripts/video-media.mjs` em vez de criar scripts Python/bash do zero.

## 1. Baixar vídeo em MP4 compatível

```text
exec_command: node "{NEWCLAW}/scripts/video-media.mjs" baixar "<URL>" --whatsapp
```

Use `timeout: 600000` e `tolerancia_sem_atividade: 120`.
- O script valida a faixa de vídeo com `ffprobe` (evita MP4 só com áudio) e imprime `ARQUIVO_GERADO: <caminho>`.
- Envie exatamente esse caminho com `send_document`.

## 2. Transcrever vídeo ou áudio

- **Texto corrido (rápido, usa `WHISPER_API_URL` se configurado ou cai para local):**
  ```text
  exec_command: node "{NEWCLAW}/scripts/video-media.mjs" transcrever "<URL_OU_ARQUIVO>" --lang pt
  ```
- **Com timestamps `[HH:MM:SS]` e legenda `.srt` sincronizada (`faster-whisper` local):**
  ```text
  exec_command: node "{NEWCLAW}/scripts/video-media.mjs" transcrever "<URL_OU_ARQUIVO>" --legendas --model base --lang pt
  ```

Use `timeout: 1200000` e `tolerancia_sem_atividade: 240`.
- O script imprime `TRANSCRICAO_TXT: <caminho>` (e `LEGENDA_SRT: <caminho>` quando `--legendas`).
- Use `send_document` para enviar os arquivos e `read` no `.txt` se o usuário pediu resumo ou texto na conversa.

## 3. Diagnóstico e regras

- Para checar ferramentas disponíveis: `node "{NEWCLAW}/scripts/video-media.mjs" sondar`.
- Se faltar alguma dependência (`yt-dlp`, `ffmpeg`, `faster-whisper`), relate exatamente o que `sondar` apontou ou use `system-provisioner` se o usuário pedir instalação.
- Nunca copie um vídeo antigo do workspace por data quando o usuário pedir para baixar uma URL.
