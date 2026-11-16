import assert from "node:assert/strict";
import test from "node:test";
import { WhatsAppClientManager } from "../services/whatsapp-client-manager.js";
import { WhatsAppSessionManager } from "../services/whatsapp-session-manager.js";
import { readRecipientDirectory } from "../../web/public/js/helpers/recipient.js";

const baseConfig = {
    clientId: "main",
    authPath: "/tmp/whatsbot-test-auth",
    executablePath: "/usr/bin/chromium-browser",
    puppeteerArgs: [],
};

const silentLogger = {
    error() {},
    warn() {},
};

const mixedContacts = [
    { id: { _serialized: "555391565003@c.us" }, name: "" },
    { id: { _serialized: "555391565003@c.us" }, name: "Vinícius Alves Hax" },
    { id: { _serialized: "555391565003@c.us" }, name: "" },
    { id: { _serialized: "555195171104@c.us" }, name: "Vinicius" },
    { id: { _serialized: "555195171104@c.us" }, name: "Vinicius" },
    { id: { _serialized: "5551991111111@c.us" }, name: "  Álvaro  " },
    { id: { _serialized: "5551992222222@c.us" }, name: "Zulu" },
    { id: { _serialized: "5551993333333@c.us" }, name: "   " },
    { id: { _serialized: "38865310056602@lid", user: "38865310056602", server: "lid" }, name: "LID person", number: "555197771055" },
    { id: { _serialized: "status@broadcast" }, name: "Status" },
    { id: { _serialized: "not-a-phone@c.us" }, name: "Bad" },
    { id: { _serialized: "120363043210123456@g.us" }, name: "" },
    { id: { _serialized: "120363043210123456@g.us" }, name: "Águias", isGroup: true },
    { id: { _serialized: "120363043210123457@g.us" }, name: "Zulu equipe", isGroup: true },
];

const primaryError = Object.assign(
    new Error("Failed to execute 'get' on 'IDBObjectStore': No key or key range specified."),
    { name: "DataError" },
);

function createReadyManager(client, { config = baseConfig, logger = silentLogger } = {}) {
    const manager = new WhatsAppClientManager(config, { logger });
    manager.state.ready = true;
    manager.client = client;
    return manager;
}

test("directory uses chats without calling contacts when the primary succeeds", async () => {
    let chatCalls = 0;
    let contactCalls = 0;
    const chatModels = mixedContacts.map(entry => ({
        ...entry,
        isGroup: Boolean(entry.isGroup || entry.id?._serialized?.endsWith("@g.us")),
        formattedTitle: entry.name,
    }));
    const manager = createReadyManager({
        async getChats() {
            chatCalls += 1;
            return chatModels;
        },
        async getContacts() {
            contactCalls += 1;
            throw new Error("getContacts must not be called when getChats succeeds");
        },
    });

    const directory = await manager.refreshChatDirectory({ force: true });

    assert.equal(chatCalls, 1);
    assert.equal(contactCalls, 0);
    assert.deepEqual(
        directory.contacts.map(entry => entry.id),
        [
            "5551991111111@c.us",
            "555195171104@c.us",
            "555391565003@c.us",
            "5551992222222@c.us",
        ],
    );
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
});

test("directory accepts an empty successful chat list without fallback", async () => {
    let chatCalls = 0;
    let contactCalls = 0;
    const manager = createReadyManager({
        async getChats() {
            chatCalls += 1;
            return [];
        },
        async getContacts() {
            contactCalls += 1;
            return mixedContacts;
        },
    });

    const directory = await manager.refreshChatDirectory({ force: true });

    assert.equal(chatCalls, 1);
    assert.equal(contactCalls, 0);
    assert.deepEqual(directory.contacts, []);
    assert.deepEqual(directory.groups, []);
    assert.equal(typeof directory.refreshedAt, "string");
});

test("directory falls back to contacts after getChats throws DataError", async t => {
    t.mock.timers.enable({ apis: ["Date"], now: 1700000000000 });
    let chatCalls = 0;
    let contactCalls = 0;
    const manager = createReadyManager({
        async getChats() {
            chatCalls += 1;
            throw primaryError;
        },
        async getContacts() {
            contactCalls += 1;
            return mixedContacts;
        },
    });

    const directory = await manager.refreshChatDirectory({ force: true });

    assert.equal(chatCalls, 1);
    assert.equal(contactCalls, 1);
    assert.equal(directory.refreshedAt, new Date(1700000000000).toISOString());
    assert.deepEqual(
        directory.contacts.map(entry => entry.id),
        [
            "5551991111111@c.us",
            "555195171104@c.us",
            "555391565003@c.us",
            "5551992222222@c.us",
        ],
    );
    assert.deepEqual(directory.contacts[0], {
        id: "5551991111111@c.us",
        name: "Álvaro",
        targetType: "contact",
        targetValue: "5551991111111",
        phoneNumber: "5551991111111",
        chatId: "5551991111111@c.us",
        label: "Álvaro",
    });
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
});

test("directory filters unaddressable and unnamed people from both sources", async () => {
    let evaluateCalls = 0;
    const entries = [
        { id: { _serialized: "38865310056602@lid", user: "38865310056602", server: "lid" }, name: "LID person", number: "555197771055" },
        { id: { _serialized: "status@broadcast" }, name: "Status" },
        { id: { _serialized: "5551999999999@broadcast" }, name: "Broadcast" },
        { id: { _serialized: "not-a-phone@c.us" }, name: "Bad" },
        { id: { _serialized: "12345@c.us" }, name: "Too Short" },
        { id: { _serialized: "5551993333333@c.us" }, name: "   " },
        { id: { _serialized: "5551994444444@c.us" }, number: "5551994444444" },
        { id: { _serialized: "x@g.us" }, name: "Invalid Group", isGroup: true },
        { id: { _serialized: "120363043210123458@g.us" }, name: "   ", isGroup: true },
        { id: { _serialized: "5551995555555@c.us" }, pushname: "Push Contact" },
    ];

    const primaryManager = createReadyManager({
        async getChats() { return entries; },
        pupPage: { async evaluate() { evaluateCalls += 1; return "555197771055"; } },
    });
    const primaryDirectory = await primaryManager.refreshChatDirectory({ force: true });

    const fallbackManager = createReadyManager({
        async getChats() { throw primaryError; },
        async getContacts() { return entries; },
        pupPage: { async evaluate() { evaluateCalls += 1; return "555197771055"; } },
    });
    const fallbackDirectory = await fallbackManager.refreshChatDirectory({ force: true });

    for (const directory of [primaryDirectory, fallbackDirectory]) {
        assert.deepEqual(directory.contacts, [{
            id: "5551995555555@c.us",
            name: "Push Contact",
            targetType: "contact",
            targetValue: "5551995555555",
            phoneNumber: "5551995555555",
            chatId: "5551995555555@c.us",
            label: "Push Contact",
        }]);
        assert.deepEqual(directory.groups, [{
            id: "120363043210123458@g.us",
            name: "120363043210123458@g.us",
            targetType: "group",
            targetValue: "120363043210123458@g.us",
            phoneNumber: null,
            chatId: "120363043210123458@g.us",
            label: "120363043210123458@g.us",
        }]);
    }
    assert.equal(evaluateCalls, 0);
});

test("directory deduplicates by id and prefers named entries", async () => {
    const namedFirst = createReadyManager({
        async getChats() {
            return [
                { id: { _serialized: "555391565003@c.us" }, name: "Vinícius Alves Hax" },
                { id: { _serialized: "555391565003@c.us" }, name: "" },
                { id: { _serialized: "555391565003@c.us" }, name: "Outra Pessoa" },
                { id: { _serialized: "120363043210123456@g.us" }, name: "Águias" },
                { id: { _serialized: "120363043210123456@g.us" }, name: "" },
                { id: { _serialized: "120363043210123456@g.us" }, name: "Outro Grupo" },
            ];
        },
    });
    const unnamedFirst = createReadyManager({
        async getChats() { throw primaryError; },
        async getContacts() {
            return [...mixedContacts].reverse();
        },
    });

    const firstResult = await namedFirst.refreshChatDirectory({ force: true });
    const reversedResult = await unnamedFirst.refreshChatDirectory({ force: true });

    assert.deepEqual(firstResult.contacts, [{
        id: "555391565003@c.us",
        name: "Vinícius Alves Hax",
        targetType: "contact",
        targetValue: "555391565003",
        phoneNumber: "555391565003",
        chatId: "555391565003@c.us",
        label: "Vinícius Alves Hax",
    }]);
    assert.deepEqual(firstResult.groups, [{
        id: "120363043210123456@g.us",
        name: "Águias",
        targetType: "group",
        targetValue: "120363043210123456@g.us",
        phoneNumber: null,
        chatId: "120363043210123456@g.us",
        label: "Águias",
    }]);
    assert.deepEqual(
        reversedResult.contacts.map(entry => entry.id),
        [
            "5551991111111@c.us",
            "555195171104@c.us",
            "555391565003@c.us",
            "5551992222222@c.us",
        ],
    );
    assert.deepEqual(
        reversedResult.groups.map(entry => entry.id),
        ["120363043210123456@g.us", "120363043210123457@g.us"],
    );
});

test("directory sorts contacts and groups by pt-BR name", async () => {
    const manager = createReadyManager({
        async getChats() {
            return [
                { id: { _serialized: "5551999999999@c.us" }, name: "Ana" },
                { id: { _serialized: "5551900000001@c.us" }, name: "Ana" },
                { id: { _serialized: "5551992222222@c.us" }, name: "Zulu" },
                { id: { _serialized: "5551991111111@c.us" }, name: "Álvaro" },
                { id: { _serialized: "555391565003@c.us" }, name: "Vinícius Alves Hax" },
                { id: { _serialized: "555195171104@c.us" }, name: "Vinicius" },
                { id: { _serialized: "120363043210123457@g.us" }, name: "Zulu equipe", isGroup: true },
                { id: { _serialized: "120363043210123459@g.us" }, name: "Comercial", isGroup: true },
                { id: { _serialized: "120363043210123458@g.us" }, name: "Comercial", isGroup: true },
                { id: { _serialized: "120363043210123456@g.us" }, name: "Águias", isGroup: true },
            ];
        },
    });

    const directory = await manager.refreshChatDirectory({ force: true });

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

test("directory preserves legacy picker fields and session snapshot isolation", async () => {
    const manager = createReadyManager({
        async getChats() { throw primaryError; },
        async getContacts() { return mixedContacts; },
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

test("directory treats a successful contacts fallback as a cached success", async t => {
    t.mock.timers.enable({ apis: ["Date"], now: 100000 });
    let chatCalls = 0;
    let contactCalls = 0;
    const manager = createReadyManager({
        async getChats() {
            chatCalls += 1;
            throw primaryError;
        },
        async getContacts() {
            contactCalls += 1;
            return mixedContacts;
        },
    });

    const first = await manager.refreshChatDirectory();
    assert.equal(chatCalls, 1);
    assert.equal(contactCalls, 1);
    assert.equal(first.refreshedAt, new Date(100000).toISOString());

    t.mock.timers.setTime(159999);
    const cached = await manager.refreshChatDirectory();
    assert.equal(chatCalls, 1);
    assert.equal(contactCalls, 1);
    assert.equal(cached.refreshedAt, new Date(100000).toISOString());

    t.mock.timers.setTime(110000);
    const forced = await manager.refreshChatDirectory({ force: true });
    assert.equal(chatCalls, 2);
    assert.equal(contactCalls, 2);
    assert.equal(forced.refreshedAt, new Date(110000).toISOString());

    t.mock.timers.setTime(170000);
    const expired = await manager.refreshChatDirectory();
    assert.equal(chatCalls, 3);
    assert.equal(contactCalls, 3);
    assert.equal(expired.refreshedAt, new Date(170000).toISOString());
});

test("directory logs one primary outage across successful fallbacks until recovery", async t => {
    t.mock.timers.enable({ apis: ["Date"], now: 100000 });
    const warnings = [];
    const errors = [];
    let primaryBroken = true;
    let contactsBroken = false;
    const manager = createReadyManager({
        async getChats() {
            if (primaryBroken) {
                throw primaryError;
            }
            return [
                { id: { _serialized: "555391565003@c.us" }, name: "Vinícius Alves Hax" },
            ];
        },
        async getContacts() {
            if (contactsBroken) {
                throw new Error("contacts failed too");
            }
            return mixedContacts;
        },
    }, {
        logger: {
            warn: (...args) => warnings.push(args.map(String).join(" ")),
            error: (...args) => errors.push(args.map(String).join(" ")),
        },
    });

    await manager.refreshChatDirectory({ force: true });
    t.mock.timers.setTime(160000);
    await manager.refreshChatDirectory({ force: true });
    await manager.refreshChatDirectory({ force: true });

    assert.equal(warnings.length, 1);
    assert.equal(errors.length, 0);
    assert.match(
        warnings[0],
        /WhatsApp chat directory primary source unavailable for session main; using contacts\./,
    );
    assert.doesNotMatch(warnings[0], /Vinícius|555391565003/);

    primaryBroken = false;
    await manager.refreshChatDirectory({ force: true });
    assert.equal(warnings.length, 1);

    primaryBroken = true;
    await manager.refreshChatDirectory({ force: true });
    assert.equal(warnings.length, 2);

    contactsBroken = true;
    t.mock.timers.setTime(220000);
    await manager.refreshChatDirectory({ force: true });
    assert.equal(warnings.length, 2);
    assert.equal(errors.length, 1);
});

test("directory retains cache and backs off both-source failures for thirty seconds", async t => {
    t.mock.timers.enable({ apis: ["Date"], now: 50000 });
    const errors = [];
    const warnings = [];
    let primaryBroken = false;
    let contactsBroken = false;

    const manager = createReadyManager({
        async getChats() {
            if (primaryBroken) {
                throw primaryError;
            }
            return [{ id: { _serialized: "555391565003@c.us" }, name: "Vinícius Alves Hax" }];
        },
        async getContacts() {
            if (contactsBroken) {
                throw new Error("contacts unavailable");
            }
            return mixedContacts;
        },
    }, {
        config: {
            clientId: "main",
            authPath: "/tmp/whatsbot-test-auth",
        },
        logger: {
            error: (...args) => errors.push(args.map(String).join(" ")),
            warn: (...args) => warnings.push(args.map(String).join(" ")),
        },
    });

    const initial = await manager.refreshChatDirectory({ force: true });
    assert.equal(initial.contacts.length, 1);

    let chatAttempts = 0;
    let contactAttempts = 0;
    const realClient = manager.client;
    manager.client = {
        async getChats() {
            chatAttempts += 1;
            return realClient.getChats();
        },
        async getContacts() {
            contactAttempts += 1;
            return realClient.getContacts();
        },
    };

    primaryBroken = true;
    contactsBroken = true;
    t.mock.timers.setTime(100000);
    const failed = await manager.refreshChatDirectory({ force: true });
    assert.equal(chatAttempts, 1);
    assert.equal(contactAttempts, 1);
    assert.deepEqual(failed, initial);
    assert.equal(manager.isReady(), true);
    assert.equal(errors.length, 1);
    assert.equal(warnings.length, 0);

    t.mock.timers.setTime(129999);
    const backedOff = await manager.refreshChatDirectory();
    const forcedBackedOff = await manager.refreshChatDirectory({ force: true });
    assert.equal(chatAttempts, 1);
    assert.equal(contactAttempts, 1);
    assert.deepEqual(backedOff, initial);
    assert.deepEqual(forcedBackedOff, initial);

    t.mock.timers.setTime(130000);
    contactsBroken = false;
    const recovered = await manager.refreshChatDirectory();
    assert.equal(chatAttempts, 2);
    assert.equal(contactAttempts, 2);
    assert.equal(recovered.contacts.length, 4);
    assert.equal(recovered.refreshedAt, new Date(130000).toISOString());

    t.mock.timers.setTime(131000);
    await manager.refreshChatDirectory({ force: true });
    assert.equal(chatAttempts, 3);
    assert.equal(contactAttempts, 3);

    const customRetryManager = createReadyManager({
        async getChats() { throw primaryError; },
        async getContacts() { throw new Error("contacts down"); },
    }, {
        config: {
            clientId: "custom",
            chatDirectoryRetryMs: 1000,
        },
        logger: silentLogger,
    });
    t.mock.timers.setTime(200000);
    await customRetryManager.refreshChatDirectory({ force: true });
    t.mock.timers.setTime(200999);
    await customRetryManager.refreshChatDirectory({ force: true });
    assert.equal(customRetryManager.chatDirectoryRetryAt, 201000);
});

test("directory coalesces concurrent refreshes and ignores disposed client results", async () => {
    let releaseRead;
    let chatCalls = 0;
    const pendingRead = new Promise(resolve => {
        releaseRead = resolve;
    });
    const staleClient = {
        async getChats() {
            chatCalls += 1;
            return pendingRead;
        },
    };
    const manager = createReadyManager(staleClient);

    const first = manager.refreshChatDirectory({ force: true });
    const second = manager.refreshChatDirectory({ force: true });
    assert.equal(chatCalls, 1);

    const replacementClient = {
        async getChats() {
            return [{ id: { _serialized: "5551999999999@c.us" }, name: "Replacement" }];
        },
    };
    manager.client = replacementClient;
    releaseRead([{ id: { _serialized: "5551888888888@c.us" }, name: "Stale" }]);

    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.deepEqual(firstResult.contacts, []);
    assert.deepEqual(secondResult.contacts, []);
    assert.deepEqual(manager.getSessionState().chatDirectory.contacts, []);
});

test("directory acquisition never falls back to a replacement client", async () => {
    let rejectPrimaryChats;
    let primaryChatCalls = 0;
    let primaryContactCalls = 0;
    let replacementContactCalls = 0;
    const pendingPrimaryChats = new Promise((_resolve, reject) => {
        rejectPrimaryChats = reject;
    });
    const primaryClient = {
        async getChats() {
            primaryChatCalls += 1;
            return pendingPrimaryChats;
        },
        async getContacts() {
            primaryContactCalls += 1;
            return mixedContacts;
        },
    };
    const manager = createReadyManager(primaryClient);

    const staleRefresh = manager.refreshChatDirectory({ force: true });

    const replacementClient = {
        async getChats() {
            return [{ id: { _serialized: "5551999999999@c.us" }, name: "Replacement" }];
        },
        async getContacts() {
            replacementContactCalls += 1;
            throw new Error("replacement contacts must not be read");
        },
    };
    manager.client = replacementClient;
    rejectPrimaryChats(new Error("primary client was replaced"));

    const staleResult = await staleRefresh;

    assert.equal(primaryChatCalls, 1);
    assert.equal(primaryContactCalls, 0);
    assert.equal(replacementContactCalls, 0);
    assert.deepEqual(staleResult.contacts, []);
    assert.deepEqual(staleResult.groups, []);
    assert.deepEqual(manager.getSessionState().chatDirectory.contacts, []);
    assert.deepEqual(manager.getSessionState().chatDirectory.groups, []);

    const replacementDirectory = await manager.refreshChatDirectory({ force: true });

    assert.equal(replacementContactCalls, 0);
    assert.deepEqual(replacementDirectory.contacts.map(entry => entry.id), ["5551999999999@c.us"]);
    assert.deepEqual(
        manager.getSessionState().chatDirectory.contacts.map(entry => entry.id),
        ["5551999999999@c.us"],
    );
});

test("directory rejects address-shaped labels as names on both sources", async () => {
    const entries = [
        { id: { _serialized: "555391565003@c.us" }, name: "555391565003", formattedTitle: "555391565003" },
        { id: { _serialized: "555195171104@c.us" }, name: "Vinicius", formattedTitle: "Vinicius" },
        { id: { _serialized: "120363043210123456@g.us" }, name: "", formattedTitle: "" },
    ];

    const primaryManager = createReadyManager({
        async getChats() {
            return entries;
        },
    });
    const fallbackManager = createReadyManager({
        async getChats() {
            throw primaryError;
        },
        async getContacts() {
            return entries;
        },
    });

    const [primaryDirectory, fallbackDirectory] = await Promise.all([
        primaryManager.refreshChatDirectory({ force: true }),
        fallbackManager.refreshChatDirectory({ force: true }),
    ]);

    for (const directory of [primaryDirectory, fallbackDirectory]) {
        assert.deepEqual(directory.contacts, [{
            id: "555195171104@c.us",
            name: "Vinicius",
            targetType: "contact",
            targetValue: "555195171104",
            phoneNumber: "555195171104",
            chatId: "555195171104@c.us",
            label: "Vinicius",
        }]);
        assert.deepEqual(directory.groups, [{
            id: "120363043210123456@g.us",
            name: "120363043210123456@g.us",
            targetType: "group",
            targetValue: "120363043210123456@g.us",
            phoneNumber: null,
            chatId: "120363043210123456@g.us",
            label: "120363043210123456@g.us",
        }]);
        assert.equal(directory.contacts.some(entry => entry.id === "555391565003@c.us"), false);
    }
});

test("directory keeps a real name behind an address-shaped label and preserves numeric group titles", async () => {
    const entries = [
        {
            id: { _serialized: "555391565003@c.us" },
            name: "+55 (53) 91565-003",
            contact: { name: "Real Saved Name" },
        },
        { id: { _serialized: "555195171104@c.us" }, name: "555195171104@c.us" },
        { id: { _serialized: "120363043210123456@g.us" }, name: "2026", isGroup: true },
    ];

    for (const source of ["chats", "contacts"]) {
        const client = source === "chats"
            ? { async getChats() { return entries; }, async getContacts() { throw new Error("unexpected"); } }
            : { async getChats() { throw primaryError; }, async getContacts() { return entries; } };
        const manager = createReadyManager(client);

        const directory = await manager.refreshChatDirectory({ force: true });
        const byId = new Map(directory.contacts.map(entry => [entry.id, entry]));

        assert.equal(byId.get("555391565003@c.us")?.name, "Real Saved Name", `${source}: real name must survive a phone-shaped label`);
        assert.equal(byId.has("555195171104@c.us"), false, `${source}: an address is not a name`);
        assert.equal(directory.groups[0]?.name, "2026", `${source}: a numeric group title must stay a title`);
    }
});

test("a replacement client does not inherit a pending directory refresh", async () => {
    let settlePrimaryChats;
    const pendingPrimaryChats = new Promise(resolve => {
        settlePrimaryChats = resolve;
    });
    const primaryClient = {
        getChats() {
            return pendingPrimaryChats;
        },
        async getContacts() {
            return mixedContacts;
        },
    };
    const manager = createReadyManager(primaryClient);

    const staleRefresh = manager.refreshChatDirectory({ force: true });

    let replacementChatCalls = 0;
    const replacementClient = {
        async getChats() {
            replacementChatCalls += 1;
            return [{ id: { _serialized: "5551999999999@c.us" }, name: "Replacement" }];
        },
        async getContacts() {
            throw new Error("replacement contacts must not be read");
        },
    };
    manager.client = replacementClient;

    const replacementDirectory = await manager.refreshChatDirectory({ force: true });

    assert.equal(replacementChatCalls, 1, "the replacement must run its own read");

    settlePrimaryChats(mixedContacts);
    const staleResult = await staleRefresh;

    assert.deepEqual(replacementDirectory.contacts.map(entry => entry.name), ["Replacement"]);
    assert.deepEqual(staleResult.contacts.map(entry => entry.name), ["Replacement"], "the stale operation must not overwrite the replacement");
    assert.deepEqual(manager.state.chatDirectory.contacts.map(entry => entry.name), ["Replacement"]);
});

test("directory shows the complete name when the saved label is a prefix of it", async () => {
    const entries = [
        { id: { _serialized: "555195171104@c.us" }, name: "Vinicius", contact: { pushname: "Vinícius Guimarães" } },
        { id: { _serialized: "555197771055@c.us" }, name: "Pablo Werlang", contact: { pushname: "" } },
    ];

    const manager = createReadyManager({ async getChats() { return entries; } });
    const directory = await manager.refreshChatDirectory({ force: true });
    const names = new Map(directory.contacts.map(entry => [entry.id, entry.name]));

    assert.equal(names.get("555195171104@c.us"), "Vinícius Guimarães");
    assert.equal(names.get("555197771055@c.us"), "Pablo Werlang");
});

test("directory keeps a deliberate rename instead of the reported name", async () => {
    const entries = [
        { id: { _serialized: "5551911111111@c.us" }, name: "Mãe", contact: { pushname: "Maria Silva" } },
    ];

    const manager = createReadyManager({ async getChats() { return entries; } });
    const directory = await manager.refreshChatDirectory({ force: true });

    assert.equal(directory.contacts[0].name, "Mãe");
});
