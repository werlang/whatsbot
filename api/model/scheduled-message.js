import crypto from "node:crypto";
import { Model } from "./model.js";
import { normalizeMessageTarget } from "../helpers/message-target.js";

/**
 * Persists one scheduled WhatsApp message and its delivery lifecycle.
 */
class ScheduledMessage extends Model {
    static table = "scheduled_messages";
    static view = [
        "id",
        "session_id",
        "target_type",
        "target_value",
        "phone_number",
        "message",
        "scheduled_for",
        "status",
        "claim_token",
        "claimed_at",
        "last_attempt_at",
        "sent_at",
        "whatsapp_chat_id",
        "whatsapp_message_id",
        "error_message",
        "created_at",
        "updated_at",
    ];
    static STATUS_PENDING = "pending";
    static STATUS_PROCESSING = "processing";
    static STATUS_SENT = "sent";
    static STATUS_FAILED = "failed";
    static DEFAULT_RECLAIM_AFTER_MS = 10 * 60 * 1000;
    static ALLOWED_STATUSES = ["pending", "processing", "sent", "failed"];
    static EDITABLE_STATUSES = ["pending", "failed"];

    /**
     * Creates the scheduled message entity with project defaults.
     */
    constructor({
        id,
        sessionId,
        targetType,
        targetValue,
        phoneNumber,
        message,
        scheduledFor,
        status,
        claimToken,
        claimedAt,
        lastAttemptAt,
        sentAt,
        whatsappChatId,
        whatsappMessageId,
        errorMessage,
        createdAt,
        updatedAt,
    } = {}) {
        super();
        const messageTarget = normalizeMessageTarget({ targetType, targetValue, phoneNumber });

        this.id = id || crypto.randomUUID();
        this.sessionId = String(sessionId || "main").trim() || "main";
        this.targetType = messageTarget.targetType;
        this.targetValue = messageTarget.targetValue;
        this.phoneNumber = messageTarget.phoneNumber;
        this.message = String(message ?? "").trim();
        this.scheduledFor = new Date(scheduledFor).toISOString();
        this.status = ScheduledMessage.normalizeStatus(status);
        this.claimToken = claimToken || null;
        this.claimedAt = claimedAt ? new Date(claimedAt).toISOString() : null;
        this.lastAttemptAt = lastAttemptAt ? new Date(lastAttemptAt).toISOString() : null;
        this.sentAt = sentAt ? new Date(sentAt).toISOString() : null;
        this.whatsappChatId = typeof whatsappChatId === "string" ? whatsappChatId.trim() || null : null;
        this.whatsappMessageId = typeof whatsappMessageId === "string" ? whatsappMessageId.trim() || null : null;
        this.errorMessage = typeof errorMessage === "string" ? errorMessage.trim() || null : null;
        this.createdAt = createdAt ? new Date(createdAt).toISOString() : new Date().toISOString();
        this.updatedAt = updatedAt ? new Date(updatedAt).toISOString() : new Date().toISOString();
    }

    /**
     * Returns the serializable entity snapshot.
     */
    toJSON() {
        return {
            id: this.id,
            sessionId: this.sessionId,
            targetType: this.targetType,
            targetValue: this.targetValue,
            phoneNumber: this.phoneNumber,
            message: this.message,
            scheduledFor: this.scheduledFor,
            status: this.status,
            claimToken: this.claimToken,
            claimedAt: this.claimedAt,
            lastAttemptAt: this.lastAttemptAt,
            sentAt: this.sentAt,
            whatsappChatId: this.whatsappChatId,
            whatsappMessageId: this.whatsappMessageId,
            errorMessage: this.errorMessage,
            createdAt: this.createdAt,
            updatedAt: this.updatedAt,
        };
    }

    /**
     * Normalizes one persisted status value.
     */
    static normalizeStatus(status) {
        const normalizedStatus = String(status || ScheduledMessage.STATUS_PENDING).trim().toLowerCase();
        return ScheduledMessage.ALLOWED_STATUSES.includes(normalizedStatus)
            ? normalizedStatus
            : ScheduledMessage.STATUS_PENDING;
    }

    /**
     * Normalizes a raw database row into the public scheduled message shape.
     */
    static normalize(row) {
        if (!row) {
            return null;
        }

        const messageTarget = normalizeMessageTarget({
            targetType: row.targetType || row.target_type,
            targetValue: row.targetValue || row.target_value,
            phoneNumber: row.phoneNumber || row.phone_number,
        });

        return {
            id: row.id,
            sessionId: row.sessionId || row.session_id || "main",
            targetType: messageTarget.targetType,
            targetValue: messageTarget.targetValue,
            phoneNumber: messageTarget.phoneNumber,
            message: row.message,
            scheduledFor: row.scheduledFor || row.scheduled_for
                ? new Date(row.scheduledFor || row.scheduled_for).toISOString()
                : null,
            status: ScheduledMessage.normalizeStatus(row.status),
            claimToken: row.claimToken || row.claim_token || null,
            claimedAt: row.claimedAt || row.claimed_at
                ? new Date(row.claimedAt || row.claimed_at).toISOString()
                : null,
            lastAttemptAt: row.lastAttemptAt || row.last_attempt_at
                ? new Date(row.lastAttemptAt || row.last_attempt_at).toISOString()
                : null,
            sentAt: row.sentAt || row.sent_at
                ? new Date(row.sentAt || row.sent_at).toISOString()
                : null,
            whatsappChatId: row.whatsappChatId || row.whatsapp_chat_id || null,
            whatsappMessageId: row.whatsappMessageId || row.whatsapp_message_id || null,
            errorMessage: row.errorMessage || row.error_message || null,
            createdAt: row.createdAt || row.created_at
                ? new Date(row.createdAt || row.created_at).toISOString()
                : null,
            updatedAt: row.updatedAt || row.updated_at
                ? new Date(row.updatedAt || row.updated_at).toISOString()
                : null,
        };
    }

    /**
     * Serializes a scheduled message into database column names.
     */
    static serialize(payload = {}) {
        const scheduledMessage = payload instanceof ScheduledMessage
            ? payload.toJSON()
            : new ScheduledMessage(payload).toJSON();

        return {
            id: scheduledMessage.id,
            session_id: scheduledMessage.sessionId,
            target_type: scheduledMessage.targetType,
            target_value: scheduledMessage.targetValue,
            phone_number: scheduledMessage.phoneNumber,
            message: scheduledMessage.message,
            scheduled_for: this.driver.toDateTime(scheduledMessage.scheduledFor),
            status: this.normalizeStatus(scheduledMessage.status),
            claim_token: scheduledMessage.claimToken,
            claimed_at: scheduledMessage.claimedAt ? this.driver.toDateTime(scheduledMessage.claimedAt) : null,
            last_attempt_at: scheduledMessage.lastAttemptAt ? this.driver.toDateTime(scheduledMessage.lastAttemptAt) : null,
            sent_at: scheduledMessage.sentAt ? this.driver.toDateTime(scheduledMessage.sentAt) : null,
            whatsapp_chat_id: scheduledMessage.whatsappChatId,
            whatsapp_message_id: scheduledMessage.whatsappMessageId,
            error_message: scheduledMessage.errorMessage,
            created_at: this.driver.toDateTime(scheduledMessage.createdAt),
            updated_at: this.driver.toDateTime(scheduledMessage.updatedAt),
        };
    }

    /**
     * Serializes mutable fields without overwriting immutable columns.
     */
    static serializeMutablePayload(payload = {}) {
        return Object.fromEntries(
            Object.entries({
                scheduled_for: payload.scheduledFor ? this.driver.toDateTime(payload.scheduledFor) : undefined,
                status: payload.status ? this.normalizeStatus(payload.status) : undefined,
                claim_token: Object.prototype.hasOwnProperty.call(payload, "claimToken") ? payload.claimToken : undefined,
                claimed_at: Object.prototype.hasOwnProperty.call(payload, "claimedAt")
                    ? (payload.claimedAt ? this.driver.toDateTime(payload.claimedAt) : null)
                    : undefined,
                last_attempt_at: Object.prototype.hasOwnProperty.call(payload, "lastAttemptAt")
                    ? (payload.lastAttemptAt ? this.driver.toDateTime(payload.lastAttemptAt) : null)
                    : undefined,
                sent_at: Object.prototype.hasOwnProperty.call(payload, "sentAt")
                    ? (payload.sentAt ? this.driver.toDateTime(payload.sentAt) : null)
                    : undefined,
                whatsapp_chat_id: Object.prototype.hasOwnProperty.call(payload, "whatsappChatId") ? payload.whatsappChatId || null : undefined,
                whatsapp_message_id: Object.prototype.hasOwnProperty.call(payload, "whatsappMessageId") ? payload.whatsappMessageId || null : undefined,
                error_message: Object.prototype.hasOwnProperty.call(payload, "errorMessage") ? payload.errorMessage || null : undefined,
                updated_at: payload.updatedAt ? this.driver.toDateTime(payload.updatedAt) : undefined,
            }).filter(([, value]) => value !== undefined),
        );
    }

    /**
     * Serializes user-editable fields while resetting delivery state back to pending.
     */
    static serializeEditablePayload(payload = {}) {
        const messageTarget = normalizeMessageTarget(payload);

        return Object.fromEntries(
            Object.entries({
                target_type: messageTarget.targetType,
                target_value: messageTarget.targetValue,
                phone_number: messageTarget.phoneNumber,
                message: String(payload.message ?? "").trim(),
                scheduled_for: payload.scheduledFor ? this.driver.toDateTime(payload.scheduledFor) : undefined,
                status: this.STATUS_PENDING,
                claim_token: null,
                claimed_at: null,
                last_attempt_at: null,
                sent_at: null,
                whatsapp_chat_id: null,
                whatsapp_message_id: null,
                error_message: null,
                updated_at: this.driver.toDateTime(payload.updatedAt || new Date().toISOString()),
            }).filter(([, value]) => value !== undefined),
        );
    }

    /**
     * Creates and returns one persisted scheduled message.
     */
    static async create(payload) {
        const scheduledMessage = payload instanceof ScheduledMessage
            ? payload.toJSON()
            : new ScheduledMessage(payload).toJSON();
        await this.insert(scheduledMessage);
        return this.get(scheduledMessage.id);
    }

    /**
     * Retrieves one scheduled message by id.
     */
    static async findById(id) {
        if (!id) {
            return null;
        }

        return this.get(id);
    }

    /**
     * Returns true when one scheduled message can still be edited or removed.
     */
    static isEditable(scheduledMessage = {}) {
        return this.EDITABLE_STATUSES.includes(this.normalizeStatus(scheduledMessage.status));
    }

    /**
     * Lists the scheduled messages that belong to one session.
     */
    static async listBySessionId(sessionId, { limit = 100 } = {}) {
        const normalizedSessionId = String(sessionId || "main").trim() || "main";
        const boundedLimit = Math.max(1, Number.parseInt(limit, 10) || 100);

        return this.find({
            filter: {
                session_id: normalizedSessionId,
            },
            view: this.view,
            opt: {
                order: { scheduled_for: 1 },
                limit: boundedLimit,
            },
        });
    }

    /**
     * Updates one editable scheduled message and returns the persisted snapshot.
     */
    static async updateEditable(id, payload = {}) {
        if (!id) {
            return null;
        }

        await this.driver.update(this.table, this.serializeEditablePayload(payload), id);
        return this.get(id);
    }

    /**
     * Deletes one scheduled message by id.
     */
    static async deleteById(id) {
        if (!id) {
            return false;
        }

        await this.delete(id, { limit: 1 });
        return true;
    }

    /**
     * Claims a batch of due pending messages for one dispatcher loop.
     */
    static async claimDue({
        now = new Date(),
        limit = 5,
        claimToken = crypto.randomUUID(),
        reclaimAfterMs = this.DEFAULT_RECLAIM_AFTER_MS,
        sessionIds = [],
    } = {}) {
        const claimTime = new Date(now);
        const boundedLimit = Math.max(1, Number.parseInt(limit, 10) || 5);
        const boundedReclaimAfterMs = Math.max(Number(reclaimAfterMs) || this.DEFAULT_RECLAIM_AFTER_MS, 1000);
        const normalizedSessionIds = [...new Set((Array.isArray(sessionIds) ? sessionIds : [sessionIds])
            .map(sessionId => String(sessionId ?? "").trim())
            .filter(Boolean))];

        if (normalizedSessionIds.length === 0) {
            return [];
        }

        const dueAt = this.driver.toDateTime(claimTime);
        const claimedAt = this.driver.toDateTime(claimTime);
        const reclaimBefore = this.driver.toDateTime(new Date(claimTime.getTime() - boundedReclaimAfterMs));
        const claimPayload = this.serializeMutablePayload({
            status: this.STATUS_PROCESSING,
            claimToken,
            claimedAt,
            lastAttemptAt: claimedAt,
            updatedAt: claimedAt,
        });

        return this.driver.transaction(async connection => {
            const [pendingRows, staleProcessingRows] = await Promise.all([
                this.driver.find(this.table, {
                    filter: {
                        session_id: normalizedSessionIds,
                        scheduled_for: this.driver.lte(dueAt),
                        status: this.STATUS_PENDING,
                    },
                    view: ["id", "session_id", "scheduled_for", "status", "claimed_at"],
                    opt: {
                        order: { scheduled_for: 1 },
                        limit: boundedLimit,
                    },
                    connection,
                }),
                this.driver.find(this.table, {
                    filter: {
                        session_id: normalizedSessionIds,
                        scheduled_for: this.driver.lte(dueAt),
                        status: this.STATUS_PROCESSING,
                        claimed_at: this.driver.lte(reclaimBefore),
                    },
                    view: ["id", "session_id", "scheduled_for", "status", "claimed_at"],
                    opt: {
                        order: { scheduled_for: 1 },
                        limit: boundedLimit,
                    },
                    connection,
                }),
            ]);

            const dueRows = [...pendingRows, ...staleProcessingRows]
                .sort((left, right) => String(left.scheduled_for).localeCompare(String(right.scheduled_for)))
                .slice(0, boundedLimit);

            if (dueRows.length === 0) {
                return [];
            }

            const claimedIds = [];

            for (const row of dueRows) {
                const claimFilter = row.status === this.STATUS_PROCESSING
                    ? {
                        id: row.id,
                        status: this.STATUS_PROCESSING,
                        claimed_at: this.driver.lte(reclaimBefore),
                    }
                    : {
                        id: row.id,
                        status: this.STATUS_PENDING,
                    };

                const result = await this.driver.update(this.table, claimPayload, claimFilter, { connection });

                if (result?.affectedRows > 0) {
                    claimedIds.push(row.id);
                }

                if (claimedIds.length >= boundedLimit) {
                    break;
                }
            }

            if (claimedIds.length === 0) {
                return [];
            }

            const rows = await this.driver.find(this.table, {
                filter: {
                    claim_token: claimToken,
                },
                view: this.view,
                opt: {
                    order: { scheduled_for: 1 },
                },
                connection,
            });

            return rows.map(row => this.normalize(row));
        });
    }

    /**
     * Marks one claimed message as successfully sent.
     */
    static async markSent(id, { whatsappChatId = null, whatsappMessageId = null, sentAt = new Date().toISOString() } = {}) {
        if (!id) {
            return null;
        }

        await this.driver.update(this.table, this.serializeMutablePayload({
            status: this.STATUS_SENT,
            claimToken: null,
            claimedAt: null,
            lastAttemptAt: sentAt,
            sentAt,
            whatsappChatId,
            whatsappMessageId,
            errorMessage: null,
            updatedAt: sentAt,
        }), id);
        return this.get(id);
    }

    /**
     * Marks one claimed message as failed and stores the delivery error.
     */
    static async markFailed(id, error, { failedAt = new Date().toISOString() } = {}) {
        if (!id) {
            return null;
        }

        await this.driver.update(this.table, this.serializeMutablePayload({
            status: this.STATUS_FAILED,
            claimToken: null,
            claimedAt: null,
            lastAttemptAt: failedAt,
            errorMessage: this.readErrorMessage(error),
            updatedAt: failedAt,
        }), id);
        return this.get(id);
    }

    /**
     * Builds one safe string message from a thrown delivery error.
     */
    static readErrorMessage(error) {
        return String(error?.message || error || "Unknown WhatsApp delivery error.").slice(0, 65535);
    }
}

export { ScheduledMessage };
