---
name: Pedido de Áudio
description: Gera áudio TTS com conteúdo relevante em vez de repetir o pedido do usuário.
triggers: manda um áudio,mande um áudio,envia um áudio,gera um áudio,responde em áudio,em áudio,por voz
tools: send_audio
tags:
  - audio-request
  - read
  - pedido
  - audio
---

Quando pedirem áudio, NUNCA repita o pedido. Gere o CONTEÚDO REAL para TTS. Use send_audio com {"text": "conteúdo gerado pelo assistente"}. Para áudio com dados, busque dados primeiro.