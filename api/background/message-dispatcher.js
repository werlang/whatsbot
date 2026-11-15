import crypto from "node:crypto";
import { appConfig } from '../config/app-config.js';
import { ScheduledMessage } from "../model/scheduled-message.js";
import { whatsappSessionManager } from "../services/whatsapp-session-manager.js";

/**
 * Polls due scheduled messages and delivers them through WhatsApp.
 */
class MessageDispatcher {
    constructor({
        scheduledMessageModel = ScheduledMessage,
        whatsappClient = whatsappSessionManager,
        pollIntervalMs = appConfig.scheduler.pollIntervalMs,
        batchSize = appConfig.scheduler.batchSize,
        claimTimeoutMs = appConfig.scheduler.claimTimeoutMs,
        logger = console,
    } = {}) {
        this.scheduledMessageModel = scheduledMessageModel;
        this.whatsappClient = whatsappClient;
        this.pollIntervalMs = pollIntervalMs;
        this.batchSize = batchSize;
        this.claimTimeoutMs = claimTimeoutMs;
        this.logger = logger;
        this.timer = null;
        this.running = false;
        this.loggedErrors = new Set();
        this.status = {
            lastTickAt: null,
            dispatchedCount: 0,
            lastError: null,
            lastErrorAt: null,
        };
    }

    /**
     * Starts the recurring dispatcher loop.
     */
    start() {
        if (this.timer) {
            return this;
        }

        this.timer = setInterval(() => {
            this.tick().catch(() => {});
        }, this.pollIntervalMs);
        this.timer.unref?.();

        this.tick().catch(() => {});

        return this;
    }

    /**
     * Stops the recurring dispatcher loop.
     */
    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }

        return this;
    }

    /**
     * Returns the latest tick outcome without exposing error stacks or mutable state.
     */
    getStatus() {
        return { ...this.status };
    }

    /**
     * Processes one cycle, recording failures and logging each distinct failure once.
     * Skipped ticks never probe the database or clear an untested database failure.
     */
    async tick() {
        if (this.running) {
            return 0;
        }

        this.running = true;
        this.status.lastTickAt = new Date().toISOString();
        this.status.dispatchedCount = 0;

        try {
            const readySessionIds = this.whatsappClient?.getReadySessionIds?.() || [];
            if (readySessionIds.length === 0) {
                return 0;
            }
            const dueMessages = await this.scheduledMessageModel.claimDue({
                now: new Date(),
                limit: this.batchSize,
                claimToken: crypto.randomUUID(),
                reclaimAfterMs: this.claimTimeoutMs,
                sessionIds: readySessionIds,
            });

            for (const scheduledMessage of dueMessages) {
                await this.dispatchScheduledMessage(scheduledMessage);
                this.status.dispatchedCount += 1;
            }

            this.status.lastError = null;
            this.status.lastErrorAt = null;
            this.loggedErrors.clear();
            return dueMessages.length;
        } catch (error) {
            const message = String(error?.message || error || "Unknown scheduler failure.");
            if (!this.loggedErrors.has(message)) {
                this.logger.error("Scheduled message dispatcher tick failed:", message);
                this.loggedErrors.add(message);
            }
            this.status.lastError = message;
            this.status.lastErrorAt = new Date().toISOString();
            throw error;
        } finally {
            this.running = false;
        }
    }

    /**
     * Delivers one claimed message and persists the send outcome.
     */
    async dispatchScheduledMessage(scheduledMessage) {
        try {
            const result = await this.whatsappClient.sendMessage(
                scheduledMessage.sessionId,
                {
                    targetType: scheduledMessage.targetType,
                    targetValue: scheduledMessage.targetValue,
                    phoneNumber: scheduledMessage.phoneNumber,
                },
                scheduledMessage.message,
            );
            await this.scheduledMessageModel.markSent(scheduledMessage.id, {
                whatsappChatId: result.chatId,
                whatsappMessageId: result.whatsappMessageId,
                sentAt: result.sentAt,
            });
        } catch (error) {
            this.logger.error(`Failed to deliver scheduled message ${scheduledMessage.id}:`, error);
            await this.scheduledMessageModel.markFailed(scheduledMessage.id, error);
        }
    }
}

const messageDispatcher = new MessageDispatcher();

export { MessageDispatcher, messageDispatcher };
