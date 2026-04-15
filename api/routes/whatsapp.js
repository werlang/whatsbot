import express from "express";
import { HttpError } from "../helpers/error.js";
import { sendSuccess } from "../helpers/response.js";
import { whatsappClientManager as defaultWhatsAppClientManager } from "../services/whatsapp-client-manager.js";

/**
 * Builds the WhatsApp session routes with an injectable client manager.
 */
function createWhatsAppRouter({ whatsappClientManager = defaultWhatsAppClientManager } = {}) {
    const router = express.Router();

    router.get("/session", (req, res, next) => {
        try {
            return sendSuccess(res, {
                data: {
                    session: whatsappClientManager.getSessionState(),
                },
            });
        } catch (error) {
            return next(error instanceof HttpError
                ? error
                : new HttpError(500, "Could not load the WhatsApp session state.", error));
        }
    });

    return router;
}

const router = createWhatsAppRouter();

export { createWhatsAppRouter, router };
