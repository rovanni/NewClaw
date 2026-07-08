/// <reference types="node" />
import assert from 'assert';
import { PowerPointBroker } from '../../src/dashboard/routes/powerpointBroker';

async function runTests() {
    console.log('Testing PowerPointBroker...');
    const broker = new PowerPointBroker();

    // Test 1: dispatch -> poll -> executed
    console.log('Test 1: dispatch -> poll -> executed');
    let dispatchPromise = broker.dispatch('session-1', 'addTextBox', { text: 'hello' });
    let cmd = broker.poll('session-1');
    assert.ok(cmd);
    assert.strictEqual(cmd!.action, 'addTextBox');
    assert.strictEqual(cmd!.args.text, 'hello');
    
    let ackResult = broker.ack(cmd!.commandId, 'session-1', 'executed');
    assert.deepStrictEqual(ackResult, {});
    let res = await dispatchPromise;
    assert.strictEqual(res.success, true);
    console.log('  [PASS] executed');

    // Test 2: dispatch -> poll -> failed
    console.log('Test 2: dispatch -> poll -> failed');
    dispatchPromise = broker.dispatch('session-1', 'addTextBox', { text: 'hello2' });
    cmd = broker.poll('session-1');
    assert.ok(cmd);
    ackResult = broker.ack(cmd!.commandId, 'session-1', 'failed', 'API error');
    res = await dispatchPromise;
    assert.strictEqual(res.success, false);
    assert.ok(res.output.includes('API error'));
    console.log('  [PASS] failed');

    // Test 3: unknown commandId
    console.log('Test 3: unknown commandId');
    ackResult = broker.ack('fake-id', 'session-1', 'executed');
    assert.ok(ackResult.error);
    assert.ok(ackResult.error!.includes('Unknown'));
    console.log('  [PASS] unknown commandId -> error');

    // Test 4: duplicate result
    console.log('Test 4: duplicate result');
    dispatchPromise = broker.dispatch('session-2', 'addTextBox', { text: 'dup' });
    cmd = broker.poll('session-2');
    assert.ok(cmd);
    broker.ack(cmd!.commandId, 'session-2', 'executed');
    await dispatchPromise; // wait first
    ackResult = broker.ack(cmd!.commandId, 'session-2', 'executed');
    assert.ok(ackResult.error);
    assert.ok(ackResult.error!.includes('Unknown'));
    console.log('  [PASS] duplicate result -> rejected (treated as unknown)');

    // Test 5: session mismatch
    console.log('Test 5: session mismatch');
    dispatchPromise = broker.dispatch('session-3', 'addTextBox', { text: 'mismatch' });
    cmd = broker.poll('session-3');
    assert.ok(cmd);
    ackResult = broker.ack(cmd!.commandId, 'session-4-wrong', 'executed');
    assert.ok(ackResult.error);
    assert.ok(ackResult.error!.includes('Session mismatch'));
    broker.ack(cmd!.commandId, 'session-3', 'executed'); // finish properly
    await dispatchPromise;
    console.log('  [PASS] session mismatch -> rejected');

    // Test 6: poll isolated by sessionId
    console.log('Test 6: poll isolated by sessionId');
    let dp1 = broker.dispatch('session-A', 'addTextBox', { text: 'A' });
    let dp2 = broker.dispatch('session-B', 'addTextBox', { text: 'B' });
    let cmdB = broker.poll('session-B');
    assert.ok(cmdB);
    assert.strictEqual(cmdB!.args.text, 'B');
    let cmdA = broker.poll('session-A');
    assert.ok(cmdA);
    assert.strictEqual(cmdA!.args.text, 'A');
    broker.ack(cmdA!.commandId, 'session-A', 'executed');
    broker.ack(cmdB!.commandId, 'session-B', 'executed');
    await dp1; await dp2;
    console.log('  [PASS] poll isolates by sessionId');

    // Test 7: timeout -> cleanup
    console.log('Test 7: timeout -> cleanup');
    dispatchPromise = broker.dispatch('session-timeout', 'addTextBox', { text: 'timeout' }, 100);
    // wait for timeout
    await new Promise(r => setTimeout(r, 150));
    // poll should be empty
    assert.strictEqual(broker.poll('session-timeout'), null);
    res = await dispatchPromise;
    assert.strictEqual(res.success, false);
    assert.ok(res.output.includes('Timeout'));
    console.log('  [PASS] timeout cleans up correctly');

    console.log('All tests passed!');
}

runTests().catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
});
