import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { WhatsAppClientManager } from "../services/whatsapp-client-manager.js";
import { WhatsAppSessionManager } from "../services/whatsapp-session-manager.js";
import { readRecipientDirectory } from "../../web/public/js/helpers/recipient.js";

const baseConfig = {
    clientId: "main",
    chatDirectoryRetryMs: 30000,
};

const silentLogger = {
    error() {},
    warn() {},
};

const mixedContacts = [
    { id: "555391565003@s.whatsapp.net", name: "" },
    { id: "555391565003@s.whatsapp.net", name: "Vinícius Alves Hax" },
    { id: "555391565003@s.whatsapp.net", name: "" },
    { id: "555195171104@s.whatsapp.net", name: "Vinicius" },
    { id: "555195171104@s.whatsapp.net", name: "Vinicius" },
    { id: "5551991111111@s.whatsapp.net", notify: "  Álvaro  " },
    { id: "5551992222222@s.whatsapp.net", notify: "Zulu" },
    { id: "5551993333333@s.whatsapp.net", notify: "   " },
    { id: "38865310056602@lid", name: "LID person" },
    { id: "status@broadcast", name: "Status" },
    { id: "not-a-phone@c.us", name: "Bad" },
    { id: "120363043210123456@g.us", name: "" },
    { id: "120363043210123456@g.us", name: "Águias" },
    { id: "120363043210123457@g.us", name: "Zulu equipe" },
];

/**
 * Creates one fake Baileys socket for directory events.
 */
function createFakeSocket() {
    return {
        ev: new EventEmitter(),
        user: undefined,
        async end() {},
        async sendMessage() {
            return { key: { id: "wamid-fake" } };
        },
        async onWhatsApp() {
            return [];
        },
        async groupFetchAllParticipating() {
            return {};
        },
    };
}

/**
 * Creates one manager already marked ready with an injected fake socket.
 */
async function createReadyManager(t, { socket = createFakeSocket(), config = baseConfig } = {}) {
    const authPath = await fs.mkdtemp(path.join(os.tmpdir(), "whatsbot-directory-"));
    t.after(() => fs.rm(authPath, { recursive: true, force: true }));
    const manager = new WhatsAppClientManager({ ...config, authPath }, { logger: silentLogger });
    manager.state.ready = true;
    manager.client = socket;
    manager.registerLifecycleHandlers();
    t.after(() => manager.destroy());

    return manager;
}

/**
 * Emits one history batch with the provided chats and contacts.
 */
function emitHistory(socket, chats, contacts, lidPnMappings = []) {
    socket.ev.emit("messaging-history.set", { chats, contacts, lidPnMappings, messages: [] });
}

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

test("directory builds contacts and groups from history sync events", async t => {
    const socket = createFakeSocket();
    const manager = await createReadyManager(t, { socket });

    emitHistory(
        socket,
        mixedContacts.filter(entry => entry.id.endsWith("@g.us")),
        mixedContacts.filter(entry => !entry.id.endsWith("@g.us")),
    );

    const directory = manager.getSessionState().chatDirectory;

    assert.deepEqual(directory.contacts.map(entry => entry.id), [
        "5551991111111@c.us",
        "555195171104@c.us",
        "555391565003@c.us",
        "5551992222222@c.us",
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
    assert.deepEqual(directory.groups, [
        {
            id: "120363043210123456@g.us",
            name: "Águias",
            targetType: "group",
            targetValue: "120363043210123456@g.us",
            phoneNumber: null,
            chatId: "120363043210123456@g.us",
            label: "Águias",
        },
        {
            id: "120363043210123457@g.us",
            name: "Zulu equipe",
            targetType: "group",
            targetValue: "120363043210123457@g.us",
            phoneNumber: null,
            chatId: "120363043210123457@g.us",
            label: "Zulu equipe",
        },
    ]);
    assert.equal(typeof directory.refreshedAt, "string");
});

test("directory accepts an empty history batch", async t => {
    const socket = createFakeSocket();
    const manager = await createReadyManager(t, { socket });

    emitHistory(socket, [], []);
    const directory = manager.getSessionState().chatDirectory;

    assert.deepEqual(directory.contacts, []);
    assert.deepEqual(directory.groups, []);
});

test("directory filters unaddressable and unnamed people and keeps addressable LID contacts", async t => {
    const socket = createFakeSocket();
    const manager = await createReadyManager(t, { socket });

    socket.ev.emit("contacts.upsert", [
        { id: "38865310056602@lid", name: "LID person" },
        { id: "status@broadcast", name: "Status" },
        { id: "5551999999999@broadcast", name: "Broadcast" },
        { id: "not-a-phone@c.us", name: "Bad" },
        { id: "12345@c.us", name: "Too Short" },
        { id: "5551993333333@s.whatsapp.net", notify: "   " },
        { id: "5551994444444@s.whatsapp.net", phoneNumber: "5551994444444@s.whatsapp.net" },
        { id: "555197771055@lid", name: "LID with phone", phoneNumber: "555197771055@s.whatsapp.net" },
        { id: "5551995555555@s.whatsapp.net", notify: "Push Contact" },
    ]);
    socket.ev.emit("chats.upsert", [
        { id: "x@g.us", name: "Invalid Group" },
        { id: "120363043210123458@g.us", name: "   " },
    ]);

    const directory = manager.getSessionState().chatDirectory;

    assert.deepEqual(directory.contacts.map(entry => [entry.id, entry.name]), [
        ["555197771055@c.us", "LID with phone"],
        ["5551995555555@c.us", "Push Contact"],
    ]);
    assert.deepEqual(directory.groups, [{
        id: "120363043210123458@g.us",
        name: "120363043210123458@g.us",
        targetType: "group",
        targetValue: "120363043210123458@g.us",
        phoneNumber: null,
        chatId: "120363043210123458@g.us",
        label: "120363043210123458@g.us",
    }]);
});

test("directory deduplicates by id and ignores unnamed duplicates", async t => {
    const socket = createFakeSocket();
    const manager = await createReadyManager(t, { socket });

    socket.ev.emit("chats.upsert", [
        { id: "555391565003@s.whatsapp.net", name: "Vinícius Alves Hax" },
        { id: "555391565003@s.whatsapp.net", name: "" },
        { id: "120363043210123456@g.us", name: "Águias" },
        { id: "120363043210123456@g.us", name: "" },
    ]);

    const directory = manager.getSessionState().chatDirectory;

    assert.deepEqual(directory.contacts.map(entry => [entry.id, entry.name]), [
        ["555391565003@c.us", "Vinícius Alves Hax"],
    ]);
    assert.deepEqual(directory.groups.map(entry => [entry.id, entry.name]), [
        ["120363043210123456@g.us", "Águias"],
    ]);
});

test("directory applies later contact renames to the same entry", async t => {
    const socket = createFakeSocket();
    const manager = await createReadyManager(t, { socket });

    socket.ev.emit("contacts.upsert", [
        { id: "555391565003@s.whatsapp.net", name: "Vinícius" },
    ]);
    socket.ev.emit("contacts.update", [
        { id: "555391565003@s.whatsapp.net", name: "Vinícius Alves Hax" },
    ]);

    assert.equal(manager.getSessionState().chatDirectory.contacts[0].name, "Vinícius Alves Hax");
});

test("directory sorts contacts and groups by pt-BR name", async t => {
    const socket = createFakeSocket();
    const manager = await createReadyManager(t, { socket });

    socket.ev.emit("contacts.upsert", [
        { id: "5551999999999@s.whatsapp.net", name: "Ana" },
        { id: "5551900000001@s.whatsapp.net", name: "Ana" },
        { id: "5551992222222@s.whatsapp.net", name: "Zulu" },
        { id: "5551991111111@s.whatsapp.net", name: "Álvaro" },
        { id: "555391565003@s.whatsapp.net", name: "Vinícius Alves Hax" },
        { id: "555195171104@s.whatsapp.net", name: "Vinicius" },
    ]);
    socket.ev.emit("chats.upsert", [
        { id: "120363043210123457@g.us", name: "Zulu equipe" },
        { id: "120363043210123459@g.us", name: "Comercial" },
        { id: "120363043210123458@g.us", name: "Comercial" },
        { id: "120363043210123456@g.us", name: "Águias" },
    ]);

    const directory = manager.getSessionState().chatDirectory;

    assert.deepEqual(
        directory.contacts.map(entry => [entry.name, entry.id]),
        [
            ["Álvaro", "5551991111111@c.us"],
            ["Ana", "5551900000001@c.us"],
            ["Ana", "5551999999999@c.us"],
            ["Vinicius", "555195171104@c.us"],
            ["Vinícius Alves Hax", "555391565003@c.us"],
            ["Zulu", "5551992222222@c.us"],
        ],
    );
    assert.deepEqual(
        directory.groups.map(entry => [entry.name, entry.id]),
        [
            ["Águias", "120363043210123456@g.us"],
            ["Comercial", "120363043210123458@g.us"],
            ["Comercial", "120363043210123459@g.us"],
            ["Zulu equipe", "120363043210123457@g.us"],
        ],
    );
});

test("directory preserves legacy picker fields and session snapshot isolation", async t => {
    const socket = createFakeSocket();
    const manager = await createReadyManager(t, { socket });
    socket.ev.emit("contacts.upsert", mixedContacts.filter(entry => !entry.id.endsWith("@g.us")));
    socket.ev.emit("chats.upsert", mixedContacts.filter(entry => entry.id.endsWith("@g.us")));
    socket.groupFetchAllParticipating = async () => ({
        "120363043210123456@g.us": { id: "120363043210123456@g.us", subject: "Águias" },
        "120363043210123457@g.us": { id: "120363043210123457@g.us", subject: "Zulu equipe" },
    });

    const sessions = new WhatsAppSessionManager({
        config: baseConfig,
        logger: silentLogger,
        clientFactory: () => manager,
        sessionAccessStore: { async initialize() {} },
    });

    const snapshot = await sessions.getSessionState("main");
    const pickerDirectory = readRecipientDirectory({ chatDirectory: snapshot.chatDirectory });

    assert.deepEqual(Object.keys(snapshot.chatDirectory).sort(), ["contacts", "groups", "refreshedAt"]);
    assert.deepEqual(pickerDirectory.contacts[0], {
        targetType: "contact",
        targetValue: "5551991111111",
        label: "Álvaro",
        phoneNumber: "5551991111111",
    });
    assert.deepEqual(pickerDirectory.groups[0], {
        targetType: "group",
        targetValue: "120363043210123456@g.us",
        label: "Águias",
        phoneNumber: null,
    });

    snapshot.chatDirectory.contacts[0].name = "Mutated";
    snapshot.chatDirectory.contacts.push({ id: "fake@c.us", name: "Fake" });
    snapshot.chatDirectory.groups[0].label = "Mutated Group";

    const cleanSnapshot = manager.getSessionState();
    assert.equal(cleanSnapshot.chatDirectory.contacts.length, 4);
    assert.equal(cleanSnapshot.chatDirectory.contacts[0].name, "Álvaro");
    assert.equal(cleanSnapshot.chatDirectory.groups[0].label, "Águias");
});

test("directory keeps the group metadata subject over the chat label", async t => {
    const socket = createFakeSocket();
    const manager = await createReadyManager(t, { socket });
    socket.ev.emit("chats.upsert", [{ id: "120363043210123456@g.us", name: "Old label" }]);
    socket.ev.emit("groups.upsert", [{ id: "120363043210123456@g.us", subject: "Launch Team" }]);

    assert.equal(manager.getSessionState().chatDirectory.groups[0].name, "Launch Team");
});

test("directory coalesces concurrent group reads and caches them for ten minutes", async t => {
    t.mock.timers.enable({ apis: ["Date"], now: 100000 });
    let releases = [];
    let calls = 0;
    const socket = createFakeSocket();
    socket.groupFetchAllParticipating = async () => {
        calls += 1;
        return new Promise(resolve => {
            releases.push(resolve);
        });
    };
    const manager = await createReadyManager(t, { socket });

    const first = manager.refreshChatDirectory({ force: true });
    const second = manager.refreshChatDirectory({ force: true });
    assert.equal(calls, 1);

    for (const release of releases) {
        release({ "120363043210123456@g.us": { id: "120363043210123456@g.us", subject: "Launch Team" } });
    }
    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.deepEqual(firstResult.groups.map(entry => entry.name), ["Launch Team"]);
    assert.deepEqual(secondResult.groups.map(entry => entry.name), ["Launch Team"]);

    t.mock.timers.setTime(100000 + (10 * 60 * 1000) - 1);
    releases = [];
    const cached = manager.refreshChatDirectory();
    assert.equal(calls, 1);
    assert.deepEqual((await cached).groups.map(entry => entry.name), ["Launch Team"]);

    t.mock.timers.setTime(100000 + (10 * 60 * 1000) + 1);
    const refreshed = manager.refreshChatDirectory();
    assert.equal(calls, 2);
    releases.pop()({});
    await refreshed;
});

test("directory shows the complete name when the saved label is a prefix of it", async t => {
    const socket = createFakeSocket();
    const manager = await createReadyManager(t, { socket });
    socket.ev.emit("contacts.upsert", [
        { id: "555195171104@s.whatsapp.net", name: "Vinicius", notify: "Vinícius Guimarães" },
        { id: "555197771055@s.whatsapp.net", name: "Pablo Werlang", notify: "" },
    ]);

    const names = new Map(manager.getSessionState().chatDirectory.contacts.map(entry => [entry.id, entry.name]));
    assert.equal(names.get("555195171104@c.us"), "Vinícius Guimarães");
    assert.equal(names.get("555197771055@c.us"), "Pablo Werlang");
});

test("directory keeps a deliberate rename instead of the reported pushname", async t => {
    const socket = createFakeSocket();
    const manager = await createReadyManager(t, { socket });
    socket.ev.emit("contacts.upsert", [
        { id: "5551911111111@s.whatsapp.net", name: "Mãe", notify: "Maria Silva" },
    ]);

    assert.equal(manager.getSessionState().chatDirectory.contacts[0].name, "Mãe");
});

test("directory keeps a real saved name behind an address-shaped chat label", async t => {
    const socket = createFakeSocket();
    const manager = await createReadyManager(t, { socket });
    socket.ev.emit("chats.upsert", [
        { id: "555391565003@s.whatsapp.net", name: "+55 (53) 91565-003" },
        { id: "555195171104@s.whatsapp.net", name: "555195171104@c.us" },
        { id: "120363043210123456@g.us", name: "2026" },
    ]);
    socket.ev.emit("contacts.upsert", [
        { id: "555391565003@s.whatsapp.net", name: "Real Saved Name" },
    ]);

    const directory = manager.getSessionState().chatDirectory;
    const byId = new Map(directory.contacts.map(entry => [entry.id, entry]));

    assert.equal(byId.get("555391565003@c.us")?.name, "Real Saved Name");
    assert.equal(byId.has("555195171104@c.us"), false, "an address is not a name");
    assert.equal(directory.groups[0]?.name, "2026");
});

test("directory resolves LID-only contacts from history lidPnMappings", async t => {
    const socket = createFakeSocket();
    const manager = await createReadyManager(t, { socket });

    emitHistory(socket, [], [
        { id: "99999999999999@lid", name: "LID Alice" },
    ], [
        { lid: "99999999999999@lid", pn: "5551999999999@s.whatsapp.net" },
    ]);

    const directory = manager.getSessionState().chatDirectory;

    assert.deepEqual(directory.contacts.map(entry => [entry.id, entry.name]), [
        ["5551999999999@c.us", "LID Alice"],
    ]);
});

test("directory re-resolves an already-seen LID contact when lid-mapping.update arrives", async t => {
    const socket = createFakeSocket();
    const manager = await createReadyManager(t, { socket });

    socket.ev.emit("contacts.upsert", [
        { id: "88888888888888@lid", name: "LID Bob" },
        { id: "555391565003@s.whatsapp.net", name: "Regular Contact" },
    ]);

    assert.deepEqual(manager.getSessionState().chatDirectory.contacts.map(entry => entry.name), ["Regular Contact"]);

    socket.ev.emit("lid-mapping.update", {
        lid: "88888888888888@lid",
        pn: "5551888888888@s.whatsapp.net",
    });

    assert.deepEqual(
        manager.getSessionState().chatDirectory.contacts.map(entry => [entry.id, entry.name]),
        [
            ["5551888888888@c.us", "LID Bob"],
            ["555391565003@c.us", "Regular Contact"],
        ],
    );
});

test("directory asks the socket LID mapping store for an unresolved contact PN", async t => {
    const socket = createFakeSocket();
    socket.signalRepository = {
        lidMapping: {
            async getPNForLID(lid) {
                return lid === "77777777777777@lid" ? "5551777777777@s.whatsapp.net" : null;
            },
        },
    };
    const manager = await createReadyManager(t, { socket });

    socket.ev.emit("contacts.upsert", [
        { id: "77777777777777@lid", name: "LID Carol" },
    ]);

    await waitFor(() => manager.getSessionState().chatDirectory.contacts
        .some(entry => entry.id === "5551777777777@c.us" && entry.name === "LID Carol"));
});

test("group refresh prunes groups missing from the authoritative snapshot and keeps contacts", async t => {
    const socket = createFakeSocket();
    const manager = await createReadyManager(t, { socket });

    socket.ev.emit("chats.upsert", [
        { id: "120363043210123456@g.us", name: "Keep" },
        { id: "120363043210123457@g.us", name: "Gone" },
    ]);
    socket.ev.emit("contacts.upsert", [
        { id: "555391565003@s.whatsapp.net", name: "Alice" },
    ]);

    socket.groupFetchAllParticipating = async () => ({
        "120363043210123456@g.us": { id: "120363043210123456@g.us", subject: "Keep" },
    });

    const directory = await manager.refreshChatDirectory({ force: true });

    assert.deepEqual(directory.groups.map(entry => entry.id), ["120363043210123456@g.us"]);
    assert.deepEqual(directory.contacts.map(entry => entry.name), ["Alice"]);
    assert.deepEqual(manager.getSessionState().chatDirectory.groups.map(entry => entry.id), ["120363043210123456@g.us"]);
});
