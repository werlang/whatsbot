import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { createApp } from "../app.js";
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
