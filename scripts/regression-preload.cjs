/**
 * Pré-carregamento (`--require`) usado SÓ pelo runner de regressão para medir, de dentro do processo do teste, quanto tempo
 * passou até a PRIMEIRA saída (aproximação do custo de inicialização: boot do Node + compilação do ts-node + importações do
 * topo do arquivo) e quanto o processo durou até sair. Não altera a semântica do teste: só observa.
 *
 * - Escreve um JSON em `NC_TIMING_FILE` na saída do processo e só no processo do próprio teste: restaura `NODE_OPTIONS` e apaga
 *   a variável logo no início, para que subprocessos do teste não herdem este hook nem sobrescrevam o arquivo.
 * - Se o teste for morto (timeout), nada é escrito: o runner sabe que a divisão início/corpo é desconhecida.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const arquivo = process.env.NC_TIMING_FILE;
if (arquivo) {
    delete process.env.NC_TIMING_FILE;
    // `--mapa-de-leituras` do runner: anota os arquivos DO REPOSITÓRIO que este processo lê — módulos carregados (o carregador e o
    // ts-node leem pelo mesmo fs.readFileSync, inclusive o que só a checagem de tipos consulta) e arquivos abertos como texto. É a
    // verdade medida contra a qual a seleção por módulo (scripts/testes-afetados.cjs) é conferida. Só observa.
    const lidos = process.env.NC_REGISTRAR_LEITURAS === '1' ? new Set() : null;
    delete process.env.NC_REGISTRAR_LEITURAS;
    if (lidos) {
        const raiz = path.resolve(__dirname, '..');
        const anotar = (p) => {
            try {
                const bruto = p instanceof URL ? require('url').fileURLToPath(p) : p;
                if (typeof bruto !== 'string') return;
                const abs = path.resolve(bruto);
                if (abs.startsWith(raiz + path.sep) && !abs.includes(`${path.sep}node_modules${path.sep}`)) {
                    lidos.add(path.relative(raiz, abs).split(path.sep).join('/'));
                }
            } catch { /* observar nunca derruba o teste */ }
        };
        for (const nome of ['readFileSync', 'readFile']) {
            const original = fs[nome];
            fs[nome] = function (p, ...resto) { anotar(p); return original.call(this, p, ...resto); };
        }
        const originalP = fs.promises.readFile;
        fs.promises.readFile = function (p, ...resto) { anotar(p); return originalP.call(this, p, ...resto); };
    }
    if (process.env.NC_ORIG_NODE_OPTIONS !== undefined) {
        if (process.env.NC_ORIG_NODE_OPTIONS === '') delete process.env.NODE_OPTIONS;
        else process.env.NODE_OPTIONS = process.env.NC_ORIG_NODE_OPTIONS;
        delete process.env.NC_ORIG_NODE_OPTIONS;
    }
    const origem = performance.timeOrigin;
    let primeiraSaidaMs = null;
    const marcar = (stream) => {
        const original = stream.write.bind(stream);
        stream.write = (...args) => {
            if (primeiraSaidaMs === null) primeiraSaidaMs = Date.now() - origem;
            return original(...args);
        };
    };
    marcar(process.stdout);
    marcar(process.stderr);
    process.on('exit', () => {
        try {
            fs.writeFileSync(arquivo, JSON.stringify({
                primeiraSaidaMs,
                saidaMs: Date.now() - origem,
                rssMB: Math.round(process.memoryUsage().rss / 1048576),
                ...(lidos ? { leituras: [...lidos].sort() } : {}),
            }));
        } catch { /* observar nunca derruba o teste */ }
    });
}
