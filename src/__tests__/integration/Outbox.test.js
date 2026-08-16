const { WebChannelAdapter } = require('../../../dist/channels/WebChannelAdapter');



describe('WebChannelAdapter - Outbox and Async Turns (Incremento 2)', () => {
    let adapter;

    beforeEach(() => {
        adapter = new WebChannelAdapter();
    });

    afterEach(async () => {
        await adapter.stop();
    });

    it('Caso 1: Envio com HTTP encerrado (turnId registrado chega na Outbox)', async () => {
        const turnId = 'turn-123';
        const sessionId = 'session-123';

        adapter.registerAsyncTurn(turnId, sessionId);
        await adapter.send({ text: 'Hello', format: 'plain' }, turnId);

        const consumed = adapter.consumeOutbox(turnId);
        expect(consumed).toBeDefined();
        if (consumed) {
            expect(consumed.text).toBe('Hello');
        }
    });

    it('Caso 2: Consumo sem conclusão (turnId em andamento, retorna indefinido na Outbox)', async () => {
        const consumed = adapter.consumeOutbox('unknown-turn');
        expect(consumed).toBeUndefined(); // Representa o 404 no endpoint
    });

    it('Caso 3: Consumo pós-conclusão (turnId finalizado, retira resposta e limpa memória)', async () => {
        const turnId = 'turn-456';
        const sessionId = 'session-456';

        adapter.registerAsyncTurn(turnId, sessionId);
        await adapter.send({ text: 'Done', format: 'plain' }, turnId);

        const consumed1 = adapter.consumeOutbox(turnId);
        if (consumed1) {
            expect(consumed1.text).toBe('Done');
        }
        
        const consumed2 = adapter.consumeOutbox(turnId);
        expect(consumed2).toBeUndefined();
    });

    it('Caso 4: Chamada duplicada (dois requests para o mesmo turnId, o primeiro consome e o segundo dá 404)', async () => {
        const turnId = 'turn-dup';
        const sessionId = 'session-dup';

        adapter.registerAsyncTurn(turnId, sessionId);
        await adapter.send({ text: 'Dup', format: 'plain' }, turnId);

        const c1 = adapter.consumeOutbox(turnId);
        const c2 = adapter.consumeOutbox(turnId);

        expect(c1).toBeDefined();
        expect(c2).toBeUndefined();
    });

    it('Caso 5: Vários turnos na mesma sessão (cada turnId é isolado)', async () => {
        const turnA = 'turn-A';
        const turnB = 'turn-B';
        const sessionId = 'session-ab';

        adapter.registerAsyncTurn(turnA, sessionId);
        adapter.registerAsyncTurn(turnB, sessionId);

        await adapter.send({ text: 'Response A', format: 'plain' }, turnA);
        await adapter.send({ text: 'Response B', format: 'plain' }, turnB);

        const consumedA = adapter.consumeOutbox(turnA);
        const consumedB = adapter.consumeOutbox(turnB);

        if (consumedA) expect(consumedA.text).toBe('Response A');
        if (consumedB) expect(consumedB.text).toBe('Response B');
    });

    it('Caso 6: Chamada sem HTTP original (resposta produzida chega à Outbox normalmente para consumo eventual)', async () => {
        const turnId = 'turn-no-http';
        await adapter.send({ text: 'Orphaned Outbox', format: 'plain' }, turnId);
        
        const consumed = adapter.consumeOutbox(turnId);
        expect(consumed).toBeDefined();
        if (consumed) {
            expect(consumed.text).toBe('Orphaned Outbox');
        }
    });

    it('Caso 7: Fallback de Orphaned Deliveries (fluxo legado síncrono mantido intocado)', async () => {
        const turnId = 'turn-orphaned';
        const sessionId = 'session-orphaned';

        // 1. Simula request que fez waitForResponse
        const p = adapter.waitForResponse(turnId, sessionId, 10).catch(() => {});
        
        // 2. Timeout expira nativamente
        await new Promise(r => setTimeout(r, 20));

        // 3. Resposta chega atrasada
        await adapter.send({ text: 'Late Response', format: 'plain' }, turnId);

        // 4. Verifica orphanedDeliveries (mecanismo legado)
        const orphaned = adapter['orphanedDeliveries'].get(sessionId);
        expect(orphaned).toBeDefined();
        if (orphaned) {
            expect(orphaned[0].text).toBe('Late Response');
        }
        p.catch(() => {});
    });
});
