import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createApp } from "../app.js";
import { parseWhatsBotCommand } from "../services/whatsapp-command.js";
import { WhatsAppClientManager } from "../services/whatsapp-client-manager.js";

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
        async assertAuthorizedSession() {},
        async getSessionState() {
            return {
                sessionId: "main",
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
                chatDirectory: {
                    contacts: [],
                    groups: [],
                    refreshedAt: null,
                },
                lastError: null,
                lastEventAt: "2026-04-15T12:00:00.000Z",
                disconnectReason: null,
            };
        },
        getDefaultSessionId() {
            return "main";
        },
        getKnownSessionState() {
            return {
                status: "qr",
            };
        },
        getActiveSessionCount() {
            return 1;
        },
    };
    const server = await startTestServer({ whatsappClient });
    const { port } = server.address();

    try {
        const response = await fetch(`http://127.0.0.1:${port}/whatsapp/session`);
        const payload = await response.json();

        assert.equal(response.status, 200);
        assert.equal(payload.error, false);
        assert.equal(payload.data.session.sessionId, "main");
        assert.equal(payload.data.session.status, "qr");
        assert.equal(payload.data.session.hasQrCode, true);
        assert.match(payload.data.session.qrCodeDataUrl, /^data:image\/png;base64,/);
        assert.equal(payload.data.session.loading.percent, 42);
        assert.deepEqual(payload.data.session.chatDirectory, {
            contacts: [],
            groups: [],
            refreshedAt: null,
        });
    } finally {
        await stopTestServer(server);
    }
});

/**
 * Creates one manager with a temp auth directory and no real socket.
 *
 * @param {object} t Test context.
 * @param {object} [options] Manager options.
 * @returns {Promise<object>} Client manager.
 */
async function createManager(t, options = {}) {
    const authPath = await fs.mkdtemp(path.join(os.tmpdir(), "whatsbot-session-"));
    t.after(() => fs.rm(authPath, { recursive: true, force: true }));
    const manager = new WhatsAppClientManager({ clientId: "alpha", authPath }, {
        logger: { error() {}, warn() {} },
        ...options,
    });
    t.after(() => manager.destroy());
    return manager;
}

test("WhatsAppClientManager resolves a registered chat id before sending", async t => {
    const manager = await createManager(t);
    manager.state.ready = true;

    const lookedUp = [];
    manager.client = {
        async onWhatsApp(candidate) {
            lookedUp.push(candidate);
            return candidate === "5551999999999"
                ? [{ jid: "5551999999999@s.whatsapp.net", exists: true }]
                : [];
        },
        async sendMessage(jid, content) {
            assert.deepEqual({ jid, content }, { jid: "5551999999999@s.whatsapp.net", content: { text: "hello world" } });
            return {
                key: { id: "wamid-1" },
                messageTimestamp: 1776254400,
            };
        },
    };

    const result = await manager.sendMessage("5551999999999", "hello world");

    assert.deepEqual(lookedUp, ["5551999999999"]);
    assert.equal(result.chatId, "5551999999999@c.us");
    assert.equal(result.whatsappMessageId, "wamid-1");
    assert.equal(result.sentAt, new Date(1776254400 * 1000).toISOString());
});

test("WhatsAppClientManager sends group messages directly to the provided group chat id", async t => {
    const manager = await createManager(t);
    manager.state.ready = true;

    let sentPayload = null;
    manager.client = {
        async sendMessage(jid, content) {
            sentPayload = { jid, content };
            return {
                key: { id: "wamid-group-1" },
                messageTimestamp: 1776254400,
            };
        },
    };

    const result = await manager.sendMessage({
        targetType: "group",
        targetValue: "120363043210123456@g.us",
    }, "hello group");

    assert.deepEqual(sentPayload, {
        jid: "120363043210123456@g.us",
        content: { text: "hello group" },
    });
    assert.equal(result.chatId, "120363043210123456@g.us");
    assert.equal(result.phoneNumber, null);
    assert.equal(result.targetType, "group");
});

test("WhatsAppClientManager retries Brazil mobile numbers with and without the ninth digit", async t => {
    const manager = await createManager(t);
    const lookedUp = [];
    manager.client = {
        async onWhatsApp(candidate) {
            lookedUp.push(candidate);
            return candidate === "5551997771055"
                ? [{ jid: "5551997771055@s.whatsapp.net", exists: true }]
                : [];
        },
    };

    const resolvedJid = await manager.resolveWhatsAppChatId("55519997771055");

    assert.deepEqual(lookedUp, [
        "55519997771055",
        "5551997771055",
    ]);
    assert.equal(resolvedJid, "5551997771055@s.whatsapp.net");
});

test("WhatsAppClientManager throws a friendly error when no WhatsApp account is resolved", async t => {
    const manager = await createManager(t);
    manager.client = {
        async onWhatsApp() {
            return [];
        },
    };

    await assert.rejects(
        () => manager.resolveWhatsAppChatId("5551999999999"),
        /could not resolve a registered account/i,
    );
});
test("POST /whatsapp/sessions creates a new session envelope", async () => {
    const whatsappClient = {
        async createSession() {
            return {
                session: {
                    sessionId: "alpha",
                    clientId: "alpha",
                    status: "initializing",
                    ready: false,
                    authenticated: false,
                    hasQrCode: false,
                    qrCodeDataUrl: null,
                    qrCodeUpdatedAt: null,
                    connectionState: null,
                    loading: {
                        percent: 0,
                        message: null,
                    },
                    clientInfo: null,
                    chatDirectory: {
                        contacts: [],
                        groups: [],
                        refreshedAt: null,
                    },
                    lastError: null,
                    lastEventAt: null,
                    disconnectReason: null,
                },
                    accessToken: "a".repeat(64),
                    recoveryPassword: "amber-harbor-signal-voyage-willow-summit-4821",
            };
        },
        getDefaultSessionId() {
            return "main";
        },
        getKnownSessionState() {
            return { status: "idle" };
        },
        getActiveSessionCount() {
            return 1;
        },
        async getSessionState() {
            return {
                sessionId: "main",
                clientId: "main",
                status: "idle",
                ready: false,
                authenticated: false,
                hasQrCode: false,
                qrCodeDataUrl: null,
                qrCodeUpdatedAt: null,
                connectionState: null,
                loading: {
                    percent: 0,
                    message: null,
                },
                clientInfo: null,
                chatDirectory: {
                    contacts: [],
                    groups: [],
                    refreshedAt: null,
                },
                lastError: null,
                lastEventAt: null,
                disconnectReason: null,
            };
        },
    };
    const server = await startTestServer({ whatsappClient });
    const { port } = server.address();

    try {
        const response = await fetch(`http://127.0.0.1:${port}/whatsapp/sessions`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
            },
            body: JSON.stringify({}),
        });
        const payload = await response.json();

        assert.equal(response.status, 201);
        assert.equal(payload.error, false);
        assert.equal(payload.data.session.sessionId, "alpha");
        assert.equal(payload.data.accessToken, "a".repeat(64));
        assert.equal(payload.data.recoveryPassword, "amber-harbor-signal-voyage-willow-summit-4821");
        assert.equal(payload.message, "WhatsApp session created.");
    } finally {
        await stopTestServer(server);
    }
});

test("POST /whatsapp/sessions/login restores one session by recovery password", async () => {
    let receivedRecoveryPassword = null;
    const whatsappClient = {
        async loginWithRecoveryPassword(recoveryPassword) {
            receivedRecoveryPassword = recoveryPassword;
            return {
                session: {
                    sessionId: "alpha",
                    clientId: "alpha",
                    status: "ready",
                    ready: true,
                    authenticated: true,
                    hasQrCode: false,
                    qrCodeDataUrl: null,
                    qrCodeUpdatedAt: null,
                    connectionState: "CONNECTED",
                    loading: {
                        percent: 100,
                        message: null,
                    },
                    clientInfo: null,
                    chatDirectory: {
                        contacts: [],
                        groups: [],
                        refreshedAt: null,
                    },
                    lastError: null,
                    lastEventAt: null,
                    disconnectReason: null,
                },
                accessToken: "b".repeat(64),
            };
        },
        getDefaultSessionId() {
            return "main";
        },
        getKnownSessionState() {
            return { status: "idle" };
        },
        getActiveSessionCount() {
            return 1;
        },
        async getSessionState() {
            return {
                sessionId: "main",
                clientId: "main",
                status: "idle",
                ready: false,
                authenticated: false,
                hasQrCode: false,
                qrCodeDataUrl: null,
                qrCodeUpdatedAt: null,
                connectionState: null,
                loading: {
                    percent: 0,
                    message: null,
                },
                clientInfo: null,
                chatDirectory: {
                    contacts: [],
                    groups: [],
                    refreshedAt: null,
                },
                lastError: null,
                lastEventAt: null,
                disconnectReason: null,
            };
        },
    };
    const server = await startTestServer({ whatsappClient });
    const { port } = server.address();

    try {
        const response = await fetch(`http://127.0.0.1:${port}/whatsapp/sessions/login`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
            },
            body: JSON.stringify({
                recoveryPassword: "amber-harbor-signal-voyage-willow-summit-4821",
            }),
        });
        const payload = await response.json();

        assert.equal(response.status, 200);
        assert.equal(receivedRecoveryPassword, "amber-harbor-signal-voyage-willow-summit-4821");
        assert.equal(payload.error, false);
        assert.equal(payload.data.session.sessionId, "alpha");
        assert.equal(payload.data.accessToken, "b".repeat(64));
        assert.equal(payload.message, "WhatsApp session restored.");
    } finally {
        await stopTestServer(server);
    }
});

test("WhatsAppClientManager handles a self-command message and replies with confirmation", async t => {
    const replies = [];
    const commands = [];
    const manager = await createManager(t, {
        onSelfCommand: async command => {
            commands.push(command);
            return {
                scheduledMessage: {
                    phoneNumber: "5551997771055",
                    scheduledFor: "2026-04-15T19:20:30.000Z",
                },
                reply: "Scheduled 5551997771055 for 2026-04-15T19:20:30.000Z.",
            };
        },
    });

    manager.client = {
        user: {
            id: "5551999999999:3@s.whatsapp.net",
            lid: "12345678901234@lid",
            name: "Pablo",
        },
        ev: new EventEmitter(),
        async sendMessage(jid, content) {
            replies.push({ jid, content });
            return { key: { id: "reply-1" } };
        },
    };
    manager.registerLifecycleHandlers();

    await manager.handleMessagesUpsert({
        type: "notify",
        messages: [{
            key: {
                fromMe: true,
                remoteJid: "5551999999999@s.whatsapp.net",
                id: "wamid-self",
            },
            message: {
                conversation: "@whatsbot 5551997771055 2026-04-15-19-20-30 teste message",
            },
        }],
    });

    assert.equal(commands.length, 1);
    assert.equal(commands[0].sessionId, "alpha");
    assert.equal(commands[0].body, "@whatsbot 5551997771055 2026-04-15-19-20-30 teste message");
    assert.equal(commands[0].source.whatsappMessageId, "wamid-self");
    assert.deepEqual(replies, [{
        jid: "5551999999999@s.whatsapp.net",
        content: { text: "Scheduled 5551997771055 for 2026-04-15T19:20:30.000Z." },
    }]);
});

test("WhatsAppClientManager accepts self commands addressed through the LID chat", async t => {
    const commands = [];
    const manager = await createManager(t, {
        onSelfCommand: async command => {
            commands.push(command);
            return {
                scheduledMessage: {
                    phoneNumber: "5551997771055",
                    scheduledFor: "2026-04-15T19:20:30.000Z",
                },
                reply: "ok",
            };
        },
    });

    manager.client = {
        user: {
            id: "5551999999999:3@s.whatsapp.net",
            lid: "12345678901234@lid",
            name: "Pablo",
        },
        ev: new EventEmitter(),
        async sendMessage() {
            return { key: { id: "reply-2" } };
        },
    };
    manager.registerLifecycleHandlers();

    await manager.handleMessagesUpsert({
        type: "notify",
        messages: [{
            key: {
                fromMe: true,
                remoteJid: "12345678901234@lid",
                remoteJidAlt: "5551999999999@s.whatsapp.net",
                id: "wamid-lid",
            },
            message: {
                extendedTextMessage: {
                    text: "@whatsbot 5551997771055 2026-04-15-19-20-30 teste message",
                },
            },
        }],
    });

    assert.equal(commands.length, 1);
    assert.equal(commands[0].sessionId, "alpha");
});
test("parseWhatsBotCommand rejects invalid local datetimes", () => {
    assert.throws(
        () => parseWhatsBotCommand("@whatsbot 5551997771055 2026-02-31-19-20-30 teste message"),
        /valid local date and time/i,
    );
});
