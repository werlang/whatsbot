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

    /**
     * Reads the session access password from a request header.
     */
    function readSessionPassword(req) {
        return req.get("x-whatsbot-session-password") || "";
    }

    router.post("/sessions", async (req, res, next) => {
        try {
            const { session, accessPassword } = await whatsappClientManager.createSession();

            return sendSuccess(res, {
                status: 201,
                data: {
                    session,
                    accessPassword,
                },
                message: "WhatsApp session created.",
            });
        } catch (error) {
            return next(error instanceof HttpError
                ? error
                : new HttpError(500, "Could not create the WhatsApp session.", error));
        }
    });

    router.post("/sessions/login", async (req, res, next) => {
        try {
            const { session, accessPassword } = await whatsappClientManager.loginWithPassword(req.body?.password);

            return sendSuccess(res, {
                data: {
                    session,
                    accessPassword,
                },
                message: "WhatsApp session restored.",
            });
        } catch (error) {
            return next(error instanceof HttpError
                ? error
                : new HttpError(500, "Could not restore the WhatsApp session.", error));
        }
    });

    router.get("/sessions/:sessionId", async (req, res, next) => {
        try {
            const sessionId = normalizeSessionId(req.params.sessionId, { required: true });
            await whatsappClientManager.assertAuthorizedSession(sessionId, readSessionPassword(req));
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

    router.get("/session", async (req, res, next) => {
        try {
            const sessionId = normalizeSessionId(
                req.query.sessionId,
                { fallback: whatsappClientManager.getDefaultSessionId?.() || "main" },
            );
            await whatsappClientManager.assertAuthorizedSession(sessionId, readSessionPassword(req));
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
