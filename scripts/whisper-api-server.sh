#!/bin/bash
# Whisper API Server for Thorial
# Runs whisper-server on Marte, accessible by VPSes via API
WHISPER_BIN="/usr/local/bin/whisper/build/bin/whisper-server"
WHISPER_MODEL="/usr/local/bin/whisper/models/ggml-base.bin"
PORT="${WHISPER_PORT:-8177}"
HOST="${WHISPER_HOST:-0.0.0.0}"

if [ ! -f "$WHISPER_BIN" ]; then
    echo "❌ whisper-server not found at $WHISPER_BIN"
    echo "   Build with: cd ~/whisper.cpp && make whisper-server"
    exit 1
fi

if [ ! -f "$WHISPER_MODEL" ]; then
    echo "❌ Model not found at $WHISPER_MODEL"
    echo "   Download with: ~/whisper.cpp/models/download-ggml-model.sh base"
    exit 1
fi

echo "🎤 Starting Whisper API Server on port $PORT..."
echo "   Model: $WHISPER_MODEL"
echo "   Language: pt (Portuguese)"
echo "   GPU: disabled (CPU mode)"

$WHISPER_BIN \
    --model "$WHISPER_MODEL" \
    --port "$PORT" \
    --host "$HOST" \
    --language pt \
    --threads 4 \
    --no-gpu \
    --no-timestamps