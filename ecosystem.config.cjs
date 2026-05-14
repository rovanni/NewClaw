module.exports = {
  apps: [{
    name: "newclaw",
    script: "./dist/index.js",
    cwd: "/home/venus/newclaw",
    node_args: "--max-old-space-size=256",
    env: {
      NODE_ENV: "production",
    },
    max_memory_restart: "500M",
    log_date_format: "YYYY-MM-DD HH:mm:ss",
    // Graceful shutdown: give the app time to call deleteWebhook + stop polling
    kill_timeout: 15000,
    wait_ready: false,
    listen_timeout: 10000,
  }]
};
