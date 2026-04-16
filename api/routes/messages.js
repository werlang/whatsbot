import express from "express";
import { normalizeScheduledFor } from "../helpers/date.js";
import { HttpError } from "../helpers/error.js";
import { normalizeMessageTarget } from "../helpers/message-target.js";
import { sendCreated } from "../helpers/response.js";
import { normalizeSessionId } from "../helpers/session.js";
import { ScheduledMessage } from "../model/scheduled-message.js";
import { whatsappSessionManager as defaultWhatsAppSessionManager } from "../services/whatsapp-session-manager.js";

/**
 * Validates and normalizes the schedule payload accepted by POST /messages.
 */
function parseScheduledMessagePayload(payload = {}) {
    const sessionId = normalizeSessionId(payload.sessionId, { fallback: "main" });
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
 * Builds the scheduled-message routes with an injectable persistence model.
 */
function createMessagesRouter({
    scheduledMessageModel = ScheduledMessage,
    whatsappClientManager = defaultWhatsAppSessionManager,
} = {}) {
    const router = express.Router();

    router.post("/", async (req, res, next) => {
        try {
            const payload = parseScheduledMessagePayload(req.body);
            await whatsappClientManager.assertAuthorizedSession(payload.sessionId, req.get("x-whatsbot-session-token") || "");
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

    return router;
}

const router = createMessagesRouter();

export { createMessagesRouter, parseScheduledMessagePayload, router };
