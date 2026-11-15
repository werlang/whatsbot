import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { appConfig } from "../config/app-config.js";
import { normalizeMessageTarget } from "../helpers/message-target.js";
import { normalizeSessionId } from "../helpers/session.js";
import { ScheduledMessage } from "../model/scheduled-message.js";
import { buildCommandErrorReply, buildScheduledCommandReply, parseWhatsBotCommand } from "./whatsapp-command.js";
import { WhatsAppSessionAccessStore } from "./whatsapp-session-access-store.js";
import { WhatsAppClientManager } from "./whatsapp-client-manager.js";

/**
 * Manages multiple WhatsApp Web sessions for the API runtime.
 */
class WhatsAppSessionManager {
    /**
     * Creates the registry and shared boot queue used by all session lifecycle owners.
     */
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
        this.restorationPromise = null;
        this.clientBootPromise = Promise.resolve();
        this.destroyed = false;
        this.sessionAccessStore = sessionAccessStore;
        this.clientFactory = clientFactory || (sessionConfig => new WhatsAppClientManager(sessionConfig, {
            logger: this.logger,
            runClientBoot: operation => this.runClientBoot(operation),
            onSelfCommand: command => this.handleSelfCommand(command),
            buildSelfCommandErrorReply: error => this.buildCommandErrorReply(error),
        }));
    }

    /**
     * Serializes browser boots, including retries, so startup recovery cannot saturate the host.
     */
    runClientBoot(operation) {
        const boot = this.clientBootPromise.then(operation);
        this.clientBootPromise = boot.catch(() => {});
        return boot;
    }

    /**
     * Initializes the registry, then restores persisted profiles sequentially in the background.
     */
    async initialize() {
        await this.sessionAccessStore.initialize();
        if (!this.restorationPromise && !this.destroyed) {
            this.restorationPromise = this.restoreSessions().catch(error => {
                this.logger.error("Could not restore WhatsApp sessions:", error?.message || error);
            });
        }
        return this;
    }

    /**
     * Restores known profiles without letting one failed Chromium boot stop the others.
     */
    async restoreSessions() {
        const sessionIds = [...new Set([
            this.getDefaultSessionId(),
            ...await this.sessionAccessStore.listSessionIds(),
        ])];
        for (const sessionId of sessionIds) {
            if (this.destroyed) return;
            try {
                if (!await this.hasAuthProfile(sessionId) || this.destroyed) continue;
                await this.ensureSession(sessionId);
            } catch (error) {
                this.logger.error(`Could not restore WhatsApp session ${sessionId}:`, error?.message || error);
            }
        }
    }

    /**
     * Checks for WhatsApp IndexedDB data; an empty Chromium profile cannot restore pairing.
     * Existing storage is only a restoration candidate, not proof that credentials are valid.
     */
    async hasAuthProfile(sessionId) {
        const storagePath = path.join(this.config.authPath, `session-${normalizeSessionId(sessionId)}`,
            "Default", "IndexedDB");
        try {
            const entries = await fs.readdir(storagePath, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.isDirectory() && entry.name.startsWith("https_web.whatsapp.com_")
                    && (await fs.readdir(path.join(storagePath, entry.name))).length > 0) return true;
            }
            return false;
        } catch (error) {
            if (error?.code === "ENOENT") return false;
            throw error;
        }
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
        const access = await this.sessionAccessStore.createSessionAccess(sessionId);

        return {
            session: this.describeSession(sessionId, session),
            accessToken: access.accessToken,
            recoveryPassword: access.recoveryPassword,
        };
    }

    /**
     * Restores one existing session from its recovery password.
     */
    async loginWithRecoveryPassword(recoveryPassword) {
        const access = await this.sessionAccessStore.loginWithRecoveryPassword(recoveryPassword);
        const session = await this.getSessionState(access.sessionId);

        return {
            session,
            accessToken: access.accessToken,
        };
    }

    /**
     * Ensures one session client exists and has begun initialization.
     */
    async ensureSession(sessionId = this.getDefaultSessionId()) {
        if (this.destroyed) throw new Error("WhatsApp sessions have been stopped.");
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

        // Keep a failed client manager registered: it owns the bounded recovery timer.
        await session.initialize();
        return session;
    }

    /**
     * Returns session state, including a failed boot's retry state, and boots absent sessions on demand.
     */
    async getSessionState(sessionId = this.getDefaultSessionId()) {
        const normalizedSessionId = normalizeSessionId(sessionId);
        const initialization = this.ensureSession(normalizedSessionId);
        const session = this.sessions.get(normalizedSessionId) || await initialization;
        // State reads must expose progress while Chromium boots, including a pending retry.
        // The retained client manager records boot failures and owns subsequent recovery.
        initialization.catch(() => {});

        if (session.isReady()) {
            // Reading the contact directory is enrichment, not a prerequisite for sending: when
            // WhatsApp Web refuses getChats, every route that reports session state must keep
            // answering instead of failing with an opaque error.
            await session.refreshChatDirectory().catch(error => {
                this.logger.error(`Could not refresh the chat directory for session ${normalizedSessionId}:`, error?.message || error);
            });
        }

        return this.describeSession(normalizedSessionId, session);
    }

    /**
     * Verifies one session token before a protected session operation.
     */
    async assertAuthorizedSession(sessionId, accessToken) {
        await this.sessionAccessStore.assertSessionAccess(sessionId, accessToken, {
            allowDefaultSession: true,
            defaultSessionId: this.getDefaultSessionId(),
        });
    }

    /**
     * Validates one target eagerly when the requested session is already ready.
     */
    async assertMessageTargetReachable(sessionId, target) {
        const normalizedSessionId = normalizeSessionId(sessionId);
        const normalizedTarget = normalizeMessageTarget(target);
        const session = await this.ensureSession(normalizedSessionId);

        if (!session.isReady()) {
            return;
        }

        await session.assertTargetReachable(normalizedTarget);
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
                reconnectAttempt: 0,
                nextReconnectAt: null,
                needsQrCode: false,
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
        this.destroyed = true;
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