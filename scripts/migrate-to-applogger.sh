#!/bin/bash
# migrate-to-applogger.sh — Replace console.log/warn/error with AppLogger
# Strategy: For each .ts file, add import + logger instance, then replace console.* calls

SRC_DIR="/home/rover/.openclaw/workspace/NewClaw/src"
SKIP_FILES="shared/AppLogger.ts|shared/Logger.ts"

# List of files with console.log calls (excluding AppLogger/Logger)
FILES=$(grep -rl "console\.log\|console\.warn\|console\.error" --include="*.ts" "$SRC_DIR" | grep -v -E "($SKIP_FILES)" | grep -v "\.d\.ts")

for FILE in $FILES; do
    RELPATH="${FILE#$SRC_DIR/}"
    # Determine component name from filename (PascalCase)
    BASENAME=$(basename "$FILE" .ts)
    # Convert snake_case or kebab-case to PascalCase
    COMPONENT=$(echo "$BASENAME" | sed -r 's/(^|_|-)([a-z])/\U\2/g')
    
    # Check if already has AppLogger import
    HAS_IMPORT=$(grep -c "createLogger" "$FILE")
    
    if [ "$HAS_IMPORT" -eq 0 ]; then
        # Find the correct relative path for the import
        DEPTH=$(echo "$RELPATH" | tr -cd '/' | wc -c)
        if [ "$DEPTH" -eq 0 ]; then
            IMPORT_PATH="./shared/AppLogger"
        else
            IMPORT_PATH="../shared/AppLogger"
            for ((i=1; i<DEPTH; i++)); do
                IMPORT_PATH="../$IMPORT_PATH"
            done
        fi
        
        # Add import after the last existing import line
        LAST_IMPORT=$(grep -n "^import\|^}" "$FILE" | tail -1 | cut -d: -f1)
        if [ -n "$LAST_IMPORT" ]; then
            sed -i "${LAST_IMPORT}a\\
import { createLogger } from '$IMPORT_PATH';\\
const log = createLogger('$COMPONENT');" "$FILE"
        else
            # No imports found, add at the top
            sed -i "1i\\
import { createLogger } from '$IMPORT_PATH';\\
const log = createLogger('$COMPONENT');" "$FILE"
        fi
    fi
done

echo "Import injection complete. Manual replacement of console.* calls still needed."
echo "Files processed: $(echo "$FILES" | wc -l)"