import express from "express";
import { normalizeScheduledFor } from "../helpers/date.js";
import { HttpError } from "../helpers/error.js";
import { normalizePhoneNumber } from "../helpers/phone-number.js";
import { sendCreated } from "../helpers/response.js";
import { normalizeSessionId } from "../helpers/session.js";
import { ScheduledMessage } from "../model/scheduled-message.js";

/**
 * Validates and normalizes the schedule payload accepted by POST /messages.
 */
function parseScheduledMessagePayload(payload = {}) {
    const sessionId = normalizeSessionId(payload.sessionId, { fallback: "main" });
    const phoneNumber = normalizePhoneNumber(payload.phoneNumber);
    const message = String(payload.message ?? "").trim();

    if (!message) {
        throw new HttpError(400, "message is required.");
    }

    return {
        sessionId,
        phoneNumber,
        message,
        scheduledFor: normalizeScheduledFor(payload.scheduledFor),
    };
}

/**
 * Builds the scheduled-message routes with an injectable persistence model.
 */
function createMessagesRouter({ scheduledMessageModel = ScheduledMessage } = {}) {
    const router = express.Router();

    router.post("/", async (req, res, next) => {
        try {
            const scheduledMessage = await scheduledMessageModel.create(parseScheduledMessagePayload(req.body));
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
