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

const arquivo = process.env.NC_TIMING_FILE;
if (arquivo) {
    delete process.env.NC_TIMING_FILE;
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
            }));
        } catch { /* observar nunca derruba o teste */ }
    });
}
