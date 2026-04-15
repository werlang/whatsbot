import crypto from "node:crypto";
import { appConfig } from "../config/app-config.js";
import { ScheduledMessage } from "../model/scheduled-message.js";
import { whatsappClientManager } from "../services/whatsapp-client-manager.js";

/**
 * Polls due scheduled messages and delivers them through WhatsApp.
 */
class MessageDispatcher {
    constructor({
        scheduledMessageModel = ScheduledMessage,
        whatsappClient = whatsappClientManager,
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
    }

    /**
     * Starts the recurring dispatcher loop.
     */
    start() {
        if (this.timer) {
            return this;
        }

        this.timer = setInterval(() => {
            this.tick().catch(error => {
                this.logger.error("Scheduled message dispatcher tick failed:", error);
            });
        }, this.pollIntervalMs);
        this.timer.unref?.();

        this.tick().catch(error => {
            this.logger.error("Initial scheduled message dispatcher tick failed:", error);
        });

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
     * Processes one dispatcher cycle when the WhatsApp client is ready.
     */
    async tick() {
        if (this.running || !this.whatsappClient?.isReady()) {
            return 0;
        }

        this.running = true;

        try {
            const dueMessages = await this.scheduledMessageModel.claimDue({
                now: new Date(),
                limit: this.batchSize,
                claimToken: crypto.randomUUID(),
                reclaimAfterMs: this.claimTimeoutMs,
            });

            for (const scheduledMessage of dueMessages) {
                await this.dispatchScheduledMessage(scheduledMessage);
            }

            return dueMessages.length;
        } finally {
            this.running = false;
        }
    }

    /**
     * Delivers one claimed message and persists the send outcome.
     */
    async dispatchScheduledMessage(scheduledMessage) {
        try {
            const result = await this.whatsappClient.sendMessage(scheduledMessage.phoneNumber, scheduledMessage.message);
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
