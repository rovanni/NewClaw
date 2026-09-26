---
name: Pedido de Áudio
description: Gera áudio TTS com conteúdo relevante em vez de repetir o pedido do usuário.
triggers: gerar,criar,enviar,manda,mande,fale,áudio,audio,voz,tts
tools: send_audio
tags:
  - audio-request
  - read
  - pedido
  - audio
---

Quando pedirem áudio, NUNCA repita o pedido. Gere o CONTEÚDO REAL para TTS. Use send_audio com {"text": "conteúdo gerado pelo assistente"}. Para áudio com dados, busque dados primeiro.