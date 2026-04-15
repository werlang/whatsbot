import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { createApp } from '../app.js';

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
