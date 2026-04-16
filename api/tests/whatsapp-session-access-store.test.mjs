import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { HttpError } from "../helpers/error.js";
import { WhatsAppSessionAccessStore } from "../services/whatsapp-session-access-store.js";

/**
 * Creates one in-memory session access model double for store tests.
 */
function createSessionAccessModel(initialEntries = []) {
    const entriesBySessionId = new Map();
    const sessionIdByPassword = new Map();

    for (const entry of initialEntries) {
        const normalizedEntry = cloneEntry(entry);
        entriesBySessionId.set(normalizedEntry.sessionId, normalizedEntry);
        sessionIdByPassword.set(normalizedEntry.accessPassword, normalizedEntry.sessionId);
    }

    return {
        async findBySessionId(sessionId) {
            const entry = entriesBySessionId.get(sessionId);
            return entry ? cloneEntry(entry) : null;
        },
        async findByPassword(accessPassword) {
            const sessionId = sessionIdByPassword.get(accessPassword);
            const entry = sessionId ? entriesBySessionId.get(sessionId) : null;
            return entry ? cloneEntry(entry) : null;
        },
        async create(payload) {
            if (entriesBySessionId.has(payload.sessionId)) {
                throw createDuplicateEntryError("PRIMARY");
            }

            if (sessionIdByPassword.has(payload.accessPassword)) {
                throw createDuplicateEntryError("uk_whatsapp_session_access_password");
            }

            const entry = cloneEntry({
                ...payload,
                createdAt: payload.createdAt || new Date("2026-04-15T12:00:00.000Z").toISOString(),
                updatedAt: payload.updatedAt || payload.createdAt || new Date("2026-04-15T12:00:00.000Z").toISOString(),
            });

            entriesBySessionId.set(entry.sessionId, entry);
            sessionIdByPassword.set(entry.accessPassword, entry.sessionId);
            return cloneEntry(entry);
        },
    };
}

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
 * Clones one public session access entry.
 */
function cloneEntry(entry) {
    return {
        sessionId: entry.sessionId,
        accessPassword: entry.accessPassword,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt || entry.createdAt,
    };
}

test("WhatsAppSessionAccessStore reuses one existing persisted session access entry", async () => {
    const sessionAccessModel = createSessionAccessModel([{
        sessionId: "alpha",
        accessPassword: "amber-harbor-4821",
        createdAt: "2026-04-15T12:00:00.000Z",
        updatedAt: "2026-04-15T12:00:00.000Z",
    }]);
    const store = new WhatsAppSessionAccessStore({
        authPath: "/tmp/unused",
        filePath: "/tmp/does-not-exist.json",
        sessionAccessModel,
    });

    const entry = await store.ensureSessionAccess("alpha");

    assert.deepEqual(entry, {
        sessionId: "alpha",
        accessPassword: "amber-harbor-4821",
        createdAt: "2026-04-15T12:00:00.000Z",
    });
});

test("WhatsAppSessionAccessStore retries password collisions before persisting one new entry", async () => {
    const sessionAccessModel = createSessionAccessModel([{
        sessionId: "alpha",
        accessPassword: "amber-harbor-4821",
        createdAt: "2026-04-15T12:00:00.000Z",
        updatedAt: "2026-04-15T12:00:00.000Z",
    }]);
    const store = new WhatsAppSessionAccessStore({
        authPath: "/tmp/unused",
        filePath: "/tmp/does-not-exist.json",
        sessionAccessModel,
    });
    const generatedPasswords = ["amber-harbor-4821", "silver-orchard-5824"];

    store.generateUniqueAccessPassword = function() {
        return generatedPasswords.shift();
    };

    const entry = await store.ensureSessionAccess("beta");

    assert.equal(entry.sessionId, "beta");
    assert.equal(entry.accessPassword, "silver-orchard-5824");
    assert.match(entry.createdAt, /^2026-04-15T12:00:00.000Z$/);
});

test("WhatsAppSessionAccessStore imports legacy JSON registry entries into MySQL-backed storage", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "whatsbot-session-access-"));
    const filePath = path.join(directory, "whatsbot-session-access.json");
    const sessionAccessModel = createSessionAccessModel();

    try {
        await fs.writeFile(filePath, JSON.stringify({
            version: 1,
            sessions: [{
                sessionId: "legacy-team",
                accessPassword: "jade-rocket-7310",
                createdAt: "2026-04-15T10:00:00.000Z",
            }],
        }), "utf8");

        const store = new WhatsAppSessionAccessStore({
            authPath: directory,
            filePath,
            sessionAccessModel,
        });

        await store.initialize();

        const entry = await store.findByPassword("jade-rocket-7310");
        assert.deepEqual(entry, {
            sessionId: "legacy-team",
            accessPassword: "jade-rocket-7310",
            createdAt: "2026-04-15T10:00:00.000Z",
        });
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
});

test("WhatsAppSessionAccessStore rejects one invalid session password", async () => {
    const store = new WhatsAppSessionAccessStore({
        authPath: "/tmp/unused",
        filePath: "/tmp/does-not-exist.json",
        sessionAccessModel: createSessionAccessModel(),
    });

    await assert.rejects(
        () => store.findByPassword("not-found-4821"),
        error => {
            assert.equal(error instanceof HttpError, true);
            assert.equal(error.status, 401);
            assert.match(error.message, /invalid session password/i);
            return true;
        },
    );
});