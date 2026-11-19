/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S489 (18/11/2026)
 *
 * O agendador respeita os cinco campos da expressão cron e não dispara fora de hora.
 *
 * ORIGEM: comparação com o OpenBot (ADR-041, 18/11/2026). Medido no código do main (947e2f1):
 * - `parseTimeInput` nunca aceitava uma expressão cron pronta: o teste `^[\d*\/,-]+$` não admite o espaço entre os
 *   campos. A expressão caía no leitor de horários, que tomava cada número como uma hora: `0 9 * * 1` (segunda, 9h)
 *   virava `0 0,1,9 * * *` (todo dia, 0h, 1h e 9h); `30 8 * * *` virava `0 8,30 * * *`.
 * - O leitor de horários ignorava as palavras: `toda segunda 9h` virava `0 9 * * *` (todo dia), sem aviso.
 * - `msUntilNext` só lia minuto e hora; dia do mês, mês e dia da semana eram ignorados. Expressão inválida ou sem hora
 *   numérica (`*\/15 * * * *`) virava "daqui a 1 minuto", isto é, disparo a cada minuto.
 * - O teto de 24 h do timer disparava a tarefa ao chegar nele, mesmo que a hora certa estivesse dias à frente.
 *
 * - Na instância isolada com modelo real (mesmo dia), o modelo chamou `schedule` com `frequency: "weekly"`,
 *   `day: "monday"` e `time: "09:00"`. Os campos fora do esquema eram ignorados sem aviso e a tarefa nascia diária.
 *
 * REGRESSÃO SE: uma expressão cron válida for gravada diferente do que foi pedido; algum dos cinco campos for ignorado
 * no cálculo do próximo disparo; texto com palavras for aceito como lista de horários; expressão inválida for agendada;
 * o teto do timer disparar a tarefa antes da hora; ou a ferramenta aceitar campo fora do esquema.
 *
 * Execução: npx ts-node src/__tests__/regression/S489_AgendadorRespeitaOsCincoCamposDoCron.test.ts
 */
import Database from 'better-sqlite3';
import { SchedulerService, proximoDisparo } from '../../services/SchedulerService';
import { ScheduleTool } from '../../tools/schedule_tool';

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string, detail?: unknown): void {
    if (cond) { console.log(`  ✅ ${msg}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${msg}`, detail ?? ''); failed++; }
}

/** Data local, mês de 1 a 12. */
const em = (ano: number, mes: number, dia: number, hora: number, min: number): Date => new Date(ano, mes - 1, dia, hora, min, 0, 0);
const texto = (d: Date | null): string => d === null ? 'null'
    : `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

async function main(): Promise<void> {
    console.log('\n🧪 S489 — agendador respeita os cinco campos do cron\n');
    const db = new Database(':memory:');
    const svc = new SchedulerService(':memory:', db);

    console.log('Expressão cron pronta é gravada como foi pedida');
    for (const cron of ['0 9 * * 1', '*/15 * * * *', '30 8 * * *', '0 8,12,18 * * *', '0 0 1 * *', '0 9-17/2 * * 1-5']) {
        const gravado = svc.parseTimeInput(cron);
        assert(gravado === cron, `"${cron}" gravado igual`, gravado);
    }
    assert(svc.parseTimeInput('  0   9 * *   1 ') === '0 9 * * 1', 'espaços extras são normalizados', svc.parseTimeInput('  0   9 * *   1 '));

    console.log('\nLista de horários vira cron diário');
    const listas: Array<[string, string]> = [
        ['8h, 12h, 18h', '0 8,12,18 * * *'],
        ['8:30', '30 8 * * *'],
        ['8h30', '30 8 * * *'],
        ['7:30 e 19:30', '30 7,19 * * *'],
        ['8 12 18', '0 8,12,18 * * *'],
    ];
    for (const [entrada, esperado] of listas) {
        const gravado = svc.parseTimeInput(entrada);
        assert(gravado === esperado, `"${entrada}" → "${esperado}"`, gravado);
    }

    console.log('\nO que não é horário nem cron é recusado (nada some sem aviso)');
    for (const entrada of ['toda segunda 9h', 'às 8h', '8:30, 12h', '25h', '8:61', '61 8 * * *', '0 24 * * *', '0 9 * * 8', '* * *', 'MON 9']) {
        const gravado = svc.parseTimeInput(entrada);
        assert(gravado === '', `"${entrada}" recusado`, gravado);
    }

    console.log('\nPróximo disparo respeita os cinco campos (a partir de qua 18/11/2026 13:30)');
    const agora = em(2026, 11, 18, 13, 30);
    const proximos: Array<[string, string]> = [
        ['0 9 * * 1', '23/11/2026 09:00'],      // segunda
        ['*/15 * * * *', '18/11/2026 13:45'],
        ['30 8 * * *', '19/11/2026 08:30'],
        ['0 8,12,18 * * *', '18/11/2026 18:00'],
        ['0 0 1 * *', '01/12/2026 00:00'],      // dia do mês
        ['0 12 * * 0', '22/11/2026 12:00'],     // domingo como 0
        ['0 12 * * 7', '22/11/2026 12:00'],     // domingo como 7
        ['0 9 13 * 5', '20/11/2026 09:00'],     // dia do mês OU dia da semana (regra do cron)
        ['0 9 * 3 *', '01/03/2027 09:00'],      // mês
        ['30 13 * * *', '19/11/2026 13:30'],    // a hora exata de agora não conta: é a próxima
        ['0 0 29 2 *', '29/02/2028 00:00'],     // ano bissexto
    ];
    for (const [cron, esperado] of proximos) {
        const obtido = texto(proximoDisparo(cron, agora));
        assert(obtido === esperado, `"${cron}" → ${esperado}`, obtido);
    }
    assert(proximoDisparo('0 9 31 2 *', agora) === null, '31 de fevereiro nunca acontece → null', texto(proximoDisparo('0 9 31 2 *', agora)));
    assert(proximoDisparo('* * *', agora) === null, 'expressão inválida → null');

    console.log('\nExpressão inválida não é agendada');
    {
        let erro = '';
        try { svc.createTask('chat_teste', 'inválida', '0 25 * * *', 'custom', '{}', 'web'); } catch (e) { erro = String(e); }
        assert(/0 25 \* \* \*/.test(erro), 'createTask recusa e diz qual expressão', erro);
        assert(svc.listTasks('chat_teste').length === 0, 'nada gravado', svc.listTasks('chat_teste'));
    }

    console.log('\nO teto do timer reavalia, não dispara antes da hora');
    {
        const original = global.setTimeout;
        const fila: Array<{ fn: () => unknown; ms: number }> = [];
        (global as unknown as { setTimeout: unknown }).setTimeout = ((fn: () => unknown, ms: number) => { fila.push({ fn, ms }); return fila.length as unknown as NodeJS.Timeout; });
        try {
            const db2 = new Database(':memory:');
            const s2 = new SchedulerService(':memory:', db2);
            const tresDias = 3 * 24 * 60 * 60 * 1000;
            (s2 as unknown as { msUntilNext: () => number }).msUntilNext = () => tresDias;
            let disparou = 0;
            s2.setTriggerHandler(async () => { disparou++; });
            s2.createTask('chat_teste', 'semanal', '0 9 * * 1', 'custom', '{}', 'web');
            const primeiro = fila.shift();
            assert(!!primeiro && primeiro.ms <= 24 * 60 * 60 * 1000, 'o timer respeita o teto de 24 h', primeiro?.ms);
            await primeiro?.fn();
            assert(disparou === 0, 'chegar ao teto não dispara a tarefa', disparou);
            assert(fila.length === 1, 'chegar ao teto agenda de novo', fila.length);

            // Tarefa antiga com expressão inválida no banco: o boot não a agenda.
            db2.prepare("INSERT INTO scheduled_tasks (chat_id, channel, label, cron_expr) VALUES ('chat_teste', 'web', 'antiga', '0 8,30 * * *')").run();
            const s3 = new SchedulerService(':memory:', db2);
            s3.setTriggerHandler(async () => { disparou++; });
            fila.length = 0;
            s3.startAll();
            assert(fila.length === 1, 'startAll agenda só a tarefa válida', fila.map(f => f.ms));
            db2.close();
        } finally {
            (global as unknown as { setTimeout: unknown }).setTimeout = original;
        }
    }

    console.log('\nAchados da revisão de 18/11/2026');
    {
        assert(svc.parseTimeInput(9 as unknown as string) === '0 9 * * *', 'time numérico (9) vira "0 9 * * *", sem TypeError', svc.parseTimeInput(9 as unknown as string));

        const db4 = new Database(':memory:');
        db4.exec("CREATE TABLE IF NOT EXISTS scheduled_tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT NOT NULL, channel TEXT NOT NULL DEFAULT 'telegram', label TEXT NOT NULL, cron_expr TEXT NOT NULL, action_type TEXT NOT NULL DEFAULT 'custom', action_params TEXT DEFAULT '{}', active INTEGER DEFAULT 0, last_run TEXT, created_at TEXT DEFAULT (datetime('now')))");
        db4.prepare("INSERT INTO scheduled_tasks (chat_id, label, cron_expr, active) VALUES ('chat_teste', 'antiga', '0 8,30 * * *', 0)").run();
        const s5 = new SchedulerService(':memory:', db4);
        let erro = '';
        try { s5.toggleTask(1, true); } catch (e) { erro = String(e); }
        assert(/0 8,30 \* \* \*/.test(erro), 'ativar tarefa com cron inválido é recusado e diz a expressão', erro);
        assert(Number(s5.getTask(1)?.active) === 0, 'e a tarefa continua desativada', s5.getTask(1)?.active);   // o SQLite devolve 0/1
        db4.close();

        // Disparo duplo: depois de disparar, o próximo é calculado depois do minuto que disparou, não de agora.
        const original = global.setTimeout;
        const fila: Array<{ fn: () => unknown; ms: number }> = [];
        (global as unknown as { setTimeout: unknown }).setTimeout = ((fn: () => unknown, ms: number) => { fila.push({ fn, ms }); return fila.length as unknown as NodeJS.Timeout; });
        try {
            const db5 = new Database(':memory:');
            const s6 = new SchedulerService(':memory:', db5);
            s6.setTriggerHandler(async () => { /* disparou */ });
            s6.createTask('chat_teste', 'todo minuto', '* * * * *', 'custom', '{}', 'web');
            const primeiro = fila.shift()!;
            await primeiro.fn(); // acorda "cedo": agora ainda é antes do minuto planejado
            const segundo = fila.shift();
            assert(!!segundo && segundo.ms >= 60_000, 'o próximo disparo fica um minuto depois do que disparou (sem repetir o mesmo minuto)', { primeiro: primeiro.ms, segundo: segundo?.ms });
            db5.close();
        } finally {
            (global as unknown as { setTimeout: unknown }).setTimeout = original;
        }
    }

    console.log('\nFerramenta recusa campo fora do esquema (caso real da instância isolada, 18/11/2026)');
    {
        const db3 = new Database(':memory:');
        const s4 = new SchedulerService(':memory:', db3);
        const ferramenta = new ScheduleTool(s4);
        ferramenta.setContext('chat_teste', 'web');
        const comExtras = await ferramenta.execute({ action: 'create', title: 'Revisar planejamento', frequency: 'weekly', day: 'monday', time: '09:00' });
        assert(!comExtras.success && /frequency/.test(comExtras.error ?? '') && /day/.test(comExtras.error ?? '') && /title/.test(comExtras.error ?? ''),
            'recusa e nomeia frequency, day e title', comExtras.error);
        assert(s4.listTasks('chat_teste').length === 0, 'nada criado com campo desconhecido', s4.listTasks('chat_teste'));
        const certo = await ferramenta.execute({ action: 'create', label: 'Revisar planejamento', time: '0 9 * * 1', type_action: 'custom' });
        const gravadas = s4.listTasks('chat_teste');
        assert(certo.success && gravadas.length === 1 && gravadas[0].cron_expr === '0 9 * * 1', 'com os campos do esquema, grava "0 9 * * 1"', { certo, gravadas });
        assert(/segundas/.test(certo.output), 'a saída diz "segundas"', certo.output);
        const recusada = await ferramenta.execute({ action: 'create', label: 'x', time: 'toda segunda 9h' });
        assert(!recusada.success && /0 9 \* \* 1/.test(recusada.error ?? ''), 'horário com palavras é recusado e a mensagem mostra o formato cron', recusada.error);
        s4.stopAll();
        db3.close();
    }

    console.log('\nDescrição em texto diz o dia');
    assert(/segunda/i.test(svc.describeCron('0 9 * * 1')), '"0 9 * * 1" fala de segunda', svc.describeCron('0 9 * * 1'));
    assert(/todo dia/i.test(svc.describeCron('30 8 * * *')) && /8h30/.test(svc.describeCron('30 8 * * *')), '"30 8 * * *" é 8h30 todo dia', svc.describeCron('30 8 * * *'));

    svc.stopAll();
    db.close();
    console.log(`\n${passed} passaram, ${failed} falharam\n`);
    if (failed > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
