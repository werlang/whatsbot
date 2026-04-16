import crypto from "node:crypto";
import { appConfig } from "../config/app-config.js";
import { normalizeSessionId } from "../helpers/session.js";
import { ScheduledMessage } from "../model/scheduled-message.js";
import { buildCommandErrorReply, buildScheduledCommandReply, parseWhatsBotCommand } from "./whatsapp-command.js";
import { WhatsAppSessionAccessStore } from "./whatsapp-session-access-store.js";
import { WhatsAppClientManager } from "./whatsapp-client-manager.js";

/**
 * Manages multiple WhatsApp Web sessions for the API runtime.
 */
class WhatsAppSessionManager {
    constructor({
        config = appConfig.whatsapp,
        scheduledMessageModel = ScheduledMessage,
        clientFactory,
        logger = console,
        sessionAccessStore = new WhatsAppSessionAccessStore({ authPath: config.authPath, logger }),
    } = {}) {
        this.config = config;
        this.logger = logger;
        this.scheduledMessageModel = scheduledMessageModel;
        this.sessions = new Map();
        this.sessionAccessStore = sessionAccessStore;
        this.clientFactory = clientFactory || (sessionConfig => new WhatsAppClientManager(sessionConfig, {
            logger: this.logger,
            onSelfCommand: command => this.handleSelfCommand(command),
            buildSelfCommandErrorReply: error => this.buildCommandErrorReply(error),
        }));
    }

    /**
     * Initializes the default session used by the existing scheduler flow.
     */
    async initialize() {
        await this.sessionAccessStore.initialize();
        await this.ensureSession(this.getDefaultSessionId());
        return this;
    }

    /**
     * Returns the default session identifier.
     */
    getDefaultSessionId() {
        return normalizeSessionId(this.config.clientId, { fallback: "main" });
    }

    /**
     * Creates one brand-new session with its own LocalAuth profile.
     */
    async createSession() {
        const sessionId = normalizeSessionId(crypto.randomUUID());
        const session = await this.ensureSession(sessionId);
        const access = await this.sessionAccessStore.ensureSessionAccess(sessionId);

        return {
            session: this.describeSession(sessionId, session),
            accessPassword: access.accessPassword,
        };
    }

    /**
     * Restores one existing session from its access password.
     */
    async loginWithPassword(password) {
        const access = await this.sessionAccessStore.findByPassword(password);
        const session = await this.getSessionState(access.sessionId);

        return {
            session,
            accessPassword: access.accessPassword,
        };
    }

    /**
     * Ensures one session client exists and has begun initialization.
     */
    async ensureSession(sessionId = this.getDefaultSessionId()) {
        const normalizedSessionId = normalizeSessionId(sessionId);
        const existingSession = this.sessions.get(normalizedSessionId);

        if (existingSession) {
            await existingSession.initialize();
            return existingSession;
        }

        const session = this.clientFactory({
            ...this.config,
            clientId: normalizedSessionId,
        });

        this.sessions.set(normalizedSessionId, session);

        try {
            await session.initialize();
            return session;
        } catch (error) {
            this.sessions.delete(normalizedSessionId);
            throw error;
        }
    }

    /**
     * Returns the current state for one session, creating it on demand when needed.
     */
    async getSessionState(sessionId = this.getDefaultSessionId()) {
        const normalizedSessionId = normalizeSessionId(sessionId);
        const session = await this.ensureSession(normalizedSessionId);

        if (session.isReady()) {
            await session.refreshChatDirectory();
        }

        return this.describeSession(normalizedSessionId, session);
    }

    /**
     * Verifies one session password before a protected session operation.
     */
    async assertAuthorizedSession(sessionId, password) {
        await this.sessionAccessStore.assertSessionAccess(sessionId, password, {
            allowDefaultSession: true,
            defaultSessionId: this.getDefaultSessionId(),
        });
    }

    /**
     * Returns one sync snapshot when the session is already active in memory.
     */
    getKnownSessionState(sessionId = this.getDefaultSessionId()) {
        const normalizedSessionId = normalizeSessionId(sessionId);
        const session = this.sessions.get(normalizedSessionId);

        if (!session) {
            return {
                sessionId: normalizedSessionId,
                clientId: normalizedSessionId,
                status: "idle",
                ready: false,
                authenticated: false,
                hasQrCode: false,
                qrCodeDataUrl: null,
                qrCodeUpdatedAt: null,
                connectionState: null,
                loading: {
                    percent: 0,
                    message: null,
                },
                clientInfo: null,
                lastError: null,
                lastEventAt: null,
                disconnectReason: null,
            };
        }

        return this.describeSession(normalizedSessionId, session);
    }

    /**
     * Returns the identifiers of sessions that can send messages right now.
     */
    getReadySessionIds() {
        return [...this.sessions.entries()]
            .filter(([, session]) => session.isReady())
            .map(([sessionId]) => sessionId);
    }

    /**
     * Returns how many sessions are active in memory.
     */
    getActiveSessionCount() {
        return this.sessions.size;
    }

    /**
     * Sends one message through the requested WhatsApp session.
     */
    async sendMessage(sessionId, target, message) {
        const normalizedSessionId = normalizeSessionId(sessionId);
        const session = await this.ensureSession(normalizedSessionId);
        return await session.sendMessage(target, message);
    }

    /**
     * Destroys every active WhatsApp session.
     */
    async destroy() {
        const sessions = [...this.sessions.values()];
        this.sessions.clear();
        await Promise.all(sessions.map(session => session.destroy().catch(() => {})));
    }

    /**
     * Schedules one message received from a self-directed WhatsBot command.
     */
    async handleSelfCommand({ sessionId, body, source }) {
        const normalizedSessionId = normalizeSessionId(sessionId);
        const command = parseWhatsBotCommand(body);
        const scheduledMessage = await this.scheduledMessageModel.create({
            sessionId: normalizedSessionId,
            phoneNumber: command.phoneNumber,
            scheduledFor: command.scheduledFor,
            message: command.message,
        });

        return {
            scheduledMessage,
            reply: buildScheduledCommandReply(scheduledMessage),
            source,
        };
    }

    /**
     * Builds one fallback error reply for a failed self-command attempt.
     */
    buildCommandErrorReply(error) {
        return buildCommandErrorReply(error);
    }

    /**
     * Merges one session identifier into the public session snapshot.
     */
    describeSession(sessionId, session) {
        return {
            sessionId,
            ...session.getSessionState(),
        };
    }
}

const whatsappSessionManager = new WhatsAppSessionManager();

export { WhatsAppSessionManager, whatsappSessionManager };