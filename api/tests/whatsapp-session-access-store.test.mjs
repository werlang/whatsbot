import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { HttpError } from "../helpers/error.js";
import { WhatsAppSessionAccessStore } from "../services/whatsapp-session-access-store.js";

/**
 * Creates one duplicate-entry error with the same shape used by the MySQL helper.
 */
function createDuplicateEntryError(key) {
    const error = new Error("Duplicate entry");
    error.data = {
        error: {
            code: "ER_DUP_ENTRY",
            key,
        },
    };
    return error;
}

/**
 * Clones one stored session access entry.
 */
function cloneEntry(entry) {
    return {
        sessionId: entry.sessionId,
        accessTokenHash: entry.accessTokenHash,
        recoveryPasswordHash: entry.recoveryPasswordHash,
        recoveryPasswordSalt: entry.recoveryPasswordSalt,
        recoveryPasswordLookup: entry.recoveryPasswordLookup,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt || entry.createdAt,
    };
}

/**
 * Creates one store with deterministic secret generators for testing.
 */
function createStore(sessionAccessModel) {
    return new WhatsAppSessionAccessStore({
        authPath: "/tmp/unused",
        filePath: "/tmp/does-not-exist.json",
        sessionAccessModel,
    });
}

/**
 * Creates one persisted entry shaped like the session access model expects.
 */
function createPersistedEntry({
    store,
    sessionId,
    accessToken,
    recoveryPassword,
    recoveryPasswordSalt,
    createdAt = "2026-04-15T12:00:00.000Z",
    updatedAt = createdAt,
}) {
    return {
        sessionId,
        accessTokenHash: store.hashSecret(accessToken),
        recoveryPasswordHash: store.hashRecoveryPassword(recoveryPassword, recoveryPasswordSalt),
        recoveryPasswordSalt,
        recoveryPasswordLookup: store.hashSecret(recoveryPassword),
        createdAt,
        updatedAt,
    };
}

/**
 * Creates one in-memory session access model double for store tests.
 */
function createSessionAccessModel(initialEntries = []) {
    const entriesBySessionId = new Map();
    const sessionIdByRecoveryLookup = new Map();
    const sessionIdByAccessTokenHash = new Map();

    for (const entry of initialEntries) {
        const normalizedEntry = cloneEntry(entry);
        entriesBySessionId.set(normalizedEntry.sessionId, normalizedEntry);
        sessionIdByRecoveryLookup.set(normalizedEntry.recoveryPasswordLookup, normalizedEntry.sessionId);
        sessionIdByAccessTokenHash.set(normalizedEntry.accessTokenHash, normalizedEntry.sessionId);
    }

    return {
        async findBySessionId(sessionId) {
            const entry = entriesBySessionId.get(sessionId);
            return entry ? cloneEntry(entry) : null;
        },
        async findByRecoveryPasswordLookup(recoveryPasswordLookup) {
            const sessionId = sessionIdByRecoveryLookup.get(recoveryPasswordLookup);
            const entry = sessionId ? entriesBySessionId.get(sessionId) : null;
            return entry ? cloneEntry(entry) : null;
        },
        async findByAccessTokenHash(accessTokenHash) {
            const sessionId = sessionIdByAccessTokenHash.get(accessTokenHash);
            const entry = sessionId ? entriesBySessionId.get(sessionId) : null;
            return entry ? cloneEntry(entry) : null;
        },
        async create(payload) {
            if (entriesBySessionId.has(payload.sessionId)) {
                throw createDuplicateEntryError("PRIMARY");
            }

            if (sessionIdByRecoveryLookup.has(payload.recoveryPasswordLookup)) {
                throw createDuplicateEntryError("uk_whatsapp_session_access_recovery_lookup");
            }

            if (sessionIdByAccessTokenHash.has(payload.accessTokenHash)) {
                throw createDuplicateEntryError("uk_whatsapp_session_access_token_hash");
            }

            const entry = cloneEntry({
                ...payload,
                createdAt: payload.createdAt || new Date("2026-04-15T12:00:00.000Z").toISOString(),
                updatedAt: payload.updatedAt || payload.createdAt || new Date("2026-04-15T12:00:00.000Z").toISOString(),
            });

            entriesBySessionId.set(entry.sessionId, entry);
            sessionIdByRecoveryLookup.set(entry.recoveryPasswordLookup, entry.sessionId);
            sessionIdByAccessTokenHash.set(entry.accessTokenHash, entry.sessionId);
            return cloneEntry(entry);
        },
        async update(clause, payload) {
            const sessionId = clause?.session_id || clause?.sessionId;
            const existingEntry = entriesBySessionId.get(sessionId);

            if (!existingEntry) {
                return;
            }

            if (payload.accessTokenHash !== existingEntry.accessTokenHash && sessionIdByAccessTokenHash.has(payload.accessTokenHash)) {
                throw createDuplicateEntryError("uk_whatsapp_session_access_token_hash");
            }

            sessionIdByRecoveryLookup.delete(existingEntry.recoveryPasswordLookup);
            sessionIdByAccessTokenHash.delete(existingEntry.accessTokenHash);

            const updatedEntry = cloneEntry({
                ...existingEntry,
                ...payload,
            });

            entriesBySessionId.set(updatedEntry.sessionId, updatedEntry);
            sessionIdByRecoveryLookup.set(updatedEntry.recoveryPasswordLookup, updatedEntry.sessionId);
            sessionIdByAccessTokenHash.set(updatedEntry.accessTokenHash, updatedEntry.sessionId);
        },
    };
}

test("WhatsAppSessionAccessStore creates one new session token and recovery password", async () => {
    const store = createStore(createSessionAccessModel());
    store.generateAccessToken = () => "a".repeat(64);
    store.generateRecoveryPassword = () => "amber-harbor-signal-voyage-willow-summit-4821";
    store.generateRecoveryPasswordSalt = () => "b".repeat(32);

    const entry = await store.createSessionAccess("alpha");

    assert.deepEqual(entry, {
        sessionId: "alpha",
        accessToken: "a".repeat(64),
        recoveryPassword: "amber-harbor-signal-voyage-willow-summit-4821",
        createdAt: "2026-04-15T12:00:00.000Z",
    });
});

test("WhatsAppSessionAccessStore retries secret collisions before persisting one new entry", async () => {
    const helperStore = createStore(createSessionAccessModel());
    const existingRecoveryPassword = "amber-harbor-signal-voyage-willow-summit-4821";
    const existingEntry = createPersistedEntry({
        store: helperStore,
        sessionId: "alpha",
        accessToken: "a".repeat(64),
        recoveryPassword: existingRecoveryPassword,
        recoveryPasswordSalt: "c".repeat(32),
    });
    const store = createStore(createSessionAccessModel([existingEntry]));
    const accessTokens = ["a".repeat(64), "d".repeat(64)];
    const recoveryPasswords = [existingRecoveryPassword, "silver-orchard-signal-lantern-river-cabin-5824"];
    const salts = ["e".repeat(32), "f".repeat(32)];

    store.generateAccessToken = () => accessTokens.shift();
    store.generateRecoveryPassword = () => recoveryPasswords.shift();
    store.generateRecoveryPasswordSalt = () => salts.shift();

    const entry = await store.createSessionAccess("beta");

    assert.equal(entry.sessionId, "beta");
    assert.equal(entry.accessToken, "d".repeat(64));
    assert.equal(entry.recoveryPassword, "silver-orchard-signal-lantern-river-cabin-5824");
    assert.match(entry.createdAt, /^2026-04-15T12:00:00.000Z$/);
});

test("WhatsAppSessionAccessStore imports legacy JSON registry entries and issues one session token", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "whatsbot-session-access-"));
    const filePath = path.join(directory, "whatsbot-session-access.json");
    const sessionAccessModel = createSessionAccessModel();
    const store = new WhatsAppSessionAccessStore({
        authPath: directory,
        filePath,
        sessionAccessModel,
    });

    try {
        await fs.writeFile(filePath, JSON.stringify({
            version: 1,
            sessions: [{
                sessionId: "legacy-team",
                accessPassword: "jade-rocket-7310",
                createdAt: "2026-04-15T10:00:00.000Z",
            }],
        }), "utf8");

        store.generateAccessToken = () => "b".repeat(64);
        store.generateRecoveryPasswordSalt = () => "d".repeat(32);

        await store.initialize();

        const login = await store.loginWithRecoveryPassword("jade-rocket-7310");
        assert.equal(login.sessionId, "legacy-team");
        assert.equal(login.accessToken, "b".repeat(64));
        assert.match(login.createdAt, /^2026-04-15T10:00:00.000Z$/);
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
});

test("WhatsAppSessionAccessStore rotates the session token on recovery login", async () => {
    const store = createStore(createSessionAccessModel());
    store.generateAccessToken = () => "1".repeat(64);
    store.generateRecoveryPassword = () => "amber-harbor-signal-voyage-willow-summit-4821";
    store.generateRecoveryPasswordSalt = () => "2".repeat(32);

    const created = await store.createSessionAccess("alpha");

    store.generateAccessToken = () => "3".repeat(64);

    const restored = await store.loginWithRecoveryPassword(created.recoveryPassword);

    assert.equal(restored.sessionId, "alpha");
    assert.equal(restored.accessToken, "3".repeat(64));

    await assert.rejects(
        () => store.assertSessionAccess("alpha", created.accessToken),
        /invalid session token/i,
    );

    await store.assertSessionAccess("alpha", restored.accessToken);
});

test("WhatsAppSessionAccessStore rejects one invalid recovery password", async () => {
    const store = createStore(createSessionAccessModel());

    await assert.rejects(
        () => store.loginWithRecoveryPassword("not-found-4821"),
        error => {
            assert.equal(error instanceof HttpError, true);
            assert.equal(error.status, 401);
            assert.match(error.message, /invalid recovery password/i);
            return true;
        },
    );
});
