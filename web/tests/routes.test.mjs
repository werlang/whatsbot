import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { createApp } from "../app.js";

/**
 * Starts the web app on an ephemeral port for smoke testing.
 */
async function startTestServer() {
    const server = createApp().listen(0, "127.0.0.1");
    await once(server, "listening");
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

test("GET / renders the routing gateway", async () => {
    const server = await startTestServer();
    const { port } = server.address();

    try {
        const response = await fetch("http://127.0.0.1:" + port + "/");
        const body = await response.text();

        assert.equal(response.status, 200);
        assert.match(body, /Opening\.\.\./);
        assert.match(body, /js\/root\.js/);
        assert.match(body, /Open login/);
    } finally {
        await stopTestServer(server);
    }
});

test("GET /session/main renders the scheduler UI shell", async () => {
    const server = await startTestServer();
    const { port } = server.address();

    try {
        const response = await fetch("http://127.0.0.1:" + port + "/session/main");
        const body = await response.text();

        assert.equal(response.status, 200);
        assert.match(body, /Plan a message\./);
        assert.match(body, /id="schedule-form"/);
        assert.match(body, /id="recipient-picker"/);
        assert.match(body, /id="phone-number"/);
        assert.match(body, /id="message"/);
        assert.match(body, /id="scheduled-for"/);
        assert.match(body, /data-role="schedule-form-kicker"/);
        assert.match(body, /data-role="schedule-cancel-edit"/);
        assert.match(body, /Connection/);
        assert.match(body, /id="session-status"/);
        assert.match(body, /Scheduled messages/);
        assert.match(body, /data-role="schedule-list"/);
        assert.match(body, /data-role="schedule-refresh"/);
        assert.match(body, /data-role="session-progress-body"/);
        assert.match(body, /data-role="session-check-now"/);
        assert.match(body, /Schedule/);
    } finally {
        await stopTestServer(server);
    }
});

test("GET /login renders the session pairing flow", async () => {
    const server = await startTestServer();
    const { port } = server.address();

    try {
        const response = await fetch("http://127.0.0.1:" + port + "/login");
        const body = await response.text();

        assert.equal(response.status, 200);
        assert.match(body, /Connect WhatsApp\./);
        assert.match(body, /id="create-session-button"/);
        assert.match(body, /id="existing-session-password"/);
        assert.match(body, /id="login-existing-session-button"/);
        assert.match(body, /id="session-secret-dialog"/);
        assert.match(body, /data-role="session-secret-send-now"/);
        assert.match(body, /Save this code/);
        assert.match(body, /Connection/);
        assert.match(body, /id="session-status"/);
        assert.match(body, /data-role="session-check-now"/);
        assert.match(body, /data-role="session-progress-body"/);
    } finally {
        await stopTestServer(server);
    }
});

test("GET /session/:id keeps hostile session ids inside escaped template JSON", async () => {
    const server = await startTestServer();
    const { port } = server.address();
    const sessionId = "</script><script>alert(1)</script>";

    try {
        const response = await fetch(`http://127.0.0.1:${port}/session/${encodeURIComponent(sessionId)}`);
        const body = await response.text();

        assert.equal(response.status, 200);
        assert.match(body, /<script id="template-vars" type="application\/json">/);
        assert.doesNotMatch(body, /<script id="template-vars" type="application\/json">[\s\S]*<\/script><script>alert\(1\)<\/script>/);
        assert.match(body, /\\u003c\/script\\u003e\\u003cscript\\u003ealert\(1\)\\u003c\/script\\u003e/);
    } finally {
        await stopTestServer(server);
    }
});
