/**
 * Servidor estático HTTPS para o bundle de produção (dist/) do suplemento newclaw.
 * Existe porque o manifest.xml aponta para https://localhost:3000 sempre — em dev isso
 * é o webpack-dev-server; em uso normal (fora do terminal) é este processo, gerenciado
 * pelo PM2 via install.ps1, usando os mesmos certificados do office-addin-dev-certs.
 */
const https = require("https");
const fs = require("fs");
const path = require("path");
const devCerts = require("office-addin-dev-certs");

const PORT = process.env.PORT || 3000;
const DIST_DIR = path.join(__dirname, "dist");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".map": "application/json",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function requestHandler(req, res) {
  const urlPath = decodeURIComponent(req.url.split("?")[0]);
  const requested = path.join(DIST_DIR, urlPath === "/" ? "/taskpane.html" : urlPath);
  const relative = path.relative(DIST_DIR, requested);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(requested, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": MIME_TYPES[path.extname(requested)] || "application/octet-stream" });
    res.end(data);
  });
}

devCerts
  .getHttpsServerOptions()
  .then((options) => {
    https.createServer(options, requestHandler).listen(PORT, () => {
      console.log(`newclaw-powerpoint-addin servindo ${DIST_DIR} em https://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error("Não foi possível carregar os certificados de desenvolvimento:", err);
    process.exit(1);
  });
