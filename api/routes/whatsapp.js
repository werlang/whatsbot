import express from "express";
import { HttpError } from "../helpers/error.js";
import { normalizeMessageTarget } from "../helpers/message-target.js";
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

    router.get("/sessions/:sessionId/avatar", async (req, res, next) => {
        // Error envelopes must carry the same no-store contract as successful lookups.
        res.setHeader("Cache-Control", "private, no-store");

        try {
            const sessionId = normalizeSessionId(req.params.sessionId, { required: true });

            // Authorization is the first thing that touches session state. A rejected token must
            // never cause a directory read or a client lookup.
            await whatsappClientManager.assertAuthorizedSession(sessionId, readSessionToken(req));

            const target = normalizeMessageTarget({
                targetType: req.query.targetType,
                targetValue: req.query.targetValue,
            });

            // Readiness and membership are O(1) checks on the active session: cloning the whole
            // directory on every avatar request turned the picker into a CPU hog.
            if (!whatsappClientManager.isSessionReady?.(sessionId)) {
                throw new HttpError(503, "WhatsApp session is not ready to load profile pictures.");
            }

            if (!whatsappClientManager.hasDirectoryTarget?.(sessionId, target)) {
                throw new HttpError(404, "Target is not in the session contact directory.");
            }

            const url = await whatsappClientManager.getProfilePicUrl(sessionId, target);

            return sendSuccess(res, {
                data: {
                    avatar: {
                        targetType: target.targetType,
                        targetValue: target.targetValue,
                        url: typeof url === "string" && url.trim() ? url.trim() : null,
                    },
                },
            });
        } catch (error) {
            return next(error instanceof HttpError
                ? error
                : new HttpError(503, "Could not load the profile picture.", error));
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
