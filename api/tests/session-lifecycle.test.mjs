import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { WhatsAppClientManager } from "../services/whatsapp-client-manager.js";
import { WhatsAppSessionManager } from "../services/whatsapp-session-manager.js";
import { WhatsAppSessionAccessStore } from "../services/whatsapp-session-access-store.js";
import { MessageDispatcher } from "../background/message-dispatcher.js";
import { createAppConfig } from "../config/app-config.js";

const baseConfig = {
    clientId: "main",
    reconnectMaxAttempts: 4,
    reconnectDelayMs: 1000,
    reconnectMaxDelayMs: 2500,
    reconnectSlowRetryMs: 60000,
    chatDirectoryRetryMs: 1000,
};
const logger = { error() {}, warn() {} };

/** Waits for asynchronous lifecycle handlers without advancing retry timers. */
const flush = () => new Promise(resolve => setImmediate(resolve));

/** Waits for file-system and promise chains triggered by a timer. */
const settle = async () => {
    for (let index = 0; index < 40; index += 1) {
        await flush();
    }
};

/** Waits until a predicate holds, yielding real time between checks. */
async function waitFor(predicate, { attempts = 3000 } = {}) {
    for (let index = 0; index < attempts; index += 1) {
        if (predicate()) {
            return;
        }

        await delay(1);
    }

    throw new Error("condition was not met in time");
}

/**
 * Creates one fake Baileys socket with the API surface the manager uses.
 */
function createFakeSocket() {
    const socket = {
        ev: new EventEmitter(),
        user: undefined,
        endCalls: 0,
        sent: [],
        async end() {
            socket.endCalls += 1;
        },
        async sendMessage(jid, content) {
            socket.sent.push({ jid, content });
            return { key: { id: "wamid-fake" } };
        },
        async onWhatsApp() {
            return [];
        },
        async groupFetchAllParticipating() {
            return {};
        },
    };

    return socket;
}

/**
 * Creates a temp auth path for one test.
 */
async function createAuthPath(t) {
    const authPath = await fs.mkdtemp(path.join(os.tmpdir(), "whatsbot-lifecycle-"));
    t.after(() => fs.rm(authPath, { recursive: true, force: true }));
    return authPath;
}

/**
 * Creates sockets through the real manager boot path, with fake sockets and no network.
 */
async function createClientHarness(t, { failBoot = false } = {}) {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10000 });
    const authPath = await createAuthPath(t);
    const clients = [];
    const manager = new WhatsAppClientManager({ ...baseConfig, authPath }, {
        logger,
        createAuthState: async () => ({ state: { creds: {}, keys: {} }, saveCreds: async () => {} }),
        createSocket: async () => {
            const client = createFakeSocket();
            clients.push(client);
            if (failBoot) throw new Error("boot timeout");
            return client;
        },
    });
    t.after(() => manager.destroy());
    return { manager, clients };
}

const closeUpdate = statusCode => ({
    connection: "close",
    lastDisconnect: { error: { output: { statusCode } } },
});

test("B1 transient close rebuilds exactly once and ignores events from the disposed socket", async t => {
    const { manager, clients } = await createClientHarness(t);
    await manager.initialize();
    clients[0].ev.emit("connection.update", closeUpdate(428));
    clients[0].ev.emit("connection.update", closeUpdate(428));
    t.mock.timers.tick(0);
    await waitFor(() => clients.length === 2);
    assert.equal(clients.length, 2);
    assert.equal(clients[0].endCalls, 1);
    assert.equal(manager.getSessionState().reconnectAttempt, 1);
    clients[0].ev.emit("connection.update", { connection: "open" });
    assert.equal(manager.isReady(), false);
    clients[1].ev.emit("connection.update", { connection: "open" });
    await flush();
    assert.equal(manager.isReady(), true);
    assert.equal(manager.getSessionState().reconnectAttempt, 0);
    assert.equal(manager.getSessionState().nextReconnectAt, null);
});

test("B1 boot failure retries fast with growing delays, then keeps a slow retry forever", async t => {
    const { manager, clients } = await createClientHarness(t, { failBoot: true });
    await assert.rejects(manager.initialize(), /boot timeout/);
    assert.equal(manager.getSessionState().nextReconnectAt, new Date(10000).toISOString());
    for (const [delay, count, nextTime] of [[0, 2, 11000], [1000, 3, 13000], [2000, 4, 15500], [2500, 5, 75500]]) {
        t.mock.timers.tick(delay);
        const expected = new Date(nextTime).toISOString();
        await waitFor(() => clients.length === count
            && manager.getSessionState().nextReconnectAt === expected);
        assert.equal(clients.length, count);
        assert.equal(manager.getSessionState().nextReconnectAt, expected);
    }

    // Fast attempts are exhausted: the next rebuild waits at the slow fixed interval, and the
    // session does not report itself as stopped or exhausted.
    t.mock.timers.tick(60000);
    await waitFor(() => clients.length === 6
        && manager.getSessionState().nextReconnectAt === new Date(15500 + 120000).toISOString());
    assert.equal(manager.getSessionState().reconnectAttempt, 5);

    t.mock.timers.tick(60000);
    await waitFor(() => clients.length === 7);
    assert.equal(manager.getSessionState().reconnectAttempt, 6);
});

test("B1 loggedOut close cancels retries and reports that a new QR is needed", async t => {
    const { manager, clients } = await createClientHarness(t);
    await manager.initialize();
    clients[0].ev.emit("connection.update", closeUpdate(428));
    clients[0].ev.emit("connection.update", closeUpdate(401));
    t.mock.timers.tick(100000);
    await waitFor(() => clients[0].endCalls === 1);
    await manager.initialize();
    assert.equal(clients.length, 1);
    assert.equal(manager.getSessionState().nextReconnectAt, null);
    assert.equal(manager.getSessionState().needsQrCode, true);
    assert.equal(clients[0].endCalls, 1);
});

test("B1 initialize replaces a known-dead client instead of returning it", async t => {
    const { manager, clients } = await createClientHarness(t);
    await manager.initialize();
    manager.updateState({ status: "error", ready: false });
    const next = await manager.initialize();
    assert.notEqual(next, clients[0]);
    assert.equal(clients[0].endCalls, 1);
    assert.equal(clients.length, 2);
});

test("B6 destroy cancels retry timers even after a failed boot cleared the client", async t => {
    const { manager, clients } = await createClientHarness(t, { failBoot: true });
    await assert.rejects(manager.initialize());
    await manager.destroy();
    t.mock.timers.tick(100000);
    await settle();
    assert.equal(clients.length, 1);
    assert.equal(manager.getSessionState().status, "idle");
    assert.equal(manager.getSessionState().nextReconnectAt, null);
});

/** Builds actual persisted Baileys credentials, without a real account. */
async function createProfiles(t, ids) {
    const authPath = await fs.mkdtemp(path.join(os.tmpdir(), "whatsbot-lifecycle-"));
    t.after(() => fs.rm(authPath, { recursive: true, force: true }));
    for (const id of ids) {
        const directory = path.join(authPath, "baileys", id);
        await fs.mkdir(directory, { recursive: true });
        await fs.writeFile(path.join(directory, "creds.json"), JSON.stringify({
            registered: true,
            me: { id: "5551999999999@s.whatsapp.net", name: "Pablo" },
        }));
    }
    return authPath;
}

/** Provides controllable startup clients and a metadata-only registry. */
function createSessionHarness(authPath, { boot = async () => {} } = {}) {
    const attempted = [];
    const manager = new WhatsAppSessionManager({
        config: { ...baseConfig, authPath }, logger,
        sessionAccessStore: { async initialize() {}, async listSessionIds() { return ["alpha", "beta", "main"]; } },
        clientFactory: ({ clientId }) => ({
            async initialize() { attempted.push(clientId); await boot(clientId); },
            async destroy() {}, isReady: () => false,
            getSessionState: () => ({ status: "qr", hasQrCode: true }),
        }),
    });
    return { manager, attempted };
}

test("B2 startup restores default and registered sessions sequentially in background, without duplicates", { timeout: 2000 }, async t => {
    const authPath = await createProfiles(t, ["main", "alpha", "beta"]);
    let release;
    let started;
    const entered = new Promise(resolve => { started = resolve; });
    const pending = new Promise(resolve => { release = resolve; });
    t.after(() => release());
    const { manager, attempted } = createSessionHarness(authPath, { boot: id => {
        if (id === "main") { started(); return pending; }
    } });
    await manager.initialize();
    await entered;
    assert.deepEqual(attempted, ["main"]);
    release();
    await manager.restorationPromise;
    assert.deepEqual(attempted, ["main", "alpha", "beta"]);
    await manager.destroy();
});

test("B2 one failed startup session does not abort remaining sessions", async t => {
    const authPath = await createProfiles(t, ["main", "alpha", "beta"]);
    const { manager, attempted } = createSessionHarness(authPath, { boot: async id => {
        if (id === "alpha") throw new Error("boot failed");
    } });
    await manager.initialize();
    await manager.restorationPromise;
    assert.deepEqual(attempted, ["main", "alpha", "beta"]);
    assert.equal(manager.sessions.has("alpha"), true); // Retain its retry owner.
    await manager.destroy();
});

test("B2/B4 startup skips sessions without credentials but explicit state reads still boot their QR", async t => {
    const authPath = await createProfiles(t, ["alpha", "beta"]);
    await fs.mkdir(path.join(authPath, "baileys", "main"), { recursive: true });
    const { manager, attempted } = createSessionHarness(authPath);
    await manager.initialize();
    await manager.restorationPromise;
    assert.deepEqual(attempted, ["alpha", "beta"]);
    assert.equal(manager.getActiveSessionCount(), 2);
    const state = await manager.getSessionState("main");
    assert.equal(state.hasQrCode, true);
    assert.deepEqual(attempted, ["alpha", "beta", "main"]);
    await manager.destroy();
});

test("B2 hasAuthProfile requires registered credentials or a paired account", async t => {
    const authPath = await createProfiles(t, ["alpha"]);
    const manager = new WhatsAppSessionManager({
        config: { ...baseConfig, authPath },
        logger,
        clientFactory: () => ({ async initialize() {}, async destroy() {}, isReady: () => false, getSessionState: () => ({}) }),
        sessionAccessStore: { async initialize() {}, async listSessionIds() { return []; } },
    });

    assert.equal(await manager.hasAuthProfile("alpha"), true);
    assert.equal(await manager.hasAuthProfile("missing"), false);

    const emptyDirectory = path.join(authPath, "baileys", "unpaired");
    await fs.mkdir(emptyDirectory, { recursive: true });
    await fs.writeFile(path.join(emptyDirectory, "creds.json"), JSON.stringify({ registered: false }));
    assert.equal(await manager.hasAuthProfile("unpaired"), false);
});

test("B2 registry lists known ids after initialization without exposing credentials", async t => {
    const store = new WhatsAppSessionAccessStore({ sessionAccessModel: {
        async find() { return [{ sessionId: "alpha", accessTokenHash: "private" }, { sessionId: "beta" }]; },
    } });
    let initialized = false;
    store.initialize = async () => { initialized = true; };
    assert.deepEqual(await store.listSessionIds(), ["alpha", "beta"]);
    assert.equal(initialized, true);
});

test("B3 repeated session polls back off failed group reads, preserve cache and log a distinct error once", async t => {
    t.mock.timers.enable({ apis: ["Date"], now: 10000 });
    const errors = [];
    const client = new WhatsAppClientManager({ ...baseConfig, authPath: "/unused" }, { logger: { error: (...args) => errors.push(args) } });
    client.state.ready = true;
    const cached = { contacts: [{ label: "Alice" }], groups: [], refreshedAt: new Date(0).toISOString() };
    client.state.chatDirectory = cached;
    let reads = 0;
    client.client = {
        async groupFetchAllParticipating() { reads += 1; throw new Error("r: r"); },
    };
    const sessions = new WhatsAppSessionManager({ config: { ...baseConfig, authPath: "/unused" }, logger, clientFactory: () => client });
    // Keep the cache expired while exercising exactly the public state-read path.
    t.mock.timers.setTime(100000);
    for (let i = 0; i < 10; i += 1) {
        const state = await sessions.getSessionState("main");
        assert.deepEqual(state.chatDirectory, cached);
        assert.equal(state.ready, true);
    }
    assert.equal(reads, 1);
    assert.equal(errors.length, 1);
    t.mock.timers.setTime(100999);
    await sessions.getSessionState("main");
    assert.equal(reads, 1);
    t.mock.timers.setTime(101000);
    await sessions.getSessionState("main");
    assert.equal(reads, 2);
    assert.equal(errors.length, 1);
    client.client.groupFetchAllParticipating = async () => ({});
    t.mock.timers.setTime(102000);
    assert.deepEqual((await sessions.getSessionState("main")).chatDirectory.contacts, [{ label: "Alice" }]);
});

for (const [label, returned, expected] of [
    ["key id", { key: { id: "key-1" } }, "key-1"],
    ["raw data id", { _data: { id: { id: "raw-1" } } }, "raw-1"],
    ["id component", { id: { id: "component-1" } }, "component-1"],
    ["string id", { id: "string-1" }, "string-1"],
    ["missing id", {}, null],
]) {
    test(`B5 dispatcher persists ${label} without inventing an identifier`, async () => {
        const warnings = [];
        const client = new WhatsAppClientManager({ ...baseConfig, authPath: "/unused" }, { logger: { warn: (...args) => warnings.push(args) } });
        client.state.ready = true;
        client.client = { sendMessage: async () => returned };
        const sessions = new WhatsAppSessionManager({ config: { ...baseConfig, authPath: "/unused" }, clientFactory: () => client });
        let persisted;
        const dispatcher = new MessageDispatcher({ whatsappClient: sessions,
            scheduledMessageModel: { async markSent(_id, result) { persisted = result; }, async markFailed() { assert.fail("send must succeed"); } } });
        await dispatcher.dispatchScheduledMessage({ id: 1, sessionId: "main", targetType: "group", targetValue: "123456789@g.us", message: "hello" });
        assert.equal(persisted.whatsappMessageId, expected);
        assert.equal(warnings.length, expected === null ? 1 : 0);
    });
}

test("B6 a ready event cancels a reconnect already waiting for the original boot", async t => {
    const { manager, clients } = await createClientHarness(t);
    let release;
    const boot = manager.bootClient.bind(manager);
    manager.bootClient = async () => {
        const client = await boot();
        await new Promise(resolve => { release = resolve; });
        return client;
    };
    const initialization = manager.initialize();
    await settle();
    clients[0].ev.emit("connection.update", closeUpdate(428));
    t.mock.timers.tick(0);
    await settle();
    clients[0].ev.emit("connection.update", { connection: "open" });
    release();
    await initialization;
    await settle();
    assert.equal(clients.length, 1);
    assert.equal(manager.getSessionState().reconnectAttempt, 0);
    assert.equal(manager.getSessionState().nextReconnectAt, null);
});

test("B6 disposed sockets cannot overwrite the replacement state through stale events", async t => {
    const authPath = await createAuthPath(t);
    const manager = new WhatsAppClientManager({ ...baseConfig, authPath }, { logger });
    const old = createFakeSocket();
    manager.client = old;
    manager.registerLifecycleHandlers();
    await manager.disposeClient();
    manager.client = createFakeSocket();
    manager.updateState({ status: "initializing", ready: false });
    old.ev.emit("connection.update", { connection: "open" });
    assert.equal(manager.isReady(), false);
    await manager.destroy();
});

test("B5 sent message id comes from the Baileys key and is not replaced by later events", async t => {
    const authPath = await createAuthPath(t);
    const client = new WhatsAppClientManager({ ...baseConfig, authPath }, { logger });
    const socket = createFakeSocket();
    socket.sendMessage = async () => ({ key: { id: "before-ack" }, status: 0 });
    client.client = socket;
    client.registerLifecycleHandlers();
    client.state.ready = true;
    const result = await client.sendMessage({ targetType: "group", targetValue: "123456789@g.us" }, "hello");
    assert.equal(result.whatsappMessageId, "before-ack");
    socket.ev.emit("messages.update", [{ key: { id: "unrelated" }, update: {} }]);
    assert.equal(result.whatsappMessageId, "before-ack");
    await client.destroy();
});

test("B2 a failed startup retry cannot overlap another session socket boot", async t => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10000 });
    const authPath = await createAuthPath(t);
    const boots = [];
    let release;
    let mainAttempts = 0;
    const sessions = new WhatsAppSessionManager({ config: { ...baseConfig, authPath }, logger,
        clientFactory: sessionConfig => {
            const client = new WhatsAppClientManager(sessionConfig, { logger,
                runClientBoot: operation => sessions.runClientBoot(operation) });
            client.initializeClient = async () => {
                boots.push(sessionConfig.clientId);
                if (sessionConfig.clientId === "main" && ++mainAttempts === 1) throw new Error("timeout");
                if (sessionConfig.clientId === "alpha") await new Promise(resolve => { release = resolve; });
                return {};
            };
            return client;
        },
    });
    t.after(async () => { release?.(); await sessions.destroy(); });
    await assert.rejects(sessions.ensureSession("main"), /timeout/);
    const alpha = sessions.ensureSession("alpha");
    await waitFor(() => boots.length === 2);
    t.mock.timers.tick(0);
    await settle();
    assert.deepEqual(boots, ["main", "alpha"]);
    release();
    await alpha;
    await waitFor(() => boots.length === 3);
    assert.deepEqual(boots, ["main", "alpha", "main"]);
});

test("B1 retry settings are configurable and invalid environment values remain bounded", () => {
    const defaults = createAppConfig({}).whatsapp;
    assert.equal(defaults.reconnectMaxAttempts, 5);
    assert.equal(defaults.reconnectDelayMs, 1000);
    assert.equal(defaults.reconnectMaxDelayMs, 30000);
    assert.equal(defaults.reconnectSlowRetryMs, 300000);
    assert.equal(defaults.executablePath, undefined);
    assert.equal(defaults.protocolTimeout, undefined);
    const custom = createAppConfig({ WHATSAPP_RECONNECT_MAX_ATTEMPTS: "2", WHATSAPP_RECONNECT_DELAY_MS: "10",
        WHATSAPP_RECONNECT_MAX_DELAY_MS: "50", WHATSAPP_RECONNECT_SLOW_RETRY_MS: "60000",
        WHATSAPP_CHAT_DIRECTORY_RETRY_MS: "100" }).whatsapp;
    assert.equal(custom.reconnectMaxAttempts, 2);
    assert.equal(custom.reconnectDelayMs, 10);
    assert.equal(custom.reconnectMaxDelayMs, 50);
    assert.equal(custom.reconnectSlowRetryMs, 60000);
    assert.equal(custom.chatDirectoryRetryMs, 100);
    const invalid = createAppConfig({ WHATSAPP_RECONNECT_MAX_ATTEMPTS: "-1", WHATSAPP_RECONNECT_DELAY_MS: "bad",
        WHATSAPP_RECONNECT_MAX_DELAY_MS: "-5", WHATSAPP_RECONNECT_SLOW_RETRY_MS: "-5" }).whatsapp;
    assert.equal(invalid.reconnectMaxAttempts, 0);
    assert.equal(invalid.reconnectDelayMs, 1000);
    assert.equal(invalid.reconnectMaxDelayMs, 1);
    assert.equal(invalid.reconnectSlowRetryMs, 1);
    // Legacy browser-era variables must be ignored, not crash startup.
    const legacy = createAppConfig({ WHATSAPP_PROTOCOL_TIMEOUT_MS: "1", PUPPETEER_EXECUTABLE_PATH: "/usr/bin/x" }).whatsapp;
    assert.equal(legacy.clientId, "main");
    assert.equal(legacy.executablePath, undefined);
});

test("B1 state reads expose the attempt count while a recovery boot is still pending", async t => {
    const { manager: client, clients } = await createClientHarness(t);
    await client.initialize();
    const sessions = new WhatsAppSessionManager({ config: { ...baseConfig, authPath: client.config.authPath }, logger, clientFactory: () => client });
    sessions.sessions.set("main", client);
    let release;
    const boot = client.bootClient.bind(client);
    client.bootClient = async () => {
        const result = await boot();
        await new Promise(resolve => { release = resolve; });
        return result;
    };
    t.after(() => release?.());
    clients[0].ev.emit("connection.update", closeUpdate(428));
    t.mock.timers.tick(0);
    await waitFor(() => client.getSessionState().reconnectAttempt === 1 && clients.length === 2);
    try {
        const state = await Promise.race([sessions.getSessionState("main"), flush().then(() => {
            throw new Error("state read waited for the socket boot");
        })]);
        assert.equal(state.status, "initializing");
        assert.equal(state.reconnectAttempt, 1);
        assert.equal(state.nextReconnectAt, null);
    } finally {
        release();
        await settle();
    }
});
