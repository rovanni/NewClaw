/**
 * localRuntimeState — o que se sabe sobre o servidor de modelo local, para quem precisa decidir
 * algo a respeito dele.
 *
 * Origem: `docs/decisoes/ADR-006_ONDE_VIVE_O_CICLO_DE_VIDA_DO_RUNTIME_LOCAL.md`. Este módulo é a
 * metade de **diagnóstico** do ciclo de vida do runtime local, que antes vivia inteira em
 * `src/dashboard/routes/models.ts`. A metade de **atuação** (spawn, kill, adoção, descoberta do
 * binário) permanece lá, deliberadamente:
 *
 *   > O Core pode SABER o estado de um runtime local. Não pode MUDÁ-LO.
 *
 * Isso não é organização de arquivos: é o que transforma a `ADR-002` §2.3 ("o NewClaw nunca religa
 * o modelo sozinho") de política em garantia estrutural. A camada com o maior motivo para religar o
 * modelo — um provider cuja requisição acabou de falhar — não tem, daqui, como fazê-lo.
 *
 * Contrato herdado de `getLastKnownLocalServer()`: leitura barata e síncrona, **sem I/O de rede**.
 * O dashboard chama isto no caminho de polling.
 */

import * as fs from 'fs';
import * as path from 'path';

/**
 * Onde o estado do servidor local é anotado entre reinícios do NewClaw. Fica em ./data (mesma base
 * do banco), que já é por instância — duas instâncias isoladas não se confundem.
 *
 * O caminho mora aqui, e não na rota, para que exista **um** lugar que sabe onde o registro está.
 * Duplicá-lo entre quem lê (Core) e quem escreve (dashboard) é a alternativa D da `ADR-006`, e foi
 * descartada justamente por criar duas fontes de verdade para o mesmo arquivo.
 */
export const LOCAL_RUNTIME_STATE_FILE = path.join(process.cwd(), 'data', 'local-model-server.json');

/** O que o registro guarda. Escrito pelo dashboard, lido por aqui. */
export interface LocalRuntimeRecord {
    pid?: number;
    file: string;
    port: number;
    startedAt?: number;
}

/**
 * Resultado da leitura do registro. As três variantes existem porque "não há registro" e "há
 * registro que não consegui ler" **não** são a mesma coisa, e a taxonomia da `RFC-005` depende
 * dessa distinção: a primeira significa ausência de gerenciamento (comportamento de hoje), a
 * segunda significa indeterminação (`NUNCA_ADIVINHAR.md`).
 *
 * A versão anterior desta leitura devolvia `null` para os dois casos — era impossível distingui-los.
 */
export type LocalRuntimeRead =
    | { kind: 'absent' }
    | { kind: 'record'; record: LocalRuntimeRecord }
    | { kind: 'unreadable'; reason: string };

export function readLocalRuntimeRecord(): LocalRuntimeRead {
    let raw: string;
    try {
        raw = fs.readFileSync(LOCAL_RUNTIME_STATE_FILE, 'utf-8');
    } catch (err) {
        // ENOENT é o caso normal e esperado: ninguém carregou modelo local nesta instância.
        if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return { kind: 'absent' };
        return { kind: 'unreadable', reason: (err as Error)?.message ?? 'erro de leitura' };
    }
    try {
        const parsed = JSON.parse(raw) as LocalRuntimeRecord;
        // Registro sem porta não serve para casar com provider nenhum — é tão inútil quanto
        // ilegível, e dizer isso é mais honesto do que devolvê-lo pela metade.
        if (!parsed || typeof parsed.port !== 'number') {
            return { kind: 'unreadable', reason: 'registro sem porta utilizável' };
        }
        return { kind: 'record', record: parsed };
    } catch (err) {
        return { kind: 'unreadable', reason: (err as Error)?.message ?? 'JSON inválido' };
    }
}

/**
 * O processo existe? `sinal 0` não encerra nada — só testa existência.
 *
 * `EPERM` significa que o processo EXISTE e pertence a outro usuário; tratá-lo como morto faria um
 * runtime vivo ser classificado como parado, e uma falha real deixaria de contar. A leitura
 * anterior (`catch { return false }`) confundia os dois casos.
 */
export function isPidAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return (err as NodeJS.ErrnoException)?.code === 'EPERM';
    }
}

/**
 * Estado do ciclo de vida do runtime que atende uma porta — **fato**, não decisão.
 *
 * Deliberadamente não devolve os estados da taxonomia da `RFC-005` (`avariado` etc.): "avariado"
 * exige saber que uma requisição falhou, e isso quem sabe é quem a fez. Este módulo entrega o que
 * observou; a classificação final é de quem sofreu a falha (`EVIDENCE_PROVIDER_PATTERN.md`).
 */
export type LocalRuntimeLifecycle =
    /** Nenhum registro, ou registro de outra porta: este endpoint não é gerenciado pelo NewClaw. */
    | 'nao_gerenciado'
    /** Registro presente para esta porta e processo vivo. */
    | 'em_execucao'
    /** Registro presente para esta porta e processo morto — ninguém religou, e o NewClaw não religa. */
    | 'parado'
    /** Há registro, mas não foi possível lê-lo. Nunca inferir a partir daqui. */
    | 'indeterminado';

export function getLocalRuntimeLifecycle(port: number): LocalRuntimeLifecycle {
    const read = readLocalRuntimeRecord();
    if (read.kind === 'absent') return 'nao_gerenciado';
    if (read.kind === 'unreadable') return 'indeterminado';
    if (read.record.port !== port) return 'nao_gerenciado';
    // Registro sem PID: o servidor foi anotado mas não se sabe qual processo o atende. Não dá para
    // afirmar que está de pé nem que está parado.
    if (typeof read.record.pid !== 'number') return 'indeterminado';
    return isPidAlive(read.record.pid) ? 'em_execucao' : 'parado';
}

/**
 * Último modelo local que o usuário mandou carregar, esteja ele no ar ou não.
 *
 * Serve para o dashboard poder dizer "o modelo X não está carregado — carregar agora?" depois de
 * um reinício da máquina, em vez de deixar o provedor padrão apontando para uma porta muda (foi
 * exatamente a falha vivida em 02/08/2026). Deliberadamente NÃO religa nada sozinho: o servidor
 * ocupa a GPU, e alguém que reiniciou o computador para jogar não quer o modelo subindo por conta
 * própria (`ADR-002` §2.3).
 *
 * `running` é a resposta verificada para "esse modelo está no ar AGORA?" — antes, quem consumia
 * este registro recebia só {file, port} e não tinha como distinguir "escolhido e rodando" de
 * "escolhido há horas, processo morto". Em 02/08/2026 o arquivo apontava pid 45736 / GLM-4.6V com
 * o processo inexistente e ninguém na porta; a tela apresentava isso ao lado de um "Modelo padrão"
 * diferente, e nada dizia qual dos dois era real.
 *
 * Só checagem de PID: barata e síncrona, segura no caminho do polling do dashboard. Um PID vivo não
 * garante que a porta responde — quem precisa dessa garantia usa `adoptRunningServer()` (na rota),
 * que checa os dois.
 */
export function getLastKnownLocalServer(): { file: string; port: number; running: boolean } | null {
    const read = readLocalRuntimeRecord();
    if (read.kind !== 'record') return null;
    const { file, port, pid } = read.record;
    return { file, port, running: typeof pid === 'number' ? isPidAlive(pid) : false };
}
