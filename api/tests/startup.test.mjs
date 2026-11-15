import assert from "node:assert/strict";
import test from "node:test";
import { start } from "../app.js";

/**
 * Creates one never-settling promise, used to keep the WhatsApp boot pending in tests.
 */
function createPendingPromise() {
    let resolve;
    const promise = new Promise(resolver => {
        resolve = resolver;
    });
    return { promise, resolve };
}

/**
 * Creates the minimal runtime doubles start() needs.
 */
function createRuntimeDoubles({ initialize } = {}) {
    const calls = { start: 0 };
    return {
        calls,
        mysqlDriver: { async waitForReady() {} },
        whatsappClient: {
            initialize,
            async destroy() {},
        },
        dispatcher: {
            start() { calls.start += 1; },
            stop() {},
        },
    };
}

test("start listens before the WhatsApp client finishes initializing", async () => {
    const pending = createPendingPromise();
    const doubles = createRuntimeDoubles({ initialize: () => pending.promise });
    const server = await start({ ...doubles, listenPort: 0 });

    try {
        const { port } = server.address();
        const response = await fetch(`http://127.0.0.1:${port}/ready`);
        assert.equal(response.status, 200);
        assert.equal(doubles.calls.start, 1);
        assert.equal(pending.promise instanceof Promise, true);
    } finally {
        pending.resolve();
        await server.whatsappInitialization;
        await new Promise(resolve => server.close(resolve));
    }
});

test("start keeps the API up when the WhatsApp client boot fails", async () => {
    const doubles = createRuntimeDoubles({
        initialize: async () => { throw new Error('Runtime.callFunctionOn timed out.'); },
    });
    const server = await start({ ...doubles, listenPort: 0 });

    try {
        await server.whatsappInitialization;
        const { port } = server.address();
        const response = await fetch(`http://127.0.0.1:${port}/ready`);
        const payload = await response.json();
        assert.equal(response.status, 200);
        assert.equal(payload.data.ready, false);
        assert.ok(payload.data.reasons.some(reason => /session is ready/i.test(reason)));
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
});
