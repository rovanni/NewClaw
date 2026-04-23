#!/bin/bash
# NewClaw Database Backup — every 6h via crontab

DB_FILE="/home/venus/newclaw/data/newclaw.db"
BACKUP_DIR="/home/venus/backups"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
MAX_BACKUPS=30
BACKUP_FILE="$BACKUP_DIR/newclaw_$TIMESTAMP.db"

echo "$(date '+%Y-%m-%d %H:%M:%S') Iniciando backup..."

mkdir -p "$BACKUP_DIR"

if [ ! -f "$DB_FILE" ]; then
  echo "❌ Erro: DB não encontrado em $DB_FILE"
  exit 1
fi

# Backup atômico via sqlite3
if command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "$DB_FILE" ".backup '$BACKUP_FILE'"
else
  cp "$DB_FILE" "$BACKUP_FILE"
fi

if [ $? -ne 0 ]; then
  echo "❌ Erro ao criar backup"
  exit 1
fi

SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
echo "✅ Backup criado: $BACKUP_FILE ($SIZE)"

# Limpar backups antigos
cd "$BACKUP_DIR" || exit 1
BACKUP_COUNT=$(ls -1 newclaw_*.db 2>/dev/null | wc -l)
if [ "$BACKUP_COUNT" -gt "$MAX_BACKUPS" ]; then
  FILES_TO_REMOVE=$((BACKUP_COUNT - MAX_BACKUPS))
  echo "🧹 Removendo $FILES_TO_REMOVE backup(s) antigo(s)..."
  ls -1tr newclaw_*.db | head -n "$FILES_TO_REMOVE" | xargs rm -f
fi

echo "📊 Total de backups: $(ls -1 newclaw_*.db 2>/dev/null | wc -l)"
