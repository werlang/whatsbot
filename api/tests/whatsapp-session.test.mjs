import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { createApp } from "../app.js";

/**
 * Starts the API app on an ephemeral port for route testing.
 */
async function startTestServer(options = {}) {
    const server = createApp(options).listen(0, "127.0.0.1");
    await once(server, "listening");
    return server;
}

/**
 * Closes a Node HTTP server and waits for shutdown completion.
 */
async function stopTestServer(server) {
    await new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
    });
}

test("GET /whatsapp/session returns the stable session envelope", async () => {
    const whatsappClient = {
        getSessionState() {
            return {
                clientId: "main",
                status: "qr",
                ready: false,
                authenticated: false,
                hasQrCode: true,
                qrCodeDataUrl: "data:image/png;base64,abc123",
                qrCodeUpdatedAt: "2026-04-15T12:00:00.000Z",
                connectionState: "OPENING",
                loading: {
                    percent: 42,
                    message: "Booting",
                },
                clientInfo: null,
                lastError: null,
                lastEventAt: "2026-04-15T12:00:00.000Z",
                disconnectReason: null,
            };
        },
    };
    const server = await startTestServer({ whatsappClient });
    const { port } = server.address();

    try {
        const response = await fetch(`http://127.0.0.1:${port}/whatsapp/session`);
        const payload = await response.json();

        assert.equal(response.status, 200);
        assert.equal(payload.error, false);
        assert.equal(payload.data.session.status, "qr");
        assert.equal(payload.data.session.hasQrCode, true);
        assert.match(payload.data.session.qrCodeDataUrl, /^data:image\/png;base64,/);
        assert.equal(payload.data.session.loading.percent, 42);
    } finally {
        await stopTestServer(server);
    }
});
