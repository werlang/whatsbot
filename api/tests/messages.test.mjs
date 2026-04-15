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

test("POST /messages creates one scheduled message with normalized fields", async () => {
    const scheduledMessageModel = {
        async create(payload) {
            return {
                id: "msg-1",
                ...payload,
                status: "pending",
                claimToken: null,
                claimedAt: null,
                lastAttemptAt: null,
                sentAt: null,
                whatsappChatId: null,
                whatsappMessageId: null,
                errorMessage: null,
                createdAt: "2026-04-15T12:00:00.000Z",
                updatedAt: "2026-04-15T12:00:00.000Z",
            };
        },
    };
    const whatsappClient = {
        getSessionState() {
            return { status: "idle" };
        },
    };
    const server = await startTestServer({ scheduledMessageModel, whatsappClient });
    const { port } = server.address();

    try {
        const response = await fetch(`http://127.0.0.1:${port}/messages`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
            },
            body: JSON.stringify({
                phoneNumber: "+55 (51) 99999-9999",
                message: " hello world ",
                scheduledFor: "2026-04-15T18:30:00-03:00",
            }),
        });
        const payload = await response.json();

        assert.equal(response.status, 201);
        assert.equal(payload.error, false);
        assert.equal(payload.data.scheduledMessage.sessionId, "main");
        assert.equal(payload.data.scheduledMessage.phoneNumber, "5551999999999");
        assert.equal(payload.data.scheduledMessage.message, "hello world");
        assert.equal(payload.data.scheduledMessage.scheduledFor, "2026-04-15T21:30:00.000Z");
        assert.equal(payload.data.scheduledMessage.status, "pending");
    } finally {
        await stopTestServer(server);
    }
});

test("POST /messages accepts an explicit session id", async () => {
    let createdPayload = null;
    const scheduledMessageModel = {
        async create(payload) {
            createdPayload = payload;
            return {
                id: "msg-2",
                ...payload,
                status: "pending",
                claimToken: null,
                claimedAt: null,
                lastAttemptAt: null,
                sentAt: null,
                whatsappChatId: null,
                whatsappMessageId: null,
                errorMessage: null,
                createdAt: "2026-04-15T12:00:00.000Z",
                updatedAt: "2026-04-15T12:00:00.000Z",
            };
        },
    };
    const whatsappClient = {
        getDefaultSessionId() {
            return "main";
        },
        getKnownSessionState() {
            return { status: "idle" };
        },
        getActiveSessionCount() {
            return 0;
        },
    };
    const server = await startTestServer({ scheduledMessageModel, whatsappClient });
    const { port } = server.address();

    try {
        const response = await fetch(`http://127.0.0.1:${port}/messages`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
            },
            body: JSON.stringify({
                sessionId: "sales-team",
                phoneNumber: "5551999999999",
                message: "hello world",
                scheduledFor: "2026-04-15T18:30:00Z",
            }),
        });
        const payload = await response.json();

        assert.equal(response.status, 201);
        assert.equal(createdPayload.sessionId, "sales-team");
        assert.equal(payload.data.scheduledMessage.sessionId, "sales-team");
    } finally {
        await stopTestServer(server);
    }
});

test("POST /messages rejects scheduledFor values without timezone information", async () => {
    const whatsappClient = {
        getSessionState() {
            return { status: "idle" };
        },
    };
    const server = await startTestServer({ whatsappClient });
    const { port } = server.address();

    try {
        const response = await fetch(`http://127.0.0.1:${port}/messages`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
            },
            body: JSON.stringify({
                phoneNumber: "5551999999999",
                message: "hello world",
                scheduledFor: "2026-04-15T18:30:00",
            }),
        });
        const payload = await response.json();

        assert.equal(response.status, 400);
        assert.equal(payload.error, true);
        assert.match(payload.message, /timezone/);
    } finally {
        await stopTestServer(server);
    }
});
