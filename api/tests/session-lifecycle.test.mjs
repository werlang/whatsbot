import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WhatsAppClientManager } from "../services/whatsapp-client-manager.js";
import { WhatsAppSessionManager } from "../services/whatsapp-session-manager.js";
import { WhatsAppSessionAccessStore } from "../services/whatsapp-session-access-store.js";
import { MessageDispatcher } from "../background/message-dispatcher.js";
import { createAppConfig } from "../config/app-config.js";

const config = { clientId: "main", authPath: "/unused", reconnectMaxAttempts: 4,
    reconnectDelayMs: 1000, reconnectMaxDelayMs: 2500, chatDirectoryRetryMs: 1000 };
const logger = { error() {}, warn() {} };

/** Waits for asynchronous lifecycle handlers without advancing retry timers. */
const flush = () => new Promise(resolve => setImmediate(resolve));

/** Creates browser doubles while exercising the real initialization and event handlers. */
function createClientHarness(t, { failBoot = false } = {}) {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10000 });
    const clients = [];
    const manager = new WhatsAppClientManager(config, { logger });
    manager.bootClient = async function () {
        const client = new EventEmitter();
        client.destroyCalls = 0;
        client.destroy = async () => { client.destroyCalls += 1; };
        client.getChats = async () => [];
        clients.push(client);
        this.client = client;
        this.registerLifecycleHandlers();
        if (failBoot) throw new Error("boot timeout");
        return client;
    };
    t.after(() => manager.destroy());
    return { manager, clients };
}

test("B1 disconnected rebuilds exactly once and ignores events from the disposed client", async t => {
    const { manager, clients } = createClientHarness(t);
    await manager.initialize();
    clients[0].emit("disconnected", "CONNECTION_LOST");
    clients[0].emit("disconnected", "CONNECTION_LOST");
    t.mock.timers.tick(0);
    await flush();
    assert.equal(clients.length, 2);
    assert.equal(clients[0].destroyCalls, 1);
    assert.equal(manager.getSessionState().reconnectAttempt, 1);
    clients[0].emit("ready");
    assert.equal(manager.isReady(), false);
    clients[1].emit("ready");
    assert.equal(manager.isReady(), true);
    assert.equal(manager.getSessionState().reconnectAttempt, 0);
    assert.equal(manager.getSessionState().nextReconnectAt, null);
});

test("B1 boot failure closes the browser and retries with growing capped delays then stops", async t => {
    const { manager, clients } = createClientHarness(t, { failBoot: true });
    await assert.rejects(manager.initialize(), /boot timeout/);
    assert.equal(clients[0].destroyCalls, 1);
    assert.equal(manager.getSessionState().nextReconnectAt, new Date(10000).toISOString());
    for (const [delay, count, nextTime] of [[0, 2, 11000], [1000, 3, 13000], [2000, 4, 15500], [2500, 5, null]]) {
        t.mock.timers.tick(delay);
        await flush();
        assert.equal(clients.length, count);
        assert.equal(manager.getSessionState().nextReconnectAt, nextTime === null ? null : new Date(nextTime).toISOString());
    }
    t.mock.timers.tick(100000);
    await manager.initialize(); // Polling must not bypass the attempt cap.
    assert.equal(clients.length, 5);
    assert.equal(manager.getSessionState().reconnectAttempt, 4);
});

for (const terminalEvent of ["auth_failure", "disconnected", "UNPAIRED", "UNPAIRED_IDLE"]) {
    test(`B1 ${terminalEvent} logout cancels retries and reports a new QR is needed`, async t => {
        const { manager, clients } = createClientHarness(t);
        await manager.initialize();
        clients[0].emit("disconnected", "CONNECTION_LOST");
        clients[0].emit(terminalEvent === "auth_failure" ? "auth_failure" : "disconnected",
            terminalEvent === "auth_failure" ? "invalid credentials" : terminalEvent === "disconnected" ? "LOGOUT" : terminalEvent);
        t.mock.timers.tick(100000);
        await flush();
        await manager.initialize();
        assert.equal(clients.length, 1);
        assert.equal(manager.getSessionState().nextReconnectAt, null);
        assert.equal(manager.getSessionState().needsQrCode, true);
        assert.equal(clients[0].destroyCalls, 1);
    });
}

test("B1 initialize replaces a known-dead client instead of returning it", async t => {
    const { manager, clients } = createClientHarness(t);
    await manager.initialize();
    manager.updateState({ status: "error", ready: false });
    const next = await manager.initialize();
    assert.notEqual(next, clients[0]);
    assert.equal(clients[0].destroyCalls, 1);
    assert.equal(clients.length, 2);
});

test("B6 destroy cancels retry timers even after a failed boot cleared the client", async t => {
    const { manager, clients } = createClientHarness(t, { failBoot: true });
    await assert.rejects(manager.initialize());
    await manager.destroy();
    t.mock.timers.tick(100000);
    await flush();
    assert.equal(clients.length, 1);
    assert.equal(manager.getSessionState().status, "idle");
    assert.equal(manager.getSessionState().nextReconnectAt, null);
});

/** Builds actual persisted Chromium storage markers, without a real account. */
async function createProfiles(t, ids) {
    const authPath = await fs.mkdtemp(path.join(os.tmpdir(), "whatsbot-lifecycle-"));
    t.after(() => fs.rm(authPath, { recursive: true, force: true }));
    for (const id of ids) {
        const storage = path.join(authPath, `session-${id}`, "Default", "IndexedDB", "https_web.whatsapp.com_0.indexeddb.leveldb");
        await fs.mkdir(storage, { recursive: true });
        await fs.writeFile(path.join(storage, "CURRENT"), "MANIFEST-000001");
    }
    return authPath;
}

/** Provides controllable startup clients and a metadata-only registry. */
function createSessionHarness(authPath, { boot = async () => {} } = {}) {
    const attempted = [];
    const manager = new WhatsAppSessionManager({
        config: { ...config, authPath }, logger,
        sessionAccessStore: { async initialize() {}, async listSessionIds() { return ["alpha", "beta", "main"]; } },
        clientFactory: ({ clientId }) => ({
            async initialize() { attempted.push(clientId); await boot(clientId); },
            async destroy() {}, isReady: () => false,
            getSessionState: () => ({ status: "qr", hasQrCode: true }),
        }),
    });
    return { manager, attempted };
}

test("B2 startup restores default and registered sessions sequentially in background, without duplicates", { timeout: 1000 }, async t => {
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

test("B2 one failed startup session does not abort remaining profiles", async t => {
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

test("B2/B4 startup skips profiles without auth data but explicit state reads still boot their QR", async t => {
    const authPath = await createProfiles(t, ["alpha", "beta"]);
    await fs.mkdir(path.join(authPath, "session-main", "Default"), { recursive: true });
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

test("B2 registry lists known ids after initialization without exposing credentials", async () => {
    const store = new WhatsAppSessionAccessStore({ sessionAccessModel: {
        async find() { return [{ sessionId: "alpha", accessTokenHash: "private" }, { sessionId: "beta" }]; },
    } });
    let initialized = false;
    store.initialize = async () => { initialized = true; };
    assert.deepEqual(await store.listSessionIds(), ["alpha", "beta"]);
    assert.equal(initialized, true);
});

test("B3 repeated session polls back off failed directories, preserve cache and log a distinct error once", async t => {
    t.mock.timers.enable({ apis: ["Date"], now: 10000 });
    const errors = [];
    const client = new WhatsAppClientManager(config, { logger: { error: (...args) => errors.push(args) } });
    client.state.ready = true;
    const cached = { contacts: [{ label: "Alice" }], groups: [], refreshedAt: new Date(0).toISOString() };
    client.state.chatDirectory = cached;
    let reads = 0;
    client.client = { getChats: async () => { reads += 1; throw new Error("r: r"); } };
    const sessions = new WhatsAppSessionManager({ config, logger, clientFactory: () => client });
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
    client.client.getChats = async () => [];
    t.mock.timers.setTime(102000);
    assert.deepEqual((await sessions.getSessionState("main")).chatDirectory.contacts, []);
});

for (const [label, returned, expected] of [
    ["serialized id", { id: { _serialized: "serialized-1" } }, "serialized-1"],
    ["raw data id", { _data: { id: { _serialized: "raw-1" } } }, "raw-1"],
    ["raw string id", { _data: { id: "raw-string-1" } }, "raw-string-1"],
    ["id component", { id: { id: "component-1" } }, "component-1"],
    ["string id", { id: "string-1" }, "string-1"],
    ["missing id", {}, null],
]) {
    test(`B5 dispatcher persists ${label} without inventing an identifier`, async () => {
        const warnings = [];
        const client = new WhatsAppClientManager(config, { logger: { warn: (...args) => warnings.push(args) } });
        client.state.ready = true;
        client.client = { sendMessage: async () => returned };
        const sessions = new WhatsAppSessionManager({ config, clientFactory: () => client });
        let persisted;
        const dispatcher = new MessageDispatcher({ whatsappClient: sessions,
            scheduledMessageModel: { async markSent(_id, result) { persisted = result; }, async markFailed() { assert.fail("send must succeed"); } } });
        await dispatcher.dispatchScheduledMessage({ id: 1, sessionId: "main", targetType: "group", targetValue: "123456789@g.us", message: "hello" });
        assert.equal(persisted.whatsappMessageId, expected);
        assert.equal(warnings.length, expected === null ? 1 : 0);
    });
}

test("B6 a ready event cancels a reconnect already waiting for the original boot", async t => {
    const { manager, clients } = createClientHarness(t);
    let release;
    const boot = manager.bootClient.bind(manager);
    manager.bootClient = async () => {
        const client = await boot();
        await new Promise(resolve => { release = resolve; });
        return client;
    };
    const initialization = manager.initialize();
    await flush();
    clients[0].emit("disconnected", "CONNECTION_LOST");
    t.mock.timers.tick(0);
    await flush();
    clients[0].emit("ready");
    release();
    await initialization;
    await flush();
    assert.equal(clients.length, 1);
    assert.equal(manager.getSessionState().reconnectAttempt, 0);
    assert.equal(manager.getSessionState().nextReconnectAt, null);
});

test("B6 disposed clients cannot overwrite the replacement state through stale events", async () => {
    const manager = new WhatsAppClientManager(config, { logger });
    const old = new EventEmitter();
    old.destroy = async () => {};
    manager.client = old;
    manager.registerLifecycleHandlers();
    await manager.disposeClient();
    manager.client = new EventEmitter();
    manager.updateState({ status: "initializing", ready: false });
    old.emit("ready");
    assert.equal(manager.isReady(), false);
    await manager.destroy();
});

test("B5 raw identifier is persisted before a later acknowledgement and is never replaced by an unrelated ack", async () => {
    const client = new WhatsAppClientManager(config, { logger });
    const browser = new EventEmitter();
    browser.sendMessage = async () => ({ _data: { id: { id: "before-ack" } }, ack: 0 });
    client.client = browser;
    client.registerLifecycleHandlers();
    client.state.ready = true;
    const result = await client.sendMessage({ targetType: "group", targetValue: "123456789@g.us" }, "hello");
    assert.equal(result.whatsappMessageId, "before-ack");
    browser.emit("message_ack", { id: { _serialized: "unrelated" } }, 1);
    browser.emit("message_ack", { id: { id: "before-ack" } }, 1);
    assert.equal(result.whatsappMessageId, "before-ack");
    await client.destroy();
});

test("B2 a failed startup retry cannot overlap another session browser boot", async t => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10000 });
    const boots = [];
    let release;
    let mainAttempts = 0;
    const sessions = new WhatsAppSessionManager({ config, logger,
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
    await flush();
    t.mock.timers.tick(0);
    await flush();
    assert.deepEqual(boots, ["main", "alpha"]);
    release();
    await alpha;
    await flush();
    assert.deepEqual(boots, ["main", "alpha", "main"]);
});


test("B1 retry settings are configurable and invalid environment values remain bounded", () => {
    const defaults = createAppConfig({}).whatsapp;
    assert.equal(defaults.reconnectMaxAttempts, 5);
    assert.equal(defaults.reconnectDelayMs, 1000);
    assert.equal(defaults.reconnectMaxDelayMs, 30000);
    const custom = createAppConfig({ WHATSAPP_RECONNECT_MAX_ATTEMPTS: "2", WHATSAPP_RECONNECT_DELAY_MS: "10",
        WHATSAPP_RECONNECT_MAX_DELAY_MS: "50", WHATSAPP_CHAT_DIRECTORY_RETRY_MS: "100" }).whatsapp;
    assert.equal(custom.reconnectMaxAttempts, 2);
    assert.equal(custom.reconnectDelayMs, 10);
    assert.equal(custom.reconnectMaxDelayMs, 50);
    assert.equal(custom.chatDirectoryRetryMs, 100);
    const invalid = createAppConfig({ WHATSAPP_RECONNECT_MAX_ATTEMPTS: "-1", WHATSAPP_RECONNECT_DELAY_MS: "bad",
        WHATSAPP_RECONNECT_MAX_DELAY_MS: "-5" }).whatsapp;
    assert.equal(invalid.reconnectMaxAttempts, 0);
    assert.equal(invalid.reconnectDelayMs, 1000);
    assert.equal(invalid.reconnectMaxDelayMs, 1);
});

test("B1 state reads expose the attempt count while a recovery boot is still pending", async t => {
    const { manager: client, clients } = createClientHarness(t);
    await client.initialize();
    const sessions = new WhatsAppSessionManager({ config, logger, clientFactory: () => client });
    sessions.sessions.set("main", client);
    let release;
    const boot = client.bootClient.bind(client);
    client.bootClient = async () => {
        const result = await boot();
        await new Promise(resolve => { release = resolve; });
        return result;
    };
    t.after(() => release?.());
    clients[0].emit("disconnected", "CONNECTION_LOST");
    t.mock.timers.tick(0);
    await flush();
    try {
        const state = await Promise.race([sessions.getSessionState("main"), flush().then(() => {
            throw new Error("state read waited for the browser boot");
        })]);
        assert.equal(state.status, "initializing");
        assert.equal(state.reconnectAttempt, 1);
        assert.equal(state.nextReconnectAt, null);
    } finally {
        release();
        await flush();
    }
});
