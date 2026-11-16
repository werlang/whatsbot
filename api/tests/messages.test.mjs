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
                phoneNumber: "5551999999999",
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

test("POST without a sessionId schedules on main even when the manager default differs", async () => {
    const authorizedPayloads = [];
    const createdPayloads = [];
    const scheduledMessageModel = {
        async create(payload) {
            createdPayloads.push(payload);
            return createScheduledMessageFixture({ id: "msg-default", ...payload });
        },
    };
    const whatsappClient = {
        async assertAuthorizedSession(sessionId, accessToken) {
            authorizedPayloads.push({ sessionId, accessToken });
            if (sessionId !== "main") {
                throw new HttpError(401, "Session authorization required.");
            }
        },
        getDefaultSessionId() {
            return "sales";
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
                phoneNumber: "5551999999999",
                message: "hello main",
                scheduledFor: "2026-04-15T18:30:00Z",
            }),
        });
        const payload = await response.json();

        assert.equal(response.status, 201);
        assert.equal(payload.error, false);
        assert.deepEqual(authorizedPayloads, [{ sessionId: "main", accessToken: "" }]);
        assert.equal(createdPayloads.length, 1);
        assert.equal(createdPayloads[0].sessionId, "main");
        assert.equal(createdPayloads[0].phoneNumber, "5551999999999");
        assert.equal(payload.data.scheduledMessage.sessionId, "main");
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

const sessionDirectories = {
    main: {
        contacts: [
            {
                id: "555195171104@c.us",
                name: "Vinicius",
                targetType: "contact",
                targetValue: "555195171104",
                phoneNumber: "555195171104",
                chatId: "555195171104@c.us",
                label: "Vinicius",
            },
            {
                id: "555391565003@c.us",
                name: "Vinícius Alves Hax",
                targetType: "contact",
                targetValue: "555391565003",
                phoneNumber: "555391565003",
                chatId: "555391565003@c.us",
                label: "Vinícius Alves Hax",
            },
        ],
        groups: [
            {
                id: "120363043210123456@g.us",
                name: "Águias",
                targetType: "group",
                targetValue: "120363043210123456@g.us",
                phoneNumber: null,
                chatId: "120363043210123456@g.us",
                label: "Águias",
            },
        ],
        refreshedAt: "2026-11-15T12:00:00.000Z",
    },
    "sales-team": {
        contacts: [
            {
                id: "5551988887777@c.us",
                name: "Maria Vendas",
                targetType: "contact",
                targetValue: "5551988887777",
                phoneNumber: "5551988887777",
                chatId: "5551988887777@c.us",
                label: "Maria Vendas",
            },
        ],
        groups: [],
        refreshedAt: "2026-11-15T12:00:00.000Z",
    },
};

function createRouteHarness({
    existingSessionId = "sales-team",
    existingStatus = "pending",
    directories = sessionDirectories,
    authorizeImpl = async () => {},
} = {}) {
    const events = [];
    const writes = [];
    const scheduledMessageModel = {
        async findById(id) {
            events.push({ step: "findById", id });
            return createScheduledMessageFixture({ id, sessionId: existingSessionId, status: existingStatus });
        },
        isEditable(scheduledMessage) {
            return ["pending", "failed"].includes(scheduledMessage.status);
        },
        async create(payload) {
            events.push({ step: "create", payload });
            writes.push(payload);
            return createScheduledMessageFixture({ id: "msg-created", ...payload });
        },
        async updateEditable(id, payload) {
            events.push({ step: "updateEditable", id, payload });
            writes.push(payload);
            return createScheduledMessageFixture({ id, ...payload });
        },
    };
    const whatsappClient = {
        getDefaultSessionId() {
            return "main";
        },
        async assertAuthorizedSession(sessionId, accessToken) {
            events.push({ step: "authorize", sessionId, accessToken });
            await authorizeImpl(sessionId, accessToken);
        },
        async getSessionState(sessionId) {
            events.push({ step: "getSessionState", sessionId });
            return {
                sessionId,
                status: "ready",
                ready: true,
                chatDirectory: directories[sessionId] || { contacts: [], groups: [], refreshedAt: null },
            };
        },
        async assertMessageTargetReachable(sessionId, payload) {
            events.push({ step: "reachability", sessionId, payload });
        },
    };
    return { events, writes, scheduledMessageModel, whatsappClient };
}

test("message write routes resolve recipient in the authorized session before persistence", async () => {
    const token = "e".repeat(64);
    const cases = [
        {
            name: "POST contact",
            method: "POST",
            path: "/messages",
            expectedStatus: 201,
            expectedWriteStep: "create",
            body: {
                recipient: "  vINÍCIUS ALVES  ",
                message: "  bom dia  ",
                scheduledFor: "2026-11-16T10:00:00Z",
            },
            expectedSessionId: "main",
            expectedTarget: {
                targetType: "contact",
                targetValue: "555391565003",
                phoneNumber: "555391565003",
            },
        },
        {
            name: "POST group",
            method: "POST",
            path: "/messages",
            expectedStatus: 201,
            expectedWriteStep: "create",
            body: {
                recipient: "aguias",
                message: "  aviso grupo  ",
                scheduledFor: "2026-11-16T10:00:00Z",
            },
            expectedSessionId: "main",
            expectedTarget: {
                targetType: "group",
                targetValue: "120363043210123456@g.us",
                phoneNumber: null,
            },
        },
        {
            name: "PUT contact",
            method: "PUT",
            path: "/messages/msg-9",
            expectedStatus: 200,
            expectedWriteStep: "updateEditable",
            existingSessionId: "main",
            body: {
                recipient: "  vINÍCIUS ALVES  ",
                message: "  bom dia editado ",
                scheduledFor: "2026-11-16T11:00:00Z",
            },
            expectedSessionId: "main",
            expectedTarget: {
                targetType: "contact",
                targetValue: "555391565003",
                phoneNumber: "555391565003",
            },
        },
        {
            name: "PUT group",
            method: "PUT",
            path: "/messages/msg-9",
            expectedStatus: 200,
            expectedWriteStep: "updateEditable",
            existingSessionId: "main",
            body: {
                recipient: "aguias",
                message: "  aviso editado ",
                scheduledFor: "2026-11-16T11:00:00Z",
            },
            expectedSessionId: "main",
            expectedTarget: {
                targetType: "group",
                targetValue: "120363043210123456@g.us",
                phoneNumber: null,
            },
        },
    ];

    for (const item of cases) {
        const harness = createRouteHarness({ existingSessionId: item.existingSessionId || "main" });
        const server = await startTestServer({
            scheduledMessageModel: harness.scheduledMessageModel,
            whatsappClient: harness.whatsappClient,
        });
        const { port } = server.address();

        try {
            const response = await fetch(`http://127.0.0.1:${port}${item.path}`, {
                method: item.method,
                headers: {
                    "content-type": "application/json",
                    "x-whatsbot-session-token": token,
                },
                body: JSON.stringify(item.body),
            });
            const payload = await response.json();

            assert.equal(response.status, item.expectedStatus, item.name);
            assert.equal(payload.error, false, item.name);
            assert.equal(harness.writes.length, 1, item.name);
            assert.equal(Object.hasOwn(harness.writes[0], "recipient"), false, item.name);
            assert.deepEqual(harness.writes[0], {
                sessionId: item.expectedSessionId,
                ...item.expectedTarget,
                message: item.body.message.trim(),
                scheduledFor: new Date(item.body.scheduledFor).toISOString(),
            }, item.name);

            const expectedOrder = item.method === "POST"
                ? ["authorize", "getSessionState", "reachability", item.expectedWriteStep]
                : ["findById", "authorize", "getSessionState", "reachability", item.expectedWriteStep];
            assert.deepEqual(harness.events.map(event => event.step), expectedOrder, item.name);
            assert.equal(harness.events.find(e => e.step === "authorize").accessToken, token, item.name);
            assert.equal(harness.events.find(e => e.step === "authorize").sessionId, item.expectedSessionId, item.name);
            assert.equal(harness.events.find(e => e.step === "getSessionState").sessionId, item.expectedSessionId, item.name);
        } finally {
            await stopTestServer(server);
        }
    }
});

test("message write routes reject ambiguous and missing recipients without writes", async () => {
    const invalidBodies = [
        {
            body: { recipient: "Vinicius", message: "oi", scheduledFor: "2026-11-16T10:00:00Z" },
            expectedMessage: 'Multiple recipients found for "Vinicius": Vinicius (555195171104); Vinícius Alves Hax (555391565003). Use phoneNumber or targetValue to choose.',
        },
        {
            body: { recipient: "Ninguém", message: "oi", scheduledFor: "2026-11-16T10:00:00Z" },
            expectedMessage: 'No recipient found for "Ninguém".',
        },
        {
            body: { recipient: "   ", message: "oi", scheduledFor: "2026-11-16T10:00:00Z" },
            expectedMessage: "recipient must be a non-empty name string.",
        },
        {
            body: { recipient: null, message: "oi", scheduledFor: "2026-11-16T10:00:00Z" },
            expectedMessage: "recipient must be a non-empty name string.",
        },
        {
            body: { recipient: "Vinícius Alves", phoneNumber: "", message: "oi", scheduledFor: "2026-11-16T10:00:00Z" },
            expectedMessage: "recipient cannot be combined with phoneNumber or targetValue.",
        },
        {
            body: { recipient: "Vinícius Alves", targetValue: "", message: "oi", scheduledFor: "2026-11-16T10:00:00Z" },
            expectedMessage: "recipient cannot be combined with phoneNumber or targetValue.",
        },
        {
            body: { recipient: "Vinícius Alves", targetType: "group", message: "oi", scheduledFor: "2026-11-16T10:00:00Z" },
            expectedMessage: "targetType does not match the resolved recipient.",
        },
    ];

    for (const [method, path] of [["POST", "/messages"], ["PUT", "/messages/msg-9"]]) {
        for (const testCase of invalidBodies) {
            const harness = createRouteHarness({ existingSessionId: "main" });
            const server = await startTestServer({
                scheduledMessageModel: harness.scheduledMessageModel,
                whatsappClient: harness.whatsappClient,
            });
            const { port } = server.address();

            try {
                const response = await fetch(`http://127.0.0.1:${port}${path}`, {
                    method,
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify(testCase.body),
                });
                const payload = await response.json();

                assert.equal(response.status, 400);
                assert.equal(payload.error, true);
                assert.equal(payload.message, testCase.expectedMessage);
                assert.equal(harness.writes.length, 0);
            } finally {
                await stopTestServer(server);
            }
        }
    }
});

test("message write routes authorize before recipient directory access", async () => {
    for (const [method, path] of [["POST", "/messages"], ["PUT", "/messages/msg-9"]]) {
        const harness = createRouteHarness({
            existingSessionId: "main",
            authorizeImpl: async () => {
                throw new HttpError(401, "Session authorization required.");
            },
        });
        const server = await startTestServer({
            scheduledMessageModel: harness.scheduledMessageModel,
            whatsappClient: harness.whatsappClient,
        });
        const { port } = server.address();

        try {
            const response = await fetch(`http://127.0.0.1:${port}${path}`, {
                method,
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    recipient: "Vinicius",
                    message: "oi",
                    scheduledFor: "2026-11-16T10:00:00Z",
                }),
            });
            const payload = await response.json();

            assert.equal(response.status, 401);
            assert.equal(payload.error, true);
            assert.doesNotMatch(payload.message, /Vinicius|555391565003/);
            assert.equal(harness.events.some(e => e.step === "getSessionState"), false);
            assert.equal(harness.events.some(e => e.step === "reachability"), false);
            assert.equal(harness.writes.length, 0);
        } finally {
            await stopTestServer(server);
        }
    }
});

test("PUT recipient resolution preserves editability and session immutability", async () => {
    const sentHarness = createRouteHarness({ existingSessionId: "sales-team", existingStatus: "sent" });
    const sentServer = await startTestServer({
        scheduledMessageModel: sentHarness.scheduledMessageModel,
        whatsappClient: sentHarness.whatsappClient,
    });
    try {
        const { port } = sentServer.address();
        const response = await fetch(`http://127.0.0.1:${port}/messages/msg-sent`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                recipient: "Maria Vendas",
                message: "oi",
                scheduledFor: "2026-11-16T10:00:00Z",
            }),
        });
        assert.equal(response.status, 409);
        assert.equal(sentHarness.events.some(e => e.step === "getSessionState"), false);
        assert.equal(sentHarness.writes.length, 0);
    } finally {
        await stopTestServer(sentServer);
    }

    const moveHarness = createRouteHarness({ existingSessionId: "sales-team", existingStatus: "pending" });
    const moveServer = await startTestServer({
        scheduledMessageModel: moveHarness.scheduledMessageModel,
        whatsappClient: moveHarness.whatsappClient,
    });
    try {
        const { port } = moveServer.address();
        const response = await fetch(`http://127.0.0.1:${port}/messages/msg-move`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                sessionId: "main",
                recipient: "Vinícius Alves",
                message: "oi",
                scheduledFor: "2026-11-16T10:00:00Z",
            }),
        });
        const payload = await response.json();
        assert.equal(response.status, 400);
        assert.equal(payload.message, "sessionId cannot be changed.");
        assert.equal(moveHarness.events.some(e => e.step === "getSessionState"), false);
        assert.equal(moveHarness.writes.length, 0);
    } finally {
        await stopTestServer(moveServer);
    }
});

test("message write routes isolate recipient directories and preserve explicit addressing", async () => {
    const postHarness = createRouteHarness({ existingSessionId: "main" });
    const postServer = await startTestServer({
        scheduledMessageModel: postHarness.scheduledMessageModel,
        whatsappClient: postHarness.whatsappClient,
    });
    try {
        const { port } = postServer.address();
        const crossResponse = await fetch(`http://127.0.0.1:${port}/messages`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                sessionId: "sales-team",
                recipient: "Vinícius Alves",
                message: "oi",
                scheduledFor: "2026-11-16T10:00:00Z",
            }),
        });
        const crossPayload = await crossResponse.json();
        assert.equal(crossResponse.status, 400);
        assert.equal(crossPayload.message, 'No recipient found for "Vinícius Alves".');
        assert.equal(postHarness.events.find(e => e.step === "getSessionState").sessionId, "sales-team");

        const sameSessionResponse = await fetch(`http://127.0.0.1:${port}/messages`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                sessionId: "sales-team",
                recipient: "Maria Vendas",
                message: "oi",
                scheduledFor: "2026-11-16T10:00:00Z",
            }),
        });
        assert.equal(sameSessionResponse.status, 201);
        assert.equal(postHarness.writes[0].sessionId, "sales-team");
        assert.equal(postHarness.writes[0].phoneNumber, "5551988887777");
    } finally {
        await stopTestServer(postServer);
    }

    const explicitWrites = [];
    const noStateClient = {
        getDefaultSessionId() { return "main"; },
        async assertAuthorizedSession() {},
    };
    const noStateModel = {
        async create(payload) {
            explicitWrites.push(payload);
            return createScheduledMessageFixture(payload);
        },
        async findById(id) {
            return createScheduledMessageFixture({ id, sessionId: "sales-team" });
        },
        isEditable() { return true; },
        async updateEditable(_id, payload) {
            explicitWrites.push(payload);
            return createScheduledMessageFixture(payload);
        },
    };
    const explicitServer = await startTestServer({
        scheduledMessageModel: noStateModel,
        whatsappClient: noStateClient,
    });
    try {
        const { port } = explicitServer.address();
        const postRes = await fetch(`http://127.0.0.1:${port}/messages`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                targetValue: "555391565003@c.us",
                message: "explicit post",
                scheduledFor: "2026-11-16T10:00:00Z",
            }),
        });
        assert.equal(postRes.status, 201);
        const putRes = await fetch(`http://127.0.0.1:${port}/messages/msg-1`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                phoneNumber: "555391565003",
                message: "explicit put",
                scheduledFor: "2026-11-16T10:00:00Z",
            }),
        });
        assert.equal(putRes.status, 200);
        assert.equal(explicitWrites.length, 2);
    } finally {
        await stopTestServer(explicitServer);
    }
});

test("message write routes reject unsupported identifiers without persistence", async () => {
    const unsafePayloads = [
        { phoneNumber: "+55 (51) 99999-9999" },
        { phoneNumber: "38865310056602@lid" },
        { targetValue: "38865310056602@lid" },
        { phoneNumber: "abc555391565003" },
        { targetValue: "555391565003@example.com" },
        { phoneNumber: "+55 (53) 91565-003" },
        { targetValue: "555391565003@c.us.evil" },
        { targetValue: "x@g.us" },
        { targetValue: "123@lid@g.us" },
        { phoneNumber: "" },
        { targetType: "channel", targetValue: "555391565003" },
        { phoneNumber: "123456789" },
        { phoneNumber: "1234567890123456" },
    ];

    for (const [method, path] of [["POST", "/messages"], ["PUT", "/messages/msg-1"]]) {
        for (const targetFields of unsafePayloads) {
            const harness = createRouteHarness({ existingSessionId: "main" });
            const server = await startTestServer({
                scheduledMessageModel: harness.scheduledMessageModel,
                whatsappClient: harness.whatsappClient,
            });
            const { port } = server.address();

            try {
                const response = await fetch(`http://127.0.0.1:${port}${path}`, {
                    method,
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({
                        ...targetFields,
                        message: "oi",
                        scheduledFor: "2026-11-16T10:00:00Z",
                    }),
                });
                const payload = await response.json();

                assert.equal(response.status, 400);
                assert.equal(payload.error, true);
                assert.equal(harness.writes.length, 0);
                assert.equal(harness.events.some(e => e.step === "reachability"), false);
            } finally {
                await stopTestServer(server);
            }
        }
    }
});
