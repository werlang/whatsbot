import QRCode from "qrcode";
import WhatsAppWeb from "whatsapp-web.js";
import { appConfig } from "../config/app-config.js";
import { normalizePhoneNumber, toWhatsAppChatId } from "../helpers/phone-number.js";

/**
 * Manages the single whatsapp-web.js client used by the API runtime.
 */
const { Client, LocalAuth } = WhatsAppWeb;

class WhatsAppClientManager {
    constructor(config = appConfig.whatsapp) {
        this.config = config;
        this.client = null;
        this.initializingPromise = null;
        this.state = {
            clientId: config.clientId,
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

    /**
     * Boots the singleton WhatsApp client when needed.
     */
    async initialize() {
        if (this.initializingPromise) {
            return this.initializingPromise;
        }

        if (this.client) {
            return this.client;
        }

        this.updateState({
            status: "initializing",
            lastError: null,
            disconnectReason: null,
        });

        this.client = new Client({
            authStrategy: new LocalAuth({
                clientId: this.config.clientId,
                dataPath: this.config.authPath,
            }),
            puppeteer: {
                headless: true,
                executablePath: this.config.executablePath,
                args: this.config.puppeteerArgs,
            },
        });
        this.registerLifecycleHandlers();

        this.initializingPromise = this.client.initialize()
            .then(() => this.client)
            .catch(error => {
                this.captureError(error, { status: "error" });
                this.client = null;
                throw error;
            })
            .finally(() => {
                this.initializingPromise = null;
            });

        return this.initializingPromise;
    }

    /**
     * Registers the WhatsApp lifecycle listeners used by the API and web UI.
     */
    registerLifecycleHandlers() {
        this.client.on("qr", async qr => {
            try {
                const qrCodeDataUrl = await QRCode.toDataURL(qr);
                this.updateState({
                    status: "qr",
                    ready: false,
                    authenticated: false,
                    hasQrCode: true,
                    qrCodeDataUrl,
                    qrCodeUpdatedAt: new Date().toISOString(),
                    disconnectReason: null,
                    lastError: null,
                });
            } catch (error) {
                this.captureError(error, { status: "error" });
            }
        });

        this.client.on("authenticated", () => {
            this.updateState({
                status: "authenticated",
                authenticated: true,
                ready: false,
                hasQrCode: false,
                qrCodeDataUrl: null,
                qrCodeUpdatedAt: null,
                lastError: null,
            });
        });

        this.client.on("ready", () => {
            this.updateState({
                status: "ready",
                ready: true,
                authenticated: true,
                hasQrCode: false,
                qrCodeDataUrl: null,
                qrCodeUpdatedAt: null,
                clientInfo: this.readClientInfo(),
                lastError: null,
            });
        });

        this.client.on("auth_failure", message => {
            this.updateState({
                status: "auth_failure",
                ready: false,
                authenticated: false,
                hasQrCode: false,
                qrCodeDataUrl: null,
                qrCodeUpdatedAt: null,
                clientInfo: null,
                lastError: {
                    message: String(message || "WhatsApp authentication failed."),
                    at: new Date().toISOString(),
                },
            });
        });

        this.client.on("disconnected", reason => {
            this.updateState({
                status: "disconnected",
                ready: false,
                authenticated: false,
                hasQrCode: false,
                qrCodeDataUrl: null,
                qrCodeUpdatedAt: null,
                clientInfo: null,
                disconnectReason: String(reason || "unknown"),
            });
        });

        this.client.on("change_state", state => {
            this.updateState({
                connectionState: state || null,
            });
        });

        this.client.on("loading_screen", (percent, message) => {
            this.updateState({
                loading: {
                    percent: Number(percent || 0),
                    message: message || null,
                },
            });
        });
    }

    /**
     * Returns the current session snapshot used by API consumers.
     */
    getSessionState() {
        return {
            ...this.state,
            loading: { ...this.state.loading },
            clientInfo: this.state.clientInfo ? { ...this.state.clientInfo } : null,
            lastError: this.state.lastError ? { ...this.state.lastError } : null,
        };
    }

    /**
     * Reports whether the managed client is currently ready to send messages.
     */
    isReady() {
        return this.state.ready === true;
    }

    /**
     * Sends one WhatsApp message through the managed client.
     */
    async sendMessage(phoneNumber, message) {
        const normalizedPhoneNumber = normalizePhoneNumber(phoneNumber);
        const normalizedMessage = String(message ?? "").trim();

        if (!normalizedMessage) {
            throw new Error("Message content is required before sending.");
        }

        if (!this.client || !this.isReady()) {
            throw new Error("WhatsApp client is not ready to send messages.");
        }

        const chatId = toWhatsAppChatId(normalizedPhoneNumber);
        const sentMessage = await this.client.sendMessage(chatId, normalizedMessage);

        return {
            chatId,
            phoneNumber: normalizedPhoneNumber,
            whatsappMessageId: sentMessage?.id?._serialized || null,
            sentAt: sentMessage?.timestamp
                ? new Date(sentMessage.timestamp * 1000).toISOString()
                : new Date().toISOString(),
        };
    }

    /**
     * Destroys the current client instance.
     */
    async destroy() {
        if (!this.client) {
            return;
        }

        await this.client.destroy();
        this.client = null;
        this.updateState({
            status: "idle",
            ready: false,
            authenticated: false,
            hasQrCode: false,
            qrCodeDataUrl: null,
            qrCodeUpdatedAt: null,
            clientInfo: null,
            disconnectReason: null,
        });
    }

    /**
     * Reads the stable public client information exposed to API consumers.
     */
    readClientInfo() {
        const info = this.client?.info;
        if (!info) {
            return null;
        }

        return {
            wid: info.wid?._serialized || null,
            phoneNumber: info.wid?.user || null,
            pushname: info.pushname || null,
            platform: info.platform || null,
        };
    }

    /**
     * Captures one internal runtime error on the public session state.
     */
    captureError(error, { status = "error" } = {}) {
        this.updateState({
            status,
            ready: false,
            clientInfo: null,
            lastError: {
                message: String(error?.message || error || "Unknown WhatsApp client error."),
                at: new Date().toISOString(),
            },
        });
    }

    /**
     * Applies a partial session-state update and refreshes the event timestamp.
     */
    updateState(patch = {}) {
        this.state = {
            ...this.state,
            ...patch,
            lastEventAt: new Date().toISOString(),
        };
    }
}

const whatsappClientManager = new WhatsAppClientManager();

export { WhatsAppClientManager, whatsappClientManager };
