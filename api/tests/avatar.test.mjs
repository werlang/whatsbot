import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { createApp } from "../app.js";
import { HttpError } from "../helpers/error.js";
import { WhatsAppClientManager } from "../services/whatsapp-client-manager.js";

const baseConfig = {
    clientId: "main",
    authPath: "/tmp/whatsbot-avatar-test-auth",
    executablePath: "/usr/bin/chromium-browser",
    puppeteerArgs: [],
};

const silentLogger = {
    error() {},
    warn() {},
};

const chatDirectory = {
    contacts: [{
        id: "5551999999999@c.us",
        name: "Alice",
        targetType: "contact",
        targetValue: "5551999999999",
        phoneNumber: "5551999999999",
        chatId: "5551999999999@c.us",
        label: "Alice",
    }],
    groups: [{
        id: "120363043210123456@g.us",
        name: "Launch Team",
        targetType: "group",
        targetValue: "120363043210123456@g.us",
        phoneNumber: null,
        chatId: "120363043210123456@g.us",
        label: "Launch Team",
    }],
    refreshedAt: "2026-04-15T12:00:00.000Z",
};

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

test("avatar route authorizes before reading the directory", async () => {
    let directoryReads = 0;
    let avatarLookups = 0;
    const whatsappClient = {
        async assertAuthorizedSession() {
            throw new HttpError(401, "Session token is invalid.");
        },
        async getSessionState() {
            directoryReads += 1;
            return { ready: true, chatDirectory };
        },
        async getProfilePicUrl() {
            avatarLookups += 1;
            return "https://cdn.example/photo.jpg";
        },
    };
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

test("avatar route rejects an unknown target with 404", async () => {
    let avatarLookups = 0;
    const whatsappClient = {
        async assertAuthorizedSession() {},
        async getSessionState() {
            return { ready: true, chatDirectory };
        },
        async getProfilePicUrl() {
            avatarLookups += 1;
            return "https://cdn.example/photo.jpg";
        },
    };
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
    const whatsappClient = {
        async assertAuthorizedSession() {},
        async getSessionState() {
            return { ready: true, chatDirectory };
        },
        async getProfilePicUrl() {
            return undefined;
        },
    };
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
    const whatsappClient = {
        async assertAuthorizedSession() {},
        async getSessionState() {
            return { ready: false, chatDirectory: { contacts: [], groups: [], refreshedAt: null } };
        },
        async getProfilePicUrl() {
            avatarLookups += 1;
            return null;
        },
    };
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
    const whatsappClient = {
        async assertAuthorizedSession() {},
        async getSessionState() {
            directoryReads += 1;
            return { ready: true, chatDirectory };
        },
        async getProfilePicUrl() {
            return null;
        },
    };
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
    const manager = new WhatsAppClientManager(baseConfig, { logger: silentLogger });
    let calls = 0;
    let releaseLookup;
    let mode = "pending";

    manager.state.ready = true;
    manager.client = {
        getProfilePicUrl(jid) {
            calls += 1;
            assert.equal(jid, "5551999999999@c.us");

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
    const manager = new WhatsAppClientManager(baseConfig, { logger: silentLogger });
    let calls = 0;

    manager.state.ready = true;
    manager.client = {
        async getProfilePicUrl() {
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

test("avatar client fails one lookup after the five second deadline", async t => {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 5_000 });
    const manager = new WhatsAppClientManager(baseConfig, { logger: silentLogger });

    manager.state.ready = true;
    manager.client = {
        getProfilePicUrl() {
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
