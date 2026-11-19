import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createApp } from "../app.js";
import { HttpError } from "../helpers/error.js";
import { WhatsAppClientManager } from "../services/whatsapp-client-manager.js";

const baseConfig = {
    clientId: "main",
};

const silentLogger = {
    error() {},
    warn() {},
};

/**
 * Creates one manager with a temp auth directory.
 *
 * @param {object} t Test context.
 * @returns {Promise<object>} Client manager.
 */
async function createManager(t) {
    const authPath = await fs.mkdtemp(path.join(os.tmpdir(), "whatsbot-avatar-"));
    t.after(() => fs.rm(authPath, { recursive: true, force: true }));
    const manager = new WhatsAppClientManager({ ...baseConfig, authPath }, { logger: silentLogger });
    t.after(() => manager.destroy());
    return manager;
}

/**
 * Starts the API app on an ephemeral port.
 *
 * @param {object} whatsappClient Injected session manager double.
 * @returns {Promise<import("node:http").Server>} Listening server.
 */
async function startTestServer(whatsappClient) {
    const server = createApp({ whatsappClient }).listen(0, "127.0.0.1");
    await once(server, "listening");
    return server;
}

/**
 * Closes a test HTTP server.
 *
 * @param {import("node:http").Server} server Listening server.
 * @returns {Promise<void>} Resolves after shutdown.
 */
async function stopTestServer(server) {
    await new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
    });
}

/**
 * Builds the avatar route URL for one target.
 *
 * @param {number} port Test server port.
 * @param {string} targetType Contact or group.
 * @param {string} targetValue Canonical value.
 * @returns {string} Absolute URL.
 */
function buildAvatarUrl(port, targetType, targetValue) {
    return `http://127.0.0.1:${port}/whatsapp/sessions/demo-session/avatar`
        + `?targetType=${encodeURIComponent(targetType)}&targetValue=${encodeURIComponent(targetValue)}`;
}

/**
 * Requests one avatar URL with a dummy token.
 *
 * @param {number} port Test server port.
 * @param {string} targetType Contact or group.
 * @param {string} targetValue Canonical value.
 * @returns {Promise<Response>} Fetch response.
 */
async function requestAvatar(port, targetType, targetValue) {
    return await fetch(buildAvatarUrl(port, targetType, targetValue), {
        headers: { "x-whatsbot-session-token": "b".repeat(64) },
    });
}

/**
 * Builds one avatar-route double with the cheap readiness and membership checks.
 *
 * @param {object} [overrides] Overrides for individual operations.
 * @returns {object} Session manager double.
 */
function createRouteDouble(overrides = {}) {
    return {
        async assertAuthorizedSession() {},
        isSessionReady: () => true,
        hasDirectoryTarget: () => true,
        async getProfilePicUrl() {
            return null;
        },
        ...overrides,
    };
}

test("avatar route authorizes before reading the directory", async () => {
    let directoryReads = 0;
    let avatarLookups = 0;
    const whatsappClient = createRouteDouble({
        async assertAuthorizedSession() {
            throw new HttpError(401, "Session token is invalid.");
        },
        isSessionReady() {
            directoryReads += 1;
            return true;
        },
        hasDirectoryTarget() {
            directoryReads += 1;
            return true;
        },
        async getProfilePicUrl() {
            avatarLookups += 1;
            return "https://cdn.example/photo.jpg";
        },
    });
    const server = await startTestServer(whatsappClient);
    const { port } = server.address();

    try {
        const response = await requestAvatar(port, "contact", "5551999999999");
        const payload = await response.json();

        assert.equal(response.status, 401);
        assert.equal(payload.error, true);
        assert.equal(payload.status, 401);
        assert.equal(response.headers.get("cache-control"), "private, no-store");
        assert.equal(directoryReads, 0);
        assert.equal(avatarLookups, 0);
    } finally {
        await stopTestServer(server);
    }
});

test("avatar route rejects an unknown target with 404 without cloning the directory", async () => {
    let avatarLookups = 0;
    const whatsappClient = createRouteDouble({
        getSessionState() {
            throw new Error("getSessionState must not run on the avatar path");
        },
        hasDirectoryTarget: () => false,
        async getProfilePicUrl() {
            avatarLookups += 1;
            return "https://cdn.example/photo.jpg";
        },
    });
    const server = await startTestServer(whatsappClient);
    const { port } = server.address();

    try {
        const response = await requestAvatar(port, "contact", "5551888888888");
        const payload = await response.json();

        assert.equal(response.status, 404);
        assert.equal(payload.error, true);
        assert.equal(response.headers.get("cache-control"), "private, no-store");
        assert.equal(avatarLookups, 0);
    } finally {
        await stopTestServer(server);
    }
});

test("avatar route returns url null for a contact without a photo", async () => {
    const whatsappClient = createRouteDouble({
        getSessionState() {
            throw new Error("getSessionState must not run on the avatar path");
        },
        async getProfilePicUrl() {
            return undefined;
        },
    });
    const server = await startTestServer(whatsappClient);
    const { port } = server.address();

    try {
        const response = await requestAvatar(port, "contact", "5551999999999@c.us");
        const payload = await response.json();

        assert.equal(response.status, 200);
        assert.equal(payload.error, false);
        assert.deepEqual(payload.data.avatar, {
            targetType: "contact",
            targetValue: "5551999999999",
            url: null,
        });
        assert.equal(response.headers.get("cache-control"), "private, no-store");
    } finally {
        await stopTestServer(server);
    }
});

test("avatar route returns 503 when the session client is not ready", async () => {
    let avatarLookups = 0;
    const whatsappClient = createRouteDouble({
        isSessionReady: () => false,
        async getProfilePicUrl() {
            avatarLookups += 1;
            return null;
        },
    });
    const server = await startTestServer(whatsappClient);
    const { port } = server.address();

    try {
        const response = await requestAvatar(port, "contact", "5551999999999");
        const payload = await response.json();

        assert.equal(response.status, 503);
        assert.equal(payload.error, true);
        assert.equal(payload.type, "Service Unavailable");
        assert.equal(response.headers.get("cache-control"), "private, no-store");
        assert.equal(avatarLookups, 0);
    } finally {
        await stopTestServer(server);
    }
});

test("avatar route rejects a malformed target with 400", async () => {
    let directoryReads = 0;
    const whatsappClient = createRouteDouble({
        isSessionReady() {
            directoryReads += 1;
            return true;
        },
        async getProfilePicUrl() {
            return null;
        },
    });
    const server = await startTestServer(whatsappClient);
    const { port } = server.address();

    try {
        const response = await requestAvatar(port, "contact", "not-a-phone");
        const payload = await response.json();

        assert.equal(response.status, 400);
        assert.equal(payload.error, true);
        assert.equal(response.headers.get("cache-control"), "private, no-store");
        assert.equal(directoryReads, 0);
    } finally {
        await stopTestServer(server);
    }
});

test("avatar client shares one lookup per JID and caches the hit for fifteen minutes", async t => {
    t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    const manager = await createManager(t);
    let calls = 0;
    let releaseLookup;
    let mode = "pending";

    manager.state.ready = true;
    manager.client = {
        profilePictureUrl(jid, type) {
            calls += 1;
            assert.equal(jid, "5551999999999@s.whatsapp.net");
            assert.equal(type, "preview");

            if (mode === "pending") {
                return new Promise(resolve => {
                    releaseLookup = resolve;
                });
            }

            return Promise.resolve("https://cdn.example/photo.jpg");
        },
    };
    const target = { targetType: "contact", targetValue: "5551999999999" };

    const first = manager.getProfilePicUrl(target);
    const second = manager.getProfilePicUrl(target);
    await new Promise(resolve => process.nextTick(resolve));
    assert.equal(calls, 1);

    releaseLookup("https://cdn.example/photo.jpg");
    const [firstUrl, secondUrl] = await Promise.all([first, second]);

    assert.equal(firstUrl, "https://cdn.example/photo.jpg");
    assert.equal(secondUrl, firstUrl);
    assert.equal(calls, 1);

    mode = "immediate";
    t.mock.timers.setTime(1_000_000 + (15 * 60 * 1000) - 1);
    assert.equal(await manager.getProfilePicUrl(target), firstUrl);
    assert.equal(calls, 1);

    t.mock.timers.setTime(1_000_000 + (15 * 60 * 1000) + 1);
    assert.equal(await manager.getProfilePicUrl(target), firstUrl);
    assert.equal(calls, 2);
});

test("avatar client caches a missing photo for two minutes", async t => {
    t.mock.timers.enable({ apis: ["Date"], now: 2_000_000 });
    const manager = await createManager(t);
    let calls = 0;

    manager.state.ready = true;
    manager.client = {
        async profilePictureUrl() {
            calls += 1;
            return undefined;
        },
    };
    const target = { targetType: "contact", targetValue: "5511777777777" };

    assert.equal(await manager.getProfilePicUrl(target), null);
    assert.equal(calls, 1);

    t.mock.timers.setTime(2_000_000 + (2 * 60 * 1000) - 1);
    assert.equal(await manager.getProfilePicUrl(target), null);
    assert.equal(calls, 1);

    t.mock.timers.setTime(2_000_000 + (2 * 60 * 1000) + 1);
    assert.equal(await manager.getProfilePicUrl(target), null);
    assert.equal(calls, 2);
});

test("avatar client resolves group pictures through the group jid", async t => {
    const manager = await createManager(t);
    let received = null;

    manager.state.ready = true;
    manager.client = {
        async profilePictureUrl(jid, type) {
            received = { jid, type };
            return "https://cdn.example/group.jpg";
        },
    };

    const url = await manager.getProfilePicUrl({
        targetType: "group",
        targetValue: "120363043210123456@g.us",
    });

    assert.equal(url, "https://cdn.example/group.jpg");
    assert.deepEqual(received, { jid: "120363043210123456@g.us", type: "preview" });
});

test("avatar client fails one lookup after the five second deadline", async t => {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 5_000 });
    const manager = await createManager(t);

    manager.state.ready = true;
    manager.client = {
        profilePictureUrl() {
            return new Promise(() => {});
        },
    };
    const target = { targetType: "contact", targetValue: "5511666666666" };

    const lookup = manager.getProfilePicUrl(target);
    const rejection = assert.rejects(lookup, error => (
        error instanceof HttpError
        && error.status === 503
        && /timed out/i.test(error.message)
    ));

    await new Promise(resolve => process.nextTick(resolve));
    await t.mock.timers.tick(5000);
    await rejection;
});

test("directory membership answers from the set index without cloning", async t => {
    const manager = await createManager(t);
    manager.directoryTargetIndex = new Set(["contact:5551999999999", "group:120363043210123456@g.us"]);

    assert.equal(manager.hasChatDirectoryTarget({ targetType: "contact", targetValue: "5551999999999" }), true);
    assert.equal(manager.hasChatDirectoryTarget({ targetValue: "5551999999999@c.us" }), true);
    assert.equal(manager.hasChatDirectoryTarget({ targetType: "group", targetValue: "120363043210123456@g.us" }), true);
    assert.equal(manager.hasChatDirectoryTarget({ targetType: "contact", targetValue: "5551888888888" }), false);
});
