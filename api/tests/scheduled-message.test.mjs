import assert from "node:assert/strict";
import test from "node:test";
import { ScheduledMessage } from "../model/scheduled-message.js";

function toDateTime(value) {
    return new Date(value).toISOString().slice(0, 19).replace("T", " ");
}

test("ScheduledMessage.claimDue reclaims stale processing rows without touching fresh claims", async () => {
    const originalDriver = ScheduledMessage.driver;
    const connection = { name: "transaction-connection" };
    const findCalls = [];
    const updateCalls = [];

    ScheduledMessage.driver = {
        toDateTime,
        lte(value) {
            return { "<=": value };
        },
        async transaction(callback) {
            return callback(connection);
        },
        async find(table, { filter, view, opt, connection: activeConnection } = {}) {
            findCalls.push({ table, filter, view, opt, connection: activeConnection });

            if (findCalls.length === 1) {
                return [{ id: "pending-1" }, { id: "stale-1" }];
            }

            if (findCalls.length === 2) {
                return [{ id: "stale-1", scheduled_for: "2026-04-15 11:30:00", status: "processing", claimed_at: "2026-04-15 11:40:00" }];
            }

            return [{
                id: "pending-1",
                session_id: "main",
                target_type: "contact",
                target_value: "5551999999999",
                phone_number: "5551999999999",
                message: "hello world",
                scheduled_for: "2026-04-15 11:45:00",
                status: "processing",
                claim_token: "claim-1",
                claimed_at: "2026-04-15 12:00:00",
                last_attempt_at: "2026-04-15 12:00:00",
                sent_at: null,
                whatsapp_chat_id: null,
                whatsapp_message_id: null,
                error_message: null,
                created_at: "2026-04-15 11:40:00",
                updated_at: "2026-04-15 12:00:00",
            }, {
                id: "stale-1",
                session_id: "main",
                target_type: "contact",
                target_value: "5551888888888",
                phone_number: "5551888888888",
                message: "reclaimed",
                scheduled_for: "2026-04-15 11:30:00",
                status: "processing",
                claim_token: "claim-1",
                claimed_at: "2026-04-15 12:00:00",
                last_attempt_at: "2026-04-15 12:00:00",
                sent_at: null,
                whatsapp_chat_id: null,
                whatsapp_message_id: null,
                error_message: null,
                created_at: "2026-04-15 11:25:00",
                updated_at: "2026-04-15 12:00:00",
            }];
        },
        async update(table, data, clause, { connection: activeConnection } = {}) {
            updateCalls.push({ table, data, clause, connection: activeConnection });
            return { affectedRows: 1 };
        },
    };

    try {
        const claimedMessages = await ScheduledMessage.claimDue({
            now: new Date("2026-04-15T12:00:00.000Z"),
            limit: 2,
            claimToken: "claim-1",
            reclaimAfterMs: 10 * 60 * 1000,
            sessionIds: ["main"],
        });

        assert.equal(claimedMessages.length, 2);
        assert.equal(claimedMessages[0].claimToken, "claim-1");
        assert.equal(claimedMessages[1].phoneNumber, "5551888888888");

        assert.deepEqual(findCalls[0], {
            table: ScheduledMessage.table,
            filter: {
                session_id: ["main"],
                scheduled_for: { "<=": "2026-04-15 12:00:00" },
                status: ScheduledMessage.STATUS_PENDING,
            },
            view: ["id", "session_id", "scheduled_for", "status", "claimed_at"],
            opt: {
                order: { scheduled_for: 1 },
                limit: 2,
            },
            connection,
        });
        assert.deepEqual(findCalls[1], {
            table: ScheduledMessage.table,
            filter: {
                session_id: ["main"],
                scheduled_for: { "<=": "2026-04-15 12:00:00" },
                status: ScheduledMessage.STATUS_PROCESSING,
                claimed_at: { "<=": "2026-04-15 11:50:00" },
            },
            view: ["id", "session_id", "scheduled_for", "status", "claimed_at"],
            opt: {
                order: { scheduled_for: 1 },
                limit: 2,
            },
            connection,
        });
        assert.equal(updateCalls.length, 2);
        assert.deepEqual(updateCalls[0].clause, {
            id: "stale-1",
            status: ScheduledMessage.STATUS_PROCESSING,
            claimed_at: { "<=": "2026-04-15 11:50:00" },
        });
        assert.deepEqual(updateCalls[1].clause, {
            id: "pending-1",
            status: ScheduledMessage.STATUS_PENDING,
        });
        assert.equal(findCalls[2].connection, connection);
    } finally {
        ScheduledMessage.driver = originalDriver;
    }
});
