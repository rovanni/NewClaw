import express from 'express';
import { createIntegrationsRouter } from '../../src/dashboard/routes/integrations';
import { dashboardAuth } from '../../src/dashboard/routes/auth';
import assert from 'assert';
import cookieParser from 'cookie-parser';

// Mock auth para testes
dashboardAuth.enabled = true;

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use('/api/integrations', createIntegrationsRouter({} as any));

let server: any;
let port: number;

async function runTests() {
    server = app.listen(0, async () => {
        port = server.address().port;
        console.log(`Test server running on port ${port}`);
        try {
            await testSuite();
            console.log('All tests passed!');
            process.exit(0);
        } catch (err) {
            console.error('Test failed:', err);
            process.exit(1);
        }
    });
}

async function fetchApi(path: string, method = 'GET', body?: any, token = 'no-auth-required'): Promise<{status: number, data: any}> {
    const res = await fetch(`http://localhost:${port}${path}`, {
        method,
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
        },
        body: body ? JSON.stringify(body) : undefined
    });
    const data = await res.json().catch(() => null);
    return { status: res.status, data };
}

async function testSuite() {
    const isWin = process.platform === 'win32';

    // 1. POST /install/powerpoint
    console.log('Testing POST /install/powerpoint...');
    const postRes = await fetchApi('/api/integrations/install/powerpoint', 'POST', null, 'valid-token');
    
    if (!isWin) {
        // Se não for Windows, deve bloquear com 400
        assert.strictEqual(postRes.status, 400);
        console.log('  [PASS] Bloqueou não-Windows corretamente.');
        return; // Pula os outros testes em Linux/macOS
    }

    assert.strictEqual(postRes.status, 202);
    assert.strictEqual(postRes.data.success, true);
    assert.strictEqual(postRes.data.status, 'running');
    const jobId = postRes.data.jobId;
    assert.ok(jobId);
    console.log('  [PASS] Retornou 202 com jobId.');

    // 2. Concorrência (deve retornar 409)
    console.log('Testing Concorrência...');
    const postRes2 = await fetchApi('/api/integrations/install/powerpoint', 'POST', null, 'valid-token');
    assert.strictEqual(postRes2.status, 409);
    console.log('  [PASS] Retornou 409 para job simultâneo.');

    // 3. GET /status/:jobId (Owner Correto)
    console.log('Testing GET status (Owner correto)...');
    const getRes = await fetchApi(`/api/integrations/install/powerpoint/status/${jobId}`, 'GET', null, 'valid-token');
    assert.strictEqual(getRes.status, 200);
    assert.ok(['running', 'succeeded', 'failed'].includes(getRes.data.status));
    console.log(`  [PASS] Status retornado: ${getRes.data.status}`);

    // 4. GET /status/:jobId (Owner Incorreto)
    console.log('Testing GET status (Owner incorreto)...');
    const getResWrongOwner = await fetchApi(`/api/integrations/install/powerpoint/status/${jobId}`, 'GET', null, 'wrong-token');
    assert.strictEqual(getResWrongOwner.status, 403);
    console.log('  [PASS] Retornou 403 para dono incorreto.');

    // 5. GET /status/:jobId (Job inexistente)
    console.log('Testing GET status (Job inexistente)...');
    const getResNoJob = await fetchApi(`/api/integrations/install/powerpoint/status/fake-uuid-1234`, 'GET', null, 'valid-token');
    assert.strictEqual(getResNoJob.status, 404);
    console.log('  [PASS] Retornou 404 para job inexistente.');
}

runTests();
