module.exports = {
  apps: [{
    name: "newclaw",
    script: "./dist/index.js",
    cwd: "/home/venus/newclaw",
    node_args: "--max-old-space-size=256 --disable-warning=DEP0040",
    env: {
      NODE_ENV: "production",
    },
    max_memory_restart: "500M",
    log_date_format: "YYYY-MM-DD HH:mm:ss",
    // Graceful shutdown: give the app time to call deleteWebhook + stop polling
    // Aguarda shutdown gracioso completo antes de reiniciar
    // deleteWebhook + 5s de espera + bot.stop() levam ~8s no total
    kill_timeout: 20000,
    // Aguarda 40s antes de iniciar o novo processo após restart/crash
    // Garante que o Telegram liberou a conexão getUpdates da instância anterior (TTL ~30s)
    restart_delay: 40000,
    wait_ready: false,
    listen_timeout: 10000,
  }]
};
