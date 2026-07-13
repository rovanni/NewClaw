#!/bin/bash
# NewClaw Auto-Update Script
# Usage: ./update.sh [restart] [--channel=stable|preview|dev] [--branch=<nome>] [--check] [--force]
#
# Encaminhador fino: toda a lógica de atualização (fetch, canais, stash, build,
# guard de self-update) vive em bin/newclaw (fonte única de verdade — ver
# resolveUpdateChannel() lá). Este script só existe para quem já tinha o hábito
# de rodar ./update.sh diretamente; ele nunca reimplementa git por conta própria.

DIR="$(cd "$(dirname "$0")" && pwd)"
exec node "$DIR/bin/newclaw" update "$@"
