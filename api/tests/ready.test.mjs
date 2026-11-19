import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { createApp } from '../app.js';
import { Mysql } from '../helpers/mysql.js';
import { MessageDispatcher } from '../background/message-dispatcher.js';
import { createAppConfig } from '../config/app-config.js';

/**
 * Starts the API app on an ephemeral port for smoke testing.
 */
async function startTestServer(options = {}) {
    const server = createApp({
        mysqlDriver: { async probe() {} },
        whatsappClient: { getReadySessionIds: () => ['alpha'] },
        ...options,
    }).listen(0, '127.0.0.1');
    await once(server, 'listening');
    return server;
}

/**
 * Closes a Node HTTP server and waits for shutdown completion.
 */
async function stopTestServer(server) {
    await new Promise((resolve, reject) => {
        server.close(err => err ? reject(err) : resolve());
    });
}

test('GET /ready returns the success envelope and WhatsApp bootstrap config', async () => {
    const server = await startTestServer();
    const { port } = server.address();

    try {
        const response = await fetch(`http://127.0.0.1:${port}/ready`);
        const payload = await response.json();

        assert.equal(response.status, 200);
        assert.equal(payload.error, false);
        assert.equal(payload.data.ready, true);
        assert.equal(payload.data.service, 'api');
        assert.equal(payload.data.whatsapp.authPath, '/whatsapp/auth');
    } finally {
        await stopTestServer(server);
    }
});

test('createAppConfig exposes API host and port defaults used by startup', () => {
    const runtimeConfig = createAppConfig({});

    assert.equal(runtimeConfig.host, '0.0.0.0');
    assert.equal(runtimeConfig.port, 3000);
});

test('createAppConfig reads API host and port overrides from the environment', () => {
    const runtimeConfig = createAppConfig({
        API_HOST: '127.0.0.1',
        API_PORT: '4321',
    });

    assert.equal(runtimeConfig.host, '127.0.0.1');
    assert.equal(runtimeConfig.port, 4321);
});

test('createAppConfig falls back to the default API port when the environment value is invalid', () => {
    const runtimeConfig = createAppConfig({
        API_PORT: 'not-a-number',
    });

    assert.equal(runtimeConfig.host, '0.0.0.0');
    assert.equal(runtimeConfig.port, 3000);
});

test('createAppConfig falls back to the default API port when the numeric value is out of range', () => {
    const negativePortConfig = createAppConfig({
        API_PORT: '-1',
    });
    const oversizedPortConfig = createAppConfig({
        API_PORT: '70000',
    });

    assert.equal(negativePortConfig.port, 3000);
    assert.equal(oversizedPortConfig.port, 3000);
});

/**
 * Reads readiness from an isolated app and always closes its HTTP listener.
 */
async function readReadiness(options) {
    const server = await startTestServer(options);
    try {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/ready`);
        assert.equal(response.status, 200);
        return (await response.json()).data;
    } finally {
        await stopTestServer(server);
    }
}

test('GET /ready reports database failure without a stale success', async () => {
    let failed = false;
    let probes = 0;
    const mysqlDriver = { async probe() { probes++; if (failed) throw new Error('Database unavailable'); } };
    const server = await startTestServer({ mysqlDriver });
    const url = `http://127.0.0.1:${server.address().port}/ready`;
    try {
        assert.equal((await (await fetch(url)).json()).data.ready, true);
        failed = true;
        const response = await fetch(url);
        assert.equal(response.status, 200);
        const { data } = await response.json();
        assert.equal(data.ready, false);
        assert.equal(data.database.ready, false);
        assert.equal(data.database.error, 'Database unavailable');
        assert.ok(data.reasons.includes('Database unavailable'));
        assert.equal(probes, 2);
    } finally {
        await stopTestServer(server);
    }
});

test('GET /ready reports no send-capable session', async () => {
    const data = await readReadiness({ whatsappClient: { getReadySessionIds: () => [] } });
    assert.equal(data.ready, false);
    assert.equal(data.database.ready, true);
    assert.deepEqual(data.whatsapp.readySessionIds, []);
    assert.ok(data.reasons.includes('No WhatsApp session is ready to send.'));
});

test('GET /ready reports the fully healthy database and ready sessions', async () => {
    const data = await readReadiness();
    assert.equal(data.ready, true);
    assert.deepEqual(data.database, { ready: true, error: null });
    assert.deepEqual(data.whatsapp.readySessionIds, ['alpha']);
    assert.deepEqual(data.reasons, []);
});

test('GET /ready exposes a dispatcher claim failure and its recovery without stacks', async () => {
    let failed = true;
    const dispatcher = new MessageDispatcher({
        scheduledMessageModel: { async claimDue() { if (failed) throw new Error('Claim failed'); return []; } },
        whatsappClient: { getReadySessionIds: () => ['alpha'] },
        logger: { error() {} },
    });
    await assert.rejects(dispatcher.tick(), /Claim failed/);
    const data = await readReadiness({ dispatcher });
    assert.equal(data.scheduler.lastError, 'Claim failed');
    assert.ok(data.scheduler.lastErrorAt);
    assert.ok(data.scheduler.lastTickAt);
    assert.equal(data.scheduler.dispatchedCount, 0);
    assert.equal(JSON.stringify(data).includes('stack'), false);
    failed = false;
    await dispatcher.tick();
    const recovered = await readReadiness({ dispatcher });
    assert.equal(recovered.scheduler.lastError, null);
    assert.equal(recovered.scheduler.lastErrorAt, null);
});

test('Mysql.probe bounds a hung database operation', async t => {
    t.mock.method(Mysql, 'connect', async () => Mysql);
    const originalConnection = Mysql.connection;
    Mysql.connection = { execute: () => new Promise(() => {}) };
    t.after(() => { Mysql.connection = originalConnection; });
    await assert.rejects(Mysql.probe({ timeoutMs: 20 }), /Database probe timed out/);
});

test('Mysql.probe checks connectivity and required tables on every call', async t => {
    const statements = [];
    t.mock.method(Mysql, 'connect', async () => Mysql);
    const originalConnection = Mysql.connection;
    Mysql.connection = { async execute(sql) { statements.push(sql); return [[]]; } };
    t.after(() => { Mysql.connection = originalConnection; });
    await Mysql.probe();
    await Mysql.probe();
    assert.deepEqual(statements, [
        'SELECT 1', 'SELECT id FROM scheduled_messages LIMIT 0',
        'SELECT session_id FROM whatsapp_session_access LIMIT 0',
        'SELECT 1', 'SELECT id FROM scheduled_messages LIMIT 0',
        'SELECT session_id FROM whatsapp_session_access LIMIT 0',
    ]);
});

test('GET /ready rejects a reachable database with missing application tables', async t => {
    t.mock.method(Mysql, 'connect', async () => Mysql);
    const originalConnection = Mysql.connection;
    Mysql.connection = { async execute(sql) {
        if (sql !== 'SELECT 1') throw new Error("Table does not exist");
        return [[{ 1: 1 }]];
    } };
    t.after(() => { Mysql.connection = originalConnection; });
    const data = await readReadiness({ mysqlDriver: Mysql });
    assert.equal(data.ready, false);
    assert.equal(data.database.ready, false);
    assert.match(data.database.error, /Table does not exist/);
});


test('Mysql.probe bounds pool setup before a query can start', async t => {
    t.mock.method(Mysql, 'connect', () => new Promise(() => {}));
    await assert.rejects(Mysql.probe({ timeoutMs: 20 }), /Database probe timed out/);
});

test('GET /ready returns an explicit timeout for a hung database', async t => {
    t.mock.method(Mysql, 'connect', () => new Promise(() => {}));
    const data = await readReadiness({ mysqlDriver: Mysql });
    assert.equal(data.ready, false);
    assert.equal(data.database.ready, false);
    assert.equal(data.database.error, 'Database probe timed out.');
    assert.ok(data.reasons.includes('Database probe timed out.'));
});
