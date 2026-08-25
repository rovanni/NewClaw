const path = require('path');
const isWin = process.platform === 'win32';
const DIR = path.resolve(__dirname);

module.exports = {
  apps: [{
    name: "newclaw",
    script: isWin ? "dist/index.js" : "./scripts/pm2-start.sh",
    interpreter: isWin ? "node" : "bash",
    node_args: isWin ? "--max-old-space-size=256 --disable-warning=DEP0040" : undefined,
    cwd: DIR,
    env: {
      NODE_ENV: "production",
      LOG_FILE: path.join(DIR, 'logs', 'newclaw-audit.log'),
    },
    max_memory_restart: "500M",
    log_date_format: "YYYY-MM-DD HH:mm:ss",
    kill_timeout: 20000,
    restart_delay: 40000,
    wait_ready: false,
    listen_timeout: 10000,
    // O servidor de modelo local (llamafile) sobe como filho detached + unref() (models.ts,
    // ver comentário no spawn) especificamente para sobreviver a um restart do NewClaw — decisão
    // de 02/08/2026, depois de um restart matar o processo filho junto. Sem `treekill: false`,
    // essa garantia não se sustenta: o default do pm2 (`treekill: true`) mata a ÁRVORE inteira de
    // processos no restart — inclusive filhos detached — via TreeKill, contornando por completo o
    // `detached` do Node. Confirmado ao vivo (2026-08-24): um `pm2 restart newclaw` com o GLM-4.7-
    // Flash (18GB) carregado derrubou a porta 8080 junto. `treekill: false` faz o pm2 matar só o
    // processo principal (God/Methods.js: `pm2_env.treekill !== true` → `process.kill(pid)` puro,
    // sem TreeKill) — o llamafile, não sendo filho direto do pm2, nunca entra nessa chamada.
    treekill: false,
  }]
};
