import express from "express";
import { HttpError } from "../helpers/error.js";
import { sendSuccess } from "../helpers/response.js";
import { normalizeSessionId } from "../helpers/session.js";
import { whatsappSessionManager as defaultWhatsAppSessionManager } from "../services/whatsapp-session-manager.js";

/**
 * Builds the WhatsApp session routes with an injectable client manager.
 */
function createWhatsAppRouter({ whatsappClientManager = defaultWhatsAppSessionManager } = {}) {
    const router = express.Router();

    router.post("/sessions", async (req, res, next) => {
        try {
            const session = await whatsappClientManager.createSession();

            return sendSuccess(res, {
                status: 201,
                data: {
                    session,
                },
                message: "WhatsApp session created.",
            });
        } catch (error) {
            return next(error instanceof HttpError
                ? error
                : new HttpError(500, "Could not create the WhatsApp session.", error));
        }
    });

    router.get("/sessions/:sessionId", async (req, res, next) => {
        try {
            const session = await whatsappClientManager.getSessionState(normalizeSessionId(req.params.sessionId, { required: true }));

            return sendSuccess(res, {
                data: {
                    session,
                },
            });
        } catch (error) {
            return next(error instanceof HttpError
                ? error
                : new HttpError(500, "Could not load the WhatsApp session state.", error));
        }
    });

    router.get("/session", async (req, res, next) => {
        try {
            const sessionId = normalizeSessionId(
                req.query.sessionId,
                { fallback: whatsappClientManager.getDefaultSessionId?.() || "main" },
            );
            const session = await whatsappClientManager.getSessionState(sessionId);

            return sendSuccess(res, {
                data: {
                    session,
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
