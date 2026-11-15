import assert from "node:assert/strict";
import test from "node:test";
import { WhatsAppSessionManager } from "../services/whatsapp-session-manager.js";

/**
 * Creates one ready client double whose chat directory read always fails.
 */
function createFailingDirectoryClient() {
    return {
        async initialize() {},
        isReady: () => true,
        async refreshChatDirectory() {
            throw new Error("r: r");
        },
        getSessionState: () => ({
            status: "ready",
            ready: true,
            authenticated: true,
        }),
    };
}

test("getSessionState keeps reporting a ready session when the chat directory refresh fails", async () => {
    const errors = [];
    const manager = new WhatsAppSessionManager({
        clientFactory: () => createFailingDirectoryClient(),
        logger: { error(...args) { errors.push(args); }, warn() {} },
        sessionAccessStore: { async initialize() {} },
    });

    const state = await manager.getSessionState("alpha");

    assert.equal(state.sessionId, "alpha");
    assert.equal(state.ready, true);
    assert.equal(errors.length, 1);
    assert.match(String(errors[0][0]), /chat directory for session alpha/);
});
