import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { WhatsAppClientManager } from "../services/whatsapp-client-manager.js";
import { WhatsAppSessionManager } from "../services/whatsapp-session-manager.js";

const silentLogger = {
    error() {},
    warn() {},
};

/** Waits for asynchronous event handlers without advancing retry timers. */
const flush = () => new Promise(resolve => setImmediate(resolve));

/** Waits for microtask chains such as QR PNG encoding. */
const settle = async () => {
    for (let index = 0; index < 20; index += 1) {
        await flush();
    }
};

/** Waits until a predicate holds, yielding real time between checks. */
async function waitFor(predicate, { attempts = 1000 } = {}) {
    for (let index = 0; index < attempts; index += 1) {
        if (await predicate()) {
            return;
        }

        await delay(1);
    }

    throw new Error("condition was not met in time");
}

/**
 * Creates one fake Baileys socket with an event emitter and the subset of the API the manager uses.
 *
 * @returns {object} Fake socket.
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
        async profilePictureUrl() {
            return undefined;
        },
        async groupFetchAllParticipating() {
            return {};
        },
    };

    return socket;
}

/**
 * Creates a temp auth path shared by one test.
 *
 * @param {object} t Test context.
 * @returns {Promise<string>} Temp directory.
 */
async function createAuthPath(t) {
    const authPath = await fs.mkdtemp(path.join(os.tmpdir(), "whatsbot-baileys-"));
    t.after(() => fs.rm(authPath, { recursive: true, force: true }));
    return authPath;
}

/**
 * Creates a manager whose socket factory returns fake sockets and records them.
 *
 * @param {object} t Test context.
 * @param {object} [options] Harness options.
 * @param {Function|null} [options.onSelfCommand] Self-command handler.
 * @param {string} [options.authPath] Existing auth path.
 * @param {boolean} [options.mockTimers] Enable fake timers.
 * @param {object} [options.config] Reconnect configuration overrides.
 * @returns {Promise<object>} Harness with the manager and every created socket.
 */
async function createHarness(t, {
    onSelfCommand = null,
    authPath = null,
    mockTimers = true,
    config = {},
} = {}) {
    if (mockTimers) {
        t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10000 });
    }

    const resolvedAuthPath = authPath || await createAuthPath(t);
    const sockets = [];
    const manager = new WhatsAppClientManager({
        clientId: "main",
        authPath: resolvedAuthPath,
        reconnectMaxAttempts: 4,
        reconnectDelayMs: 1000,
        reconnectMaxDelayMs: 2500,
        reconnectSlowRetryMs: 60000,
        chatDirectoryRetryMs: 1000,
        ...config,
    }, {
        logger: silentLogger,
        onSelfCommand,
        createAuthState: async () => ({ state: { creds: {}, keys: {} }, saveCreds: async () => {} }),
        createSocket: async () => {
            const socket = createFakeSocket();
            sockets.push(socket);
            return socket;
        },
    });

    t.after(() => manager.destroy());

    return { manager, sockets, authPath: resolvedAuthPath };
}

/**
 * Marks one fake socket as the paired account.
 *
 * @param {object} socket Fake socket.
 * @param {string} [id] PN jid with device suffix.
 * @param {string} [lid] LID jid.
 */
function pairSocket(socket, id = "5551999999999:12@s.whatsapp.net", lid = "12345678901234@lid") {
    socket.user = { id, lid, name: "Pablo Werlang" };
}

/** Builds one Baileys close update with the given status code. */
const closeUpdate = statusCode => ({
    connection: "close",
    lastDisconnect: { error: { output: { statusCode } } },
});

test("QR event exposes status qr plus a PNG data URL", async t => {
    const { manager, sockets } = await createHarness(t);
    await manager.initialize();

    sockets[0].ev.emit("connection.update", { qr: "2@abc,def" });
    await waitFor(() => manager.getSessionState().hasQrCode);

    const state = manager.getSessionState();
    assert.equal(state.status, "qr");
    assert.equal(state.ready, false);
    assert.equal(state.authenticated, false);
    assert.equal(state.hasQrCode, true);
    assert.match(state.qrCodeDataUrl, /^data:image\/png;base64,/);
    assert.equal(state.connectionState, "QR");
    assert.ok(state.qrCodeUpdatedAt);
});

test("open event reports ready, client information and clears the QR", async t => {
    const { manager, sockets } = await createHarness(t);
    await manager.initialize();
    pairSocket(sockets[0]);

    sockets[0].ev.emit("connection.update", { qr: "2@abc,def" });
    sockets[0].ev.emit("connection.update", { connection: "open" });
    await settle();

    const state = manager.getSessionState();
    assert.equal(state.status, "ready");
    assert.equal(state.ready, true);
    assert.equal(state.authenticated, true);
    assert.equal(state.hasQrCode, false);
    assert.equal(state.qrCodeDataUrl, null);
    assert.equal(state.connectionState, "CONNECTED");
    assert.equal(state.loading.percent, 100);
    assert.deepEqual(state.clientInfo, {
        wid: "5551999999999@c.us",
        phoneNumber: "5551999999999",
        pushname: "Pablo Werlang",
        platform: "baileys",
    });
});

test("loggedOut purges revoked credentials, keeps the directory snapshot and re-pairs on an explicit boot", async t => {
    const { manager, sockets, authPath } = await createHarness(t);
    const authDirectory = path.join(authPath, "baileys", "main");
    const credsPath = path.join(authDirectory, "creds.json");
    const keyPath = path.join(authDirectory, "app-state-sync-key-1.json");
    const snapshotPath = path.join(authDirectory, "chat-directory.json");

    await manager.initialize();
    pairSocket(sockets[0]);
    sockets[0].ev.emit("connection.update", { connection: "open" });
    await flush();

    await fs.mkdir(authDirectory, { recursive: true });
    await fs.writeFile(credsPath, JSON.stringify({ registered: true, me: { id: "5551999999999@s.whatsapp.net" } }));
    await fs.writeFile(keyPath, "{}");
    sockets[0].ev.emit("contacts.upsert", [{ id: "555391565003@s.whatsapp.net", name: "Alice" }]);
    await manager.flushChatDirectory();
    assert.equal(JSON.parse(await fs.readFile(snapshotPath, "utf8")).contacts.length, 1);

    sockets[0].ev.emit("connection.update", closeUpdate(401));
    await waitFor(async () => {
        try {
            await fs.access(credsPath);
            return false;
        } catch {
            return true;
        }
    });

    await assert.rejects(fs.access(credsPath));
    await assert.rejects(fs.access(keyPath));
    assert.equal(JSON.parse(await fs.readFile(snapshotPath, "utf8")).contacts.length, 1);
    assert.equal(sockets[0].endCalls, 1);

    const state = manager.getSessionState();
    assert.equal(state.status, "disconnected");
    assert.equal(state.needsQrCode, true);
    assert.equal(state.disconnectReason, "loggedOut");
    assert.equal(state.nextReconnectAt, null);

    // A restart must not consider the revoked pairing restorable.
    const sessions = new WhatsAppSessionManager({
        config: { ...manager.config, authPath },
        logger: silentLogger,
        clientFactory: () => manager,
        sessionAccessStore: { async initialize() {}, async listSessionIds() { return []; } },
    });
    assert.equal(await sessions.hasAuthProfile("main"), false);

    // The id and token are unchanged: an explicit session read boots a fresh QR.
    await sessions.getSessionState("main");
    await waitFor(() => sockets.length === 2);
    assert.equal(manager.getSessionState().needsQrCode, false);

    sockets[1].ev.emit("connection.update", { qr: "fresh-after-logout" });
    await waitFor(() => manager.getSessionState().hasQrCode === true);
    assert.equal(manager.getSessionState().status, "qr");
});

test("transient close schedules the bounded reconnect and recovers on a new socket", async t => {
    const { manager, sockets } = await createHarness(t);
    await manager.initialize();

    sockets[0].ev.emit("connection.update", {
        connection: "close",
        lastDisconnect: { error: { output: { statusCode: 428 } } },
    });
    await flush();

    let state = manager.getSessionState();
    assert.equal(state.status, "disconnected");
    assert.equal(state.needsQrCode, false);
    assert.equal(state.disconnectReason, "connectionClosed");
    assert.equal(state.nextReconnectAt, new Date(10000).toISOString());

    t.mock.timers.tick(0);
    await flush();

    assert.equal(sockets.length, 2);
    assert.equal(sockets[0].endCalls, 1);
    assert.equal(manager.getSessionState().reconnectAttempt, 1);

    pairSocket(sockets[1]);
    sockets[1].ev.emit("connection.update", { connection: "open" });
    await flush();

    state = manager.getSessionState();
    assert.equal(state.ready, true);
    assert.equal(state.reconnectAttempt, 0);
    assert.equal(state.nextReconnectAt, null);
});

test("QR-timeout closes keep producing a fresh QR beyond the fast attempt budget", async t => {
    const { manager, sockets } = await createHarness(t, { config: { reconnectMaxAttempts: 2 } });
    await manager.initialize();

    // More cycles than the fast budget: an unscanned QR timeout must not kill the session.
    for (let cycle = 0; cycle < 6; cycle += 1) {
        const socket = sockets.at(-1);
        socket.ev.emit("connection.update", { qr: `cycle-${cycle}` });
        await waitFor(() => {
            const state = manager.getSessionState();

            return state.hasQrCode && state.reconnectAttempt === 0;
        });

        socket.ev.emit("connection.update", closeUpdate(408));
        t.mock.timers.tick(0);
        await waitFor(() => sockets.length === cycle + 2);
    }

    const lastSocket = sockets.at(-1);
    lastSocket.ev.emit("connection.update", { qr: "cycle-final" });
    await waitFor(() => manager.getSessionState().hasQrCode);

    const state = manager.getSessionState();
    assert.equal(sockets.length, 7);
    assert.equal(state.status, "qr");
    assert.equal(state.hasQrCode, true);
    assert.equal(state.reconnectAttempt, 0);
});

test("failed closes beyond the fast budget schedule a slow retry and a later open resets it", async t => {
    const { manager, sockets } = await createHarness(t, {
        config: {
            reconnectMaxAttempts: 2,
            reconnectDelayMs: 1000,
            reconnectMaxDelayMs: 1000,
            reconnectSlowRetryMs: 60000,
        },
    });
    await manager.initialize();

    sockets[0].ev.emit("connection.update", closeUpdate(428));
    t.mock.timers.tick(0);
    await waitFor(() => sockets.length === 2);

    sockets[1].ev.emit("connection.update", closeUpdate(428));
    await waitFor(() => manager.getSessionState().nextReconnectAt === new Date(11000).toISOString());
    t.mock.timers.tick(1000);
    await waitFor(() => sockets.length === 3);

    sockets[2].ev.emit("connection.update", closeUpdate(428));
    await waitFor(() => manager.getSessionState().nextReconnectAt === new Date(71000).toISOString());
    assert.equal(sockets.length, 3);

    t.mock.timers.tick(60000);
    await waitFor(() => sockets.length === 4 && manager.getSessionState().reconnectAttempt === 3);

    sockets[3].ev.emit("connection.update", { connection: "open" });
    await flush();

    let state = manager.getSessionState();
    assert.equal(state.ready, true);
    assert.equal(state.reconnectAttempt, 0);
    assert.equal(state.nextReconnectAt, null);

    // A later transient close starts the fast budget again.
    sockets[3].ev.emit("connection.update", closeUpdate(428));
    state = manager.getSessionState();
    assert.equal(state.nextReconnectAt, new Date(71000).toISOString());
});

test("loggedOut after the fast budget is exhausted stops automatic retries but re-pairs on an explicit boot", async t => {
    const { manager, sockets } = await createHarness(t, {
        config: { reconnectMaxAttempts: 1, reconnectSlowRetryMs: 60000 },
    });
    await manager.initialize();

    sockets[0].ev.emit("connection.update", closeUpdate(428));
    t.mock.timers.tick(0);
    await waitFor(() => sockets.length === 2);

    sockets[1].ev.emit("connection.update", closeUpdate(428));
    await waitFor(() => manager.getSessionState().nextReconnectAt === new Date(70000).toISOString());

    sockets[1].ev.emit("connection.update", closeUpdate(401));
    await waitFor(() => manager.getSessionState().needsQrCode === true);

    assert.equal(manager.getSessionState().nextReconnectAt, null);
    t.mock.timers.tick(1000000);
    await flush();
    assert.equal(sockets.length, 2);

    await manager.initialize();
    assert.equal(sockets.length, 3);
    assert.equal(manager.getSessionState().needsQrCode, false);
});

test("a stale socket cannot publish events after it was replaced", async t => {
    const { manager, sockets } = await createHarness(t);
    await manager.initialize();
    sockets[0].ev.emit("connection.update", {
        connection: "close",
        lastDisconnect: { error: { output: { statusCode: 428 } } },
    });
    t.mock.timers.tick(0);
    await flush();

    sockets[0].ev.emit("connection.update", { connection: "open" });
    await flush();
    assert.equal(manager.isReady(), false);

    sockets[1].ev.emit("connection.update", { connection: "open" });
    await flush();
    assert.equal(manager.isReady(), true);
});

test("self commands are detected on the PN self chat and replied once", async t => {
    const commands = [];
    const { manager, sockets } = await createHarness(t, {
        onSelfCommand: async command => {
            commands.push(command);
            return { reply: "Scheduled 5551999999999 for 2026-11-20T13:00:00.000Z." };
        },
    });
    await manager.initialize();
    pairSocket(sockets[0]);
    sockets[0].ev.emit("connection.update", { connection: "open" });
    await flush();

    const message = {
        key: { fromMe: true, remoteJid: "5551999999999@s.whatsapp.net", id: "cmd-1" },
        message: { conversation: "@whatsbot 5551999999999 2026-11-20-10-00-00 hello" },
    };
    sockets[0].ev.emit("messages.upsert", { type: "notify", messages: [message] });
    await flush();
    await flush();

    assert.equal(commands.length, 1);
    assert.equal(commands[0].sessionId, "main");
    assert.equal(commands[0].source.whatsappMessageId, "cmd-1");
    assert.deepEqual(sockets[0].sent, [{
        jid: "5551999999999@s.whatsapp.net",
        content: { text: "Scheduled 5551999999999 for 2026-11-20T13:00:00.000Z." },
    }]);

    // The same command replayed as an append must not schedule twice.
    sockets[0].ev.emit("messages.upsert", { type: "append", messages: [message] });
    await flush();
    assert.equal(commands.length, 1);
    assert.equal(sockets[0].sent.length, 1);
});

test("self commands are detected on the LID self chat", async t => {
    const commands = [];
    const { manager, sockets } = await createHarness(t, {
        onSelfCommand: async command => {
            commands.push(command);
            return { reply: "ok" };
        },
    });
    await manager.initialize();
    pairSocket(sockets[0]);
    sockets[0].ev.emit("connection.update", { connection: "open" });
    await flush();

    sockets[0].ev.emit("messages.upsert", {
        type: "notify",
        messages: [{
            key: { fromMe: true, remoteJid: "12345678901234@lid", remoteJidAlt: "5551999999999@s.whatsapp.net", id: "cmd-lid" },
            message: { extendedTextMessage: { text: "@whatsbot 5551999999999 2026-11-20-10-00-00 hello" } },
        }],
    });
    await flush();
    await flush();

    assert.equal(commands.length, 1);
    assert.deepEqual(sockets[0].sent, [{ jid: "12345678901234@lid", content: { text: "ok" } }]);
});

test("commands sent to another chat are ignored", async t => {
    const commands = [];
    const { manager, sockets } = await createHarness(t, {
        onSelfCommand: async command => {
            commands.push(command);
            return { reply: "ok" };
        },
    });
    await manager.initialize();
    pairSocket(sockets[0]);
    sockets[0].ev.emit("connection.update", { connection: "open" });
    await flush();

    sockets[0].ev.emit("messages.upsert", {
        type: "notify",
        messages: [{
            key: { fromMe: true, remoteJid: "120363043210123456@g.us", id: "group-cmd" },
            message: { conversation: "@whatsbot 5551999999999 2026-11-20-10-00-00 hello" },
        }],
    });
    await flush();

    assert.equal(commands.length, 0);
});

test("send resolves Brazil candidates through onWhatsApp and reports the public chat id", async t => {
    const { manager, sockets } = await createHarness(t);
    await manager.initialize();
    const socket = sockets[0];
    manager.state.ready = true;

    const lookedUp = [];
    socket.onWhatsApp = async phoneNumber => {
        lookedUp.push(phoneNumber);
        return phoneNumber === "5551997771055"
            ? [{ jid: "5551997771055@s.whatsapp.net", exists: true }]
            : [];
    };
    socket.sendMessage = async (jid, content) => {
        socket.sent.push({ jid, content });
        return { key: { id: "wamid-1" }, messageTimestamp: 1776254400 };
    };

    const result = await manager.sendMessage("55519997771055", "hello world");

    assert.deepEqual(lookedUp, ["55519997771055", "5551997771055"]);
    assert.deepEqual(socket.sent, [{
        jid: "5551997771055@s.whatsapp.net",
        content: { text: "hello world" },
    }]);
    assert.equal(result.chatId, "5551997771055@c.us");
    assert.equal(result.phoneNumber, "55519997771055");
    assert.equal(result.targetType, "contact");
    assert.equal(result.whatsappMessageId, "wamid-1");
    assert.equal(result.sentAt, new Date(1776254400 * 1000).toISOString());
});

test("send delivers group messages directly to the group jid", async t => {
    const { manager, sockets } = await createHarness(t);
    await manager.initialize();
    manager.state.ready = true;

    const result = await manager.sendMessage({
        targetType: "group",
        targetValue: "120363043210123456@g.us",
    }, "hello group");

    assert.deepEqual(sockets[0].sent, [{
        jid: "120363043210123456@g.us",
        content: { text: "hello group" },
    }]);
    assert.equal(result.chatId, "120363043210123456@g.us");
    assert.equal(result.phoneNumber, null);
    assert.equal(result.targetType, "group");
});

test("send fails with a friendly message when no account is registered", async t => {
    const { manager } = await createHarness(t);
    await manager.initialize();
    manager.state.ready = true;

    await assert.rejects(
        () => manager.sendMessage("5551999999999", "hello"),
        /could not resolve a registered account/i,
    );
});

test("directory is built from Baileys events and filtered by addressability", async t => {
    const { manager, sockets } = await createHarness(t);
    await manager.initialize();
    manager.state.ready = true;

    sockets[0].ev.emit("contacts.upsert", [
        { id: "555391565003@s.whatsapp.net", name: "Vinícius Alves Hax" },
        { id: "555391565003@s.whatsapp.net", name: "" },
        { id: "555195171104@s.whatsapp.net", notify: "Vinicius" },
        { id: "5551991111111@s.whatsapp.net", notify: "  Álvaro  " },
        { id: "38865310056602@lid", name: "LID person" },
        { id: "status@broadcast", name: "Status" },
    ]);
    sockets[0].ev.emit("chats.upsert", [
        { id: "120363043210123456@g.us", name: "Águias" },
        { id: "120363043210123457@g.us", name: "Zulu equipe" },
        { id: "5551888888888@s.whatsapp.net", name: "5551888888888" },
    ]);
    await flush();

    const directory = manager.getSessionState().chatDirectory;

    assert.deepEqual(directory.contacts.map(entry => entry.id), [
        "5551991111111@c.us",
        "555195171104@c.us",
        "555391565003@c.us",
    ]);
    assert.deepEqual(directory.contacts[2], {
        id: "555391565003@c.us",
        name: "Vinícius Alves Hax",
        targetType: "contact",
        targetValue: "555391565003",
        phoneNumber: "555391565003",
        chatId: "555391565003@c.us",
        label: "Vinícius Alves Hax",
    });
    assert.deepEqual(directory.groups.map(entry => [entry.name, entry.id]), [
        ["Águias", "120363043210123456@g.us"],
        ["Zulu equipe", "120363043210123457@g.us"],
    ]);
    assert.equal(directory.contacts.some(entry => entry.id === "5551888888888@c.us"), false);
});

test("group metadata refresh enriches groups without polling contacts", async t => {
    const { manager, sockets } = await createHarness(t);
    await manager.initialize();
    manager.state.ready = true;

    let groupFetches = 0;
    sockets[0].groupFetchAllParticipating = async () => {
        groupFetches += 1;
        return {
            "120363043210123456@g.us": { id: "120363043210123456@g.us", subject: "Launch Team" },
        };
    };

    const forced = await manager.refreshChatDirectory({ force: true });
    assert.equal(groupFetches, 1);
    assert.deepEqual(forced.groups.map(entry => entry.name), ["Launch Team"]);

    const cached = await manager.refreshChatDirectory();
    assert.equal(groupFetches, 1);
    assert.deepEqual(cached.groups.map(entry => entry.name), ["Launch Team"]);

    t.mock.timers.tick(10 * 60 * 1000);
    await manager.refreshChatDirectory();
    assert.equal(groupFetches, 2);
});

test("a failing group refresh keeps the snapshot, logs once and backs off", async t => {
    const errors = [];
    let groupFetches = 0;
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 50000 });
    const authPath = await createAuthPath(t);
    const manager = new WhatsAppClientManager({
        clientId: "main",
        authPath,
        chatDirectoryRetryMs: 30000,
    }, {
        logger: { error: (...args) => errors.push(args.map(String).join(" ")), warn() {} },
        createAuthState: async () => ({ state: { creds: {}, keys: {} }, saveCreds: async () => {} }),
        createSocket: async () => {
            const socket = createFakeSocket();
            socket.groupFetchAllParticipating = async () => {
                groupFetches += 1;
                throw new Error("group metadata unavailable");
            };
            return socket;
        },
    });
    await manager.initialize();
    manager.state.ready = true;
    manager.client.ev.emit("contacts.upsert", [{ id: "555391565003@s.whatsapp.net", name: "Alice" }]);

    for (let index = 0; index < 10; index += 1) {
        const snapshot = await manager.refreshChatDirectory({ force: index === 0 });
        assert.deepEqual(snapshot.contacts.map(entry => entry.name), ["Alice"]);
    }

    assert.equal(groupFetches, 1);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /could not refresh the chat directory/i);

    t.mock.timers.setTime(79999);
    await manager.refreshChatDirectory({ force: true });
    assert.equal(groupFetches, 1);

    t.mock.timers.setTime(80000);
    await manager.refreshChatDirectory({ force: true });
    assert.equal(groupFetches, 2);
    assert.equal(errors.length, 1, "an identical failure is logged once");

    await manager.destroy();
});

test("directory snapshot survives a restart and keeps accepting events", async t => {
    const authPath = await createAuthPath(t);
    const first = await createHarness(t, { authPath, mockTimers: false });
    await first.manager.initialize();
    first.manager.state.ready = true;
    first.sockets[0].ev.emit("contacts.upsert", [
        { id: "555391565003@s.whatsapp.net", name: "Vinícius Alves Hax" },
    ]);
    first.sockets[0].ev.emit("chats.upsert", [
        { id: "120363043210123456@g.us", name: "Águias" },
    ]);
    const baseline = first.manager.getSessionState().chatDirectory;
    assert.equal(baseline.contacts.length, 1);
    await first.manager.flushChatDirectory();
    await first.manager.destroy();

    const second = await createHarness(t, { authPath, mockTimers: false });
    await second.manager.initialize();

    assert.deepEqual(second.manager.getSessionState().chatDirectory, baseline);

    second.sockets[0].ev.emit("contacts.upsert", [
        { id: "555195171104@s.whatsapp.net", notify: "Vinicius" },
    ]);
    await flush();

    const directory = second.manager.getSessionState().chatDirectory;
    assert.deepEqual(directory.contacts.map(entry => entry.name), ["Vinicius", "Vinícius Alves Hax"]);
    assert.deepEqual(directory.groups.map(entry => entry.name), ["Águias"]);
});

test("directory membership is a set lookup that never clones the snapshot", async t => {
    const { manager, sockets } = await createHarness(t);
    await manager.initialize();
    manager.state.ready = true;
    sockets[0].ev.emit("contacts.upsert", [
        { id: "555391565003@s.whatsapp.net", name: "Vinícius Alves Hax" },
    ]);
    sockets[0].ev.emit("chats.upsert", [
        { id: "120363043210123456@g.us", name: "Águias" },
    ]);
    await flush();

    manager.cloneChatDirectory = () => {
        throw new Error("the membership check must not clone the directory");
    };
    manager.getSessionState = () => {
        throw new Error("the membership check must not read session state");
    };

    assert.equal(manager.hasChatDirectoryTarget({ targetType: "contact", targetValue: "555391565003" }), true);
    assert.equal(manager.hasChatDirectoryTarget({ targetType: "group", targetValue: "120363043210123456@g.us" }), true);
    assert.equal(manager.hasChatDirectoryTarget({ targetType: "contact", targetValue: "5551999999999" }), false);
});
