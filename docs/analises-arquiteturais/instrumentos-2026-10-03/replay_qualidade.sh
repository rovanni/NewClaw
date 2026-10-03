cd /d/IA/newclaw
S=/c/Users/lucia/AppData/Local/Temp/claude/D--IA-newclaw/bbbd7d11-fc31-4dfe-bc04-4f032f9ac728/scratchpad/exp-cap
export TS_NODE_PROJECT=tsconfig.json TS_NODE_TRANSPILE_ONLY=true
set -a; . <(tr -d '\r' < /c/Users/lucia/NewClaw/.env | grep -E '^(OLLAMA_URL|OLLAMA_MODEL|OLLAMA_API_KEY|DEFAULT_PROVIDER)='); set +a
for m in glm-5.2:cloud kimi-k2.7-code:cloud; do
  PLANNER_MODEL=$m node node_modules/ts-node/dist/bin.js docs/auditoria-simplificacao-cognitiva-2026-09-24/instrumentos/replay_rc1.ts $S/newclaw.db --real 10 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -a -E "^(===|ferramentas|powerpoint|RUN|RESULT|STEP|RUN-ERRO|ERRO)" > $S/q_${m//[:\/]/_}.txt
done
echo FIM > $S/q_fim.txt
