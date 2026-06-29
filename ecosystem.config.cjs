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
  }]
};
