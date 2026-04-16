import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { createApp } from "../app.js";
import { HttpError } from "../helpers/error.js";

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

/**
 * Builds a predictable scheduled message fixture for route tests.
 */
function createScheduledMessageFixture(overrides = {}) {
    return {
        id: "msg-1",
        sessionId: "main",
        targetType: "contact",
        targetValue: "5551999999999",
        phoneNumber: "5551999999999",
        message: "hello world",
        scheduledFor: "2026-04-15T21:30:00.000Z",
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
        ...overrides,
    };
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
        async assertAuthorizedSession() {},
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
        assert.equal(payload.data.scheduledMessage.targetType, "contact");
        assert.equal(payload.data.scheduledMessage.targetValue, "5551999999999");
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
    let authorizedPayload = null;
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
        async assertAuthorizedSession(sessionId, accessToken) {
            authorizedPayload = { sessionId, accessToken };
        },
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
                "x-whatsbot-session-token": "a".repeat(64),
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
        assert.deepEqual(authorizedPayload, {
            sessionId: "sales-team",
            accessToken: "a".repeat(64),
        });
        assert.equal(createdPayload.sessionId, "sales-team");
        assert.equal(createdPayload.targetType, "contact");
        assert.equal(createdPayload.targetValue, "5551999999999");
        assert.equal(payload.data.scheduledMessage.sessionId, "sales-team");
    } finally {
        await stopTestServer(server);
    }
});

test("POST /messages rejects one unreachable contact when the session is ready", async () => {
    let createdPayload = null;
    const scheduledMessageModel = {
        async create(payload) {
            createdPayload = payload;
            return payload;
        },
    };
    const whatsappClient = {
        async assertAuthorizedSession() {},
        async assertMessageTargetReachable() {
            throw new HttpError(400, "WhatsApp could not resolve a registered account for 64540523888721.");
        },
        getDefaultSessionId() {
            return "main";
        },
        getKnownSessionState() {
            return { status: "ready" };
        },
        getActiveSessionCount() {
            return 1;
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
                phoneNumber: "64540523888721",
                message: "hello world",
                scheduledFor: "2026-04-15T18:30:00Z",
            }),
        });
        const payload = await response.json();

        assert.equal(response.status, 400);
        assert.equal(payload.error, true);
        assert.match(payload.message, /could not resolve a registered account/i);
        assert.equal(createdPayload, null);
    } finally {
        await stopTestServer(server);
    }
});

test("POST /messages accepts one group target from the scheduler payload", async () => {
    let createdPayload = null;
    const scheduledMessageModel = {
        async create(payload) {
            createdPayload = payload;
            return {
                id: "msg-3",
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
        async assertAuthorizedSession() {},
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
                targetType: "group",
                targetValue: "120363043210123456@g.us",
                message: "hello group",
                scheduledFor: "2026-04-15T18:30:00Z",
            }),
        });
        const payload = await response.json();

        assert.equal(response.status, 201);
        assert.equal(createdPayload.targetType, "group");
        assert.equal(createdPayload.targetValue, "120363043210123456@g.us");
        assert.equal(createdPayload.phoneNumber, null);
        assert.equal(payload.data.scheduledMessage.targetType, "group");
        assert.equal(payload.data.scheduledMessage.targetValue, "120363043210123456@g.us");
        assert.equal(payload.data.scheduledMessage.phoneNumber, null);
    } finally {
        await stopTestServer(server);
    }
});

test("POST /messages rejects scheduledFor values without timezone information", async () => {
    const whatsappClient = {
        async assertAuthorizedSession() {},
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

test("GET /messages lists scheduled messages for the requested session", async () => {
    let authorizedPayload = null;
    let listedSessionId = null;
    const scheduledMessageModel = {
        async listBySessionId(sessionId) {
            listedSessionId = sessionId;
            return [createScheduledMessageFixture({ id: "msg-1", sessionId })];
        },
    };
    const whatsappClient = {
        async assertAuthorizedSession(sessionId, accessToken) {
            authorizedPayload = { sessionId, accessToken };
        },
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
        const response = await fetch(`http://127.0.0.1:${port}/messages?sessionId=sales-team`, {
            headers: {
                "x-whatsbot-session-token": "b".repeat(64),
            },
        });
        const payload = await response.json();

        assert.equal(response.status, 200);
        assert.deepEqual(authorizedPayload, {
            sessionId: "sales-team",
            accessToken: "b".repeat(64),
        });
        assert.equal(listedSessionId, "sales-team");
        assert.equal(payload.error, false);
        assert.equal(payload.data.scheduledMessages.length, 1);
        assert.equal(payload.data.scheduledMessages[0].sessionId, "sales-team");
    } finally {
        await stopTestServer(server);
    }
});

test("PUT /messages/:scheduledMessageId updates one editable scheduled message", async () => {
    let authorizedPayload = null;
    let reachablePayload = null;
    let updatedPayload = null;
    const scheduledMessageModel = {
        async findById(id) {
            return createScheduledMessageFixture({
                id,
                sessionId: "sales-team",
                status: "failed",
                errorMessage: "Old failure",
            });
        },
        isEditable(scheduledMessage) {
            return ["pending", "failed"].includes(scheduledMessage.status);
        },
        async updateEditable(id, payload) {
            updatedPayload = { id, payload };
            return createScheduledMessageFixture({
                id,
                sessionId: "sales-team",
                targetType: payload.targetType,
                targetValue: payload.targetValue,
                phoneNumber: payload.phoneNumber,
                message: payload.message,
                scheduledFor: payload.scheduledFor,
                status: "pending",
                errorMessage: null,
            });
        },
    };
    const whatsappClient = {
        async assertAuthorizedSession(sessionId, accessToken) {
            authorizedPayload = { sessionId, accessToken };
        },
        async assertMessageTargetReachable(sessionId, payload) {
            reachablePayload = { sessionId, payload };
        },
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
        const response = await fetch(`http://127.0.0.1:${port}/messages/msg-9`, {
            method: "PUT",
            headers: {
                "content-type": "application/json",
                "x-whatsbot-session-token": "c".repeat(64),
            },
            body: JSON.stringify({
                phoneNumber: "5551888888888",
                message: " updated message ",
                scheduledFor: "2026-04-16T10:00:00Z",
            }),
        });
        const payload = await response.json();

        assert.equal(response.status, 200);
        assert.deepEqual(authorizedPayload, {
            sessionId: "sales-team",
            accessToken: "c".repeat(64),
        });
        assert.deepEqual(updatedPayload, {
            id: "msg-9",
            payload: {
                sessionId: "sales-team",
                targetType: "contact",
                targetValue: "5551888888888",
                phoneNumber: "5551888888888",
                message: "updated message",
                scheduledFor: "2026-04-16T10:00:00.000Z",
            },
        });
        assert.deepEqual(reachablePayload, {
            sessionId: "sales-team",
            payload: updatedPayload.payload,
        });
        assert.equal(payload.error, false);
        assert.equal(payload.data.scheduledMessage.status, "pending");
        assert.equal(payload.data.scheduledMessage.errorMessage, null);
    } finally {
        await stopTestServer(server);
    }
});

test("PUT /messages/:scheduledMessageId rejects changes for sent schedules", async () => {
    const scheduledMessageModel = {
        async findById(id) {
            return createScheduledMessageFixture({ id, status: "sent", sentAt: "2026-04-15T22:00:00.000Z" });
        },
        isEditable() {
            return false;
        },
    };
    const whatsappClient = {
        async assertAuthorizedSession() {},
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
        const response = await fetch(`http://127.0.0.1:${port}/messages/msg-10`, {
            method: "PUT",
            headers: {
                "content-type": "application/json",
            },
            body: JSON.stringify({
                phoneNumber: "5551999999999",
                message: "updated message",
                scheduledFor: "2026-04-16T10:00:00Z",
            }),
        });
        const payload = await response.json();

        assert.equal(response.status, 409);
        assert.equal(payload.error, true);
        assert.match(payload.message, /pending or failed/i);
    } finally {
        await stopTestServer(server);
    }
});

test("DELETE /messages/:scheduledMessageId removes one editable schedule", async () => {
    let authorizedPayload = null;
    let deletedId = null;
    const scheduledMessageModel = {
        async findById(id) {
            return createScheduledMessageFixture({ id, sessionId: "sales-team" });
        },
        isEditable() {
            return true;
        },
        async deleteById(id) {
            deletedId = id;
        },
    };
    const whatsappClient = {
        async assertAuthorizedSession(sessionId, accessToken) {
            authorizedPayload = { sessionId, accessToken };
        },
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
        const response = await fetch(`http://127.0.0.1:${port}/messages/msg-11`, {
            method: "DELETE",
            headers: {
                "x-whatsbot-session-token": "d".repeat(64),
            },
        });
        const payload = await response.json();

        assert.equal(response.status, 200);
        assert.deepEqual(authorizedPayload, {
            sessionId: "sales-team",
            accessToken: "d".repeat(64),
        });
        assert.equal(deletedId, "msg-11");
        assert.equal(payload.error, false);
        assert.equal(payload.data.scheduledMessageId, "msg-11");
    } finally {
        await stopTestServer(server);
    }
});
