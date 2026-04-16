import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { createApp } from '../app.js';
import { createAppConfig } from '../config/app-config.js';

/**
 * Starts the API app on an ephemeral port for smoke testing.
 */
async function startTestServer() {
    const server = createApp().listen(0, '127.0.0.1');
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
        assert.deepEqual(payload.data.whatsapp.puppeteerArgs, ['--no-sandbox', '--disable-setuid-sandbox']);
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
