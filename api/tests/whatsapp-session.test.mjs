import assert from "node:assert/strict";
import { once } from "node:events";
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
    } finally {
        await stopTestServer(server);
    }
});

test("WhatsAppClientManager clears stale Chromium singleton artifacts before booting", async () => {
    const removedArtifacts = [];
    const manager = new WhatsAppClientManager({
        clientId: "main",
        authPath: "/tmp/whatsapp-auth",
        executablePath: "/usr/bin/chromium-browser",
        puppeteerArgs: [],
    });

    manager.clearChromiumSingletonArtifacts = async function () {
        removedArtifacts.push("cleared");
    };
    manager.registerLifecycleHandlers = function () {};
    manager.client = {
        initialize: async () => {},
    };

    let initializeCalls = 0;
    manager.bootClient = async function () {
        initializeCalls += 1;
        await this.clearChromiumSingletonArtifacts();
        this.client = {
            initialize: async () => {},
        };
        return this.client;
    };

    await manager.initializeClient();

    assert.equal(initializeCalls, 1);
    assert.deepEqual(removedArtifacts, ["cleared"]);
});

test("WhatsAppClientManager retries once after a Chromium profile lock error", async () => {
    const manager = new WhatsAppClientManager({
        clientId: "main",
        authPath: "/tmp/whatsapp-auth",
        executablePath: "/usr/bin/chromium-browser",
        puppeteerArgs: [],
    });

    let attempts = 0;
    let clearCalls = 0;
    let disposeCalls = 0;

    manager.clearChromiumSingletonArtifacts = async function () {
        clearCalls += 1;
    };
    manager.disposeClient = async function () {
        disposeCalls += 1;
    };
    manager.bootClient = async function () {
        attempts += 1;

        if (attempts === 1) {
            throw new Error("The profile appears to be in use by another Chromium process.");
        }

        return { ready: true };
    };

    const client = await manager.initializeClient();

    assert.deepEqual(client, { ready: true });
    assert.equal(attempts, 2);
    assert.equal(disposeCalls, 1);
    assert.equal(clearCalls, 1);
});

test("WhatsAppClientManager resolves a registered chat id before sending", async () => {
    const manager = new WhatsAppClientManager({
        clientId: "main",
        authPath: "/tmp/whatsapp-auth",
        executablePath: "/usr/bin/chromium-browser",
        puppeteerArgs: [],
    });

    manager.state.ready = true;
    const lookedUp = [];
    let sentPayload = null;
    manager.client = {
        async getNumberId(chatId) {
            lookedUp.push(chatId);
            return chatId === "5551999999999@c.us"
                ? { _serialized: chatId }
                : null;
        },
        async sendMessage(chatId, message) {
            sentPayload = { chatId, message };
            return {
                id: { _serialized: "wamid-1" },
                timestamp: 1776254400,
            };
        },
    };

    const result = await manager.sendMessage("5551999999999", "hello world");

    assert.deepEqual(lookedUp, ["5551999999999@c.us"]);
    assert.deepEqual(sentPayload, {
        chatId: "5551999999999@c.us",
        message: "hello world",
    });
    assert.equal(result.chatId, "5551999999999@c.us");
    assert.equal(result.whatsappMessageId, "wamid-1");
});

test("WhatsAppClientManager retries send after syncing a missing LID contact", async () => {
    const manager = new WhatsAppClientManager({
        clientId: "main",
        authPath: "/tmp/whatsapp-auth",
        executablePath: "/usr/bin/chromium-browser",
        puppeteerArgs: [],
    });

    manager.state.ready = true;
    manager.resolveWhatsAppChatId = async function () {
        return "5551997771055@c.us";
    };

    const sentAttempts = [];
    manager.syncChatForMissingLid = async function (chatId) {
        assert.equal(chatId, "5551997771055@c.us");
        return "551197771055@lid";
    };
    manager.client = {
        async sendMessage(chatId, message) {
            sentAttempts.push({ chatId, message });

            if (sentAttempts.length === 1) {
                throw new Error("No LID for user");
            }

            return {
                id: { _serialized: "wamid-2" },
                timestamp: 1776254400,
            };
        },
    };

    const result = await manager.sendMessage("5551997771055", "hello world");

    assert.deepEqual(sentAttempts, [
        { chatId: "5551997771055@c.us", message: "hello world" },
        { chatId: "551197771055@lid", message: "hello world" },
    ]);
    assert.equal(result.chatId, "551197771055@lid");
    assert.equal(result.whatsappMessageId, "wamid-2");
});

test("WhatsAppClientManager retries Brazil mobile numbers with and without the ninth digit", async () => {
    const manager = new WhatsAppClientManager({
        clientId: "main",
        authPath: "/tmp/whatsapp-auth",
        executablePath: "/usr/bin/chromium-browser",
        puppeteerArgs: [],
    });

    const lookedUp = [];
    manager.client = {
        async getNumberId(chatId) {
            lookedUp.push(chatId);
            return chatId === "5551997771055@c.us"
                ? { _serialized: chatId }
                : null;
        },
    };

    const resolvedChatId = await manager.resolveWhatsAppChatId("55519997771055");

    assert.deepEqual(lookedUp, [
        "55519997771055@c.us",
        "5551997771055@c.us",
    ]);
    assert.equal(resolvedChatId, "5551997771055@c.us");
});

test("WhatsAppClientManager throws a friendly error when no WhatsApp account is resolved", async () => {
    const manager = new WhatsAppClientManager({
        clientId: "main",
        authPath: "/tmp/whatsapp-auth",
        executablePath: "/usr/bin/chromium-browser",
        puppeteerArgs: [],
    });

    manager.client = {
        async getNumberId() {
            return null;
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
                lastError: null,
                lastEventAt: null,
                disconnectReason: null,
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
        assert.equal(payload.message, "WhatsApp session created.");
    } finally {
        await stopTestServer(server);
    }
});

test("WhatsAppClientManager handles a self-command message and replies with confirmation", async () => {
    const replies = [];
    const commands = [];
    const manager = new WhatsAppClientManager({
        clientId: "alpha",
        authPath: "/tmp/whatsapp-auth",
        executablePath: "/usr/bin/chromium-browser",
        puppeteerArgs: [],
    }, {
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
        info: {
            wid: {
                _serialized: "5551999999999@c.us",
                user: "5551999999999",
            },
        },
    };

    await manager.handleCreatedMessage({
        fromMe: true,
        body: "@whatsbot 5551997771055 2026-04-15-19-20-30 teste message",
        to: "5551999999999@c.us",
        id: {
            _serialized: "wamid-self",
        },
        async reply(message) {
            replies.push(message);
        },
    });

    assert.equal(commands.length, 1);
    assert.equal(commands[0].sessionId, "alpha");
    assert.equal(commands[0].body, "@whatsbot 5551997771055 2026-04-15-19-20-30 teste message");
    assert.deepEqual(replies, ["Scheduled 5551997771055 for 2026-04-15T19:20:30.000Z."]);
});

test("WhatsAppClientManager accepts self commands resolved through _getChatId", async () => {
    const commands = [];
    const manager = new WhatsAppClientManager({
        clientId: "alpha",
        authPath: "/tmp/whatsapp-auth",
        executablePath: "/usr/bin/chromium-browser",
        puppeteerArgs: [],
    }, {
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
        info: {
            wid: {
                _serialized: "5551999999999@c.us",
                user: "5551999999999",
            },
        },
    };

    await manager.handleCreatedMessage({
        fromMe: true,
        body: "@whatsbot 5551997771055 2026-04-15-19-20-30 teste message",
        from: "status@broadcast",
        to: null,
        _getChatId() {
            return "5551999999999@c.us";
        },
        async reply() {},
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
