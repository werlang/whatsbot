import express from "express";
import { normalizeScheduledFor } from "../helpers/date.js";
import { HttpError } from "../helpers/error.js";
import { normalizeMessageTarget } from "../helpers/message-target.js";
import { sendCreated, sendSuccess } from "../helpers/response.js";
import { normalizeSessionId } from "../helpers/session.js";
import { ScheduledMessage } from "../model/scheduled-message.js";
import { whatsappSessionManager as defaultWhatsAppSessionManager } from "../services/whatsapp-session-manager.js";

/**
 * Validates and normalizes the schedule payload accepted by POST /messages.
 */
function parseScheduledMessagePayload(payload = {}, { fallbackSessionId = "main" } = {}) {
    const sessionId = normalizeSessionId(payload.sessionId, { fallback: fallbackSessionId });
    const messageTarget = normalizeMessageTarget(payload);
    const message = String(payload.message ?? "").trim();

    if (!message) {
        throw new HttpError(400, "message is required.");
    }

    return {
        sessionId,
        ...messageTarget,
        message,
        scheduledFor: normalizeScheduledFor(payload.scheduledFor),
    };
}

/**
 * Reads the session token from the request headers.
 */
function readSessionToken(req) {
    return req.get("x-whatsbot-session-token") || "";
}

/**
 * Validates one scheduled message id from a route parameter.
 */
function parseScheduledMessageId(value) {
    const scheduledMessageId = String(value ?? "").trim();

    if (!scheduledMessageId) {
        throw new HttpError(400, "scheduledMessageId is required.");
    }

    return scheduledMessageId;
}

/**
 * Validates that the route is not attempting to move a schedule across sessions.
 */
function assertUnchangedSessionId(payload = {}, scheduledMessage = {}) {
    if (!Object.prototype.hasOwnProperty.call(payload, "sessionId")) {
        return;
    }

    const requestedSessionId = normalizeSessionId(payload.sessionId, {
        fallback: scheduledMessage.sessionId || "main",
    });

    if (requestedSessionId !== scheduledMessage.sessionId) {
        throw new HttpError(400, "sessionId cannot be changed.");
    }
}

/**
 * Returns true when one scheduled message can still be edited or deleted.
 */
function isEditableScheduledMessage(scheduledMessageModel, scheduledMessage) {
    if (typeof scheduledMessageModel.isEditable === "function") {
        return scheduledMessageModel.isEditable(scheduledMessage);
    }

    return ["pending", "failed"].includes(String(scheduledMessage?.status || "").trim().toLowerCase());
}

/**
 * Loads one scheduled message and validates that it can still be changed.
 */
async function requireEditableScheduledMessage(scheduledMessageModel, scheduledMessageId) {
    const scheduledMessage = await scheduledMessageModel.findById(scheduledMessageId);

    if (!scheduledMessage) {
        throw new HttpError(404, "Scheduled message not found.");
    }

    if (!isEditableScheduledMessage(scheduledMessageModel, scheduledMessage)) {
        throw new HttpError(409, "Only pending or failed scheduled messages can be changed.");
    }

    return scheduledMessage;
}

/**
 * Builds the scheduled-message routes with an injectable persistence model.
 */
function createMessagesRouter({
    scheduledMessageModel = ScheduledMessage,
    whatsappClientManager = defaultWhatsAppSessionManager,
} = {}) {
    const router = express.Router();

    router.get("/", async (req, res, next) => {
        try {
            const sessionId = normalizeSessionId(
                req.query.sessionId,
                { fallback: whatsappClientManager.getDefaultSessionId?.() || "main" },
            );
            await whatsappClientManager.assertAuthorizedSession(sessionId, readSessionToken(req));
            const scheduledMessages = await scheduledMessageModel.listBySessionId(sessionId);

            return sendSuccess(res, {
                data: { scheduledMessages },
            });
        } catch (error) {
            return next(error instanceof HttpError
                ? error
                : new HttpError(500, "Could not load the scheduled messages.", error));
        }
    });

    router.post("/", async (req, res, next) => {
        try {
            const payload = parseScheduledMessagePayload(req.body);
            await whatsappClientManager.assertAuthorizedSession(payload.sessionId, readSessionToken(req));
            await whatsappClientManager.assertMessageTargetReachable?.(payload.sessionId, payload);
            const scheduledMessage = await scheduledMessageModel.create(payload);
            return sendCreated(res, {
                data: { scheduledMessage },
                message: "Scheduled message created.",
            });
        } catch (error) {
            return next(error instanceof HttpError
                ? error
                : new HttpError(500, "Could not schedule the WhatsApp message.", error));
        }
    });

    router.put("/:scheduledMessageId", async (req, res, next) => {
        try {
            const scheduledMessageId = parseScheduledMessageId(req.params.scheduledMessageId);
            const existingScheduledMessage = await requireEditableScheduledMessage(scheduledMessageModel, scheduledMessageId);
            await whatsappClientManager.assertAuthorizedSession(existingScheduledMessage.sessionId, readSessionToken(req));
            assertUnchangedSessionId(req.body, existingScheduledMessage);

            const payload = parseScheduledMessagePayload({
                ...req.body,
                sessionId: existingScheduledMessage.sessionId,
            }, {
                fallbackSessionId: existingScheduledMessage.sessionId,
            });

            await whatsappClientManager.assertMessageTargetReachable?.(payload.sessionId, payload);

            const scheduledMessage = await scheduledMessageModel.updateEditable(scheduledMessageId, payload);
            return sendSuccess(res, {
                data: { scheduledMessage },
                message: "Scheduled message updated.",
            });
        } catch (error) {
            return next(error instanceof HttpError
                ? error
                : new HttpError(500, "Could not update the scheduled message.", error));
        }
    });

    router.delete("/:scheduledMessageId", async (req, res, next) => {
        try {
            const scheduledMessageId = parseScheduledMessageId(req.params.scheduledMessageId);
            const existingScheduledMessage = await requireEditableScheduledMessage(scheduledMessageModel, scheduledMessageId);
            await whatsappClientManager.assertAuthorizedSession(existingScheduledMessage.sessionId, readSessionToken(req));
            await scheduledMessageModel.deleteById(scheduledMessageId);

            return sendSuccess(res, {
                data: {
                    scheduledMessageId,
                },
                message: "Scheduled message deleted.",
            });
        } catch (error) {
            return next(error instanceof HttpError
                ? error
                : new HttpError(500, "Could not delete the scheduled message.", error));
        }
    });

    return router;
}

const router = createMessagesRouter();

export { createMessagesRouter, parseScheduledMessagePayload, router };
