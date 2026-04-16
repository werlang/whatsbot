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
     * Reads the session bearer token from a request header.
     */
    function readSessionToken(req) {
        return req.get("x-whatsbot-session-token") || "";
    }

    router.post("/sessions", async (req, res, next) => {
        try {
            const { session, accessToken, recoveryPassword } = await whatsappClientManager.createSession();

            return sendSuccess(res, {
                status: 201,
                data: {
                    session,
                    accessToken,
                    recoveryPassword,
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
            const { session, accessToken } = await whatsappClientManager.loginWithRecoveryPassword(req.body?.recoveryPassword);

            return sendSuccess(res, {
                data: {
                    session,
                    accessToken,
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
            await whatsappClientManager.assertAuthorizedSession(sessionId, readSessionToken(req));
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
            await whatsappClientManager.assertAuthorizedSession(sessionId, readSessionToken(req));
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
