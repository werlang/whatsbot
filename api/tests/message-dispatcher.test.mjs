import assert from "node:assert/strict";
import test from "node:test";
import { MessageDispatcher } from "../background/message-dispatcher.js";

test("MessageDispatcher claims due messages and marks successful sends", async () => {
    const sent = [];
    const marked = [];
    const scheduledMessageModel = {
        async claimDue() {
            return [{
                id: "msg-1",
                sessionId: "alpha",
                targetType: "contact",
                targetValue: "5551999999999",
                phoneNumber: "5551999999999",
                message: "hello world",
            }];
        },
        async markSent(id, payload) {
            marked.push({ id, payload });
        },
        async markFailed() {
            throw new Error("markFailed should not be called for successful deliveries");
        },
    };
    const whatsappClient = {
        getReadySessionIds() {
            return ["alpha"];
        },
        async sendMessage(sessionId, target, message) {
            sent.push({ sessionId, target, message });
            return {
                chatId: "5551999999999@c.us",
                whatsappMessageId: "wamid-1",
                sentAt: "2026-04-15T12:00:00.000Z",
            };
        },
    };
    const dispatcher = new MessageDispatcher({
        scheduledMessageModel,
        whatsappClient,
        logger: {
            error() {},
        },
    });

    const processedCount = await dispatcher.tick();

    assert.equal(processedCount, 1);
    assert.deepEqual(sent, [{
        sessionId: "alpha",
        target: {
            targetType: "contact",
            targetValue: "5551999999999",
            phoneNumber: "5551999999999",
        },
        message: "hello world",
    }]);
    assert.deepEqual(marked, [{
        id: "msg-1",
        payload: {
            whatsappChatId: "5551999999999@c.us",
            whatsappMessageId: "wamid-1",
            sentAt: "2026-04-15T12:00:00.000Z",
        },
    }]);
});

test("MessageDispatcher forwards the reclaim timeout when claiming due messages", async () => {
    let claimOptions = null;
    const scheduledMessageModel = {
        async claimDue(options) {
            claimOptions = options;
            return [];
        },
        async markSent() {},
        async markFailed() {},
    };
    const whatsappClient = {
        getReadySessionIds() {
            return ["alpha", "beta"];
        },
    };
    const dispatcher = new MessageDispatcher({
        scheduledMessageModel,
        whatsappClient,
        batchSize: 3,
        claimTimeoutMs: 120000,
        logger: {
            error() {},
        },
    });

    const processedCount = await dispatcher.tick();

    assert.equal(processedCount, 0);
    assert.equal(claimOptions.limit, 3);
    assert.equal(claimOptions.reclaimAfterMs, 120000);
    assert.deepEqual(claimOptions.sessionIds, ["alpha", "beta"]);
    assert.ok(claimOptions.now instanceof Date);
    assert.match(claimOptions.claimToken, /^[0-9a-f-]{36}$/i);
});

test("MessageDispatcher forwards group targets without a phone number", async () => {
    const sent = [];
    const scheduledMessageModel = {
        async claimDue() {
            return [{
                id: "msg-2",
                sessionId: "alpha",
                targetType: "group",
                targetValue: "120363043210123456@g.us",
                phoneNumber: null,
                message: "hello group",
            }];
        },
        async markSent() {},
        async markFailed() {
            throw new Error("markFailed should not be called for successful group deliveries");
        },
    };
    const whatsappClient = {
        getReadySessionIds() {
            return ["alpha"];
        },
        async sendMessage(sessionId, target, message) {
            sent.push({ sessionId, target, message });
            return {
                chatId: "120363043210123456@g.us",
                whatsappMessageId: "wamid-group-1",
                sentAt: "2026-04-15T12:00:00.000Z",
            };
        },
    };
    const dispatcher = new MessageDispatcher({
        scheduledMessageModel,
        whatsappClient,
        logger: {
            error() {},
        },
    });

    const processedCount = await dispatcher.tick();

    assert.equal(processedCount, 1);
    assert.deepEqual(sent, [{
        sessionId: "alpha",
        target: {
            targetType: "group",
            targetValue: "120363043210123456@g.us",
            phoneNumber: null,
        },
        message: "hello group",
    }]);
});
