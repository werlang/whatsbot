import assert from "node:assert/strict";
import test from "node:test";
import { ScheduledMessage } from "../model/scheduled-message.js";

function toDateTime(value) {
    return new Date(value).toISOString().slice(0, 19).replace("T", " ");
}

test("ScheduledMessage.claimDue reclaims stale processing rows without touching fresh claims", async () => {
    const originalDriver = ScheduledMessage.driver;
    const connection = { name: "transaction-connection" };
    const queries = [];

    ScheduledMessage.driver = {
        toDateTime,
        async transaction(callback) {
            return callback(connection);
        },
        async query(sql, params, options = {}) {
            queries.push({ sql: sql.replace(/\s+/g, " ").trim(), params, options });

            if (queries.length === 1) {
                return [{ id: "pending-1" }, { id: "stale-1" }];
            }

            if (queries.length === 2) {
                return { affectedRows: 2 };
            }

            return [{
                id: "pending-1",
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
    };

    try {
        const claimedMessages = await ScheduledMessage.claimDue({
            now: new Date("2026-04-15T12:00:00.000Z"),
            limit: 2,
            claimToken: "claim-1",
            reclaimAfterMs: 10 * 60 * 1000,
        });

        assert.equal(claimedMessages.length, 2);
        assert.equal(claimedMessages[0].claimToken, "claim-1");
        assert.equal(claimedMessages[1].phoneNumber, "5551888888888");

        assert.match(queries[0].sql, /status = \? OR \(status = \? AND claimed_at IS NOT NULL AND claimed_at <= \?\)/);
        assert.deepEqual(queries[0].params, [
            "2026-04-15 12:00:00",
            ScheduledMessage.STATUS_PENDING,
            ScheduledMessage.STATUS_PROCESSING,
            "2026-04-15 11:50:00",
            2,
        ]);
        assert.equal(queries[0].options.connection, connection);

        assert.match(queries[1].sql, /WHERE id IN \(\?, \?\) AND \( status = \? OR \(status = \? AND claimed_at IS NOT NULL AND claimed_at <= \?\) \)/);
        assert.deepEqual(queries[1].params, [
            ScheduledMessage.STATUS_PROCESSING,
            "claim-1",
            "2026-04-15 12:00:00",
            "2026-04-15 12:00:00",
            "2026-04-15 12:00:00",
            "pending-1",
            "stale-1",
            ScheduledMessage.STATUS_PENDING,
            ScheduledMessage.STATUS_PROCESSING,
            "2026-04-15 11:50:00",
        ]);
    } finally {
        ScheduledMessage.driver = originalDriver;
    }
});
