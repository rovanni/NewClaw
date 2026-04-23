#!/bin/bash
# newclaw-tts.sh - Gerar áudio via edge-tts
# Uso: ./newclaw-tts.sh "texto" saida.mp3 [voz] [rate]

TEXT="$1"
OUTPUT="$2"
VOICE="${3:-pt-BR-ThalitaNeural}"
RATE="${4:-+0%}"

if [ -z "$TEXT" ] || [ -z "$OUTPUT" ]; then
    echo "Uso: $0 \"texto\" saida.mp3 [voz] [rate]"
    exit 1
fi

EDGE_TTS="${EDGE_TTS_PATH:-edge-tts}"

$EDGE_TTS --voice "$VOICE" --rate "$RATE" --text "$TEXT" --write-media "$OUTPUT" 2>/dev/null

if [ $? -ne 0 ]; then
    echo "ERRO: Falha ao gerar áudio"
    exit 1
fi

if [ -f "$OUTPUT" ]; then
    echo "OK: $OUTPUT"
else
    echo "ERRO: Arquivo de saída não encontrado"
    exit 1
fi