import fs from "node:fs/promises";
import path from "node:path";
import QRCode from "qrcode";
import WhatsAppWeb from "whatsapp-web.js";
import { appConfig } from '../config/app-config.js';
import { normalizePhoneNumber, toWhatsAppChatId } from "../helpers/phone-number.js";

const CHROMIUM_SINGLETON_ARTIFACTS = [
    "SingletonCookie",
    "SingletonLock",
    "SingletonSocket",
    "DevToolsActivePort",
];

const BRAZIL_COUNTRY_CODE = "55";

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

        this.initializingPromise = this.initializeClient()
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
     * Creates, boots, and recovers the WhatsApp client from stale Chromium locks.
     */
    async initializeClient() {
        try {
            return await this.bootClient();
        } catch (error) {
            if (!this.isChromiumProfileLockError(error)) {
                throw error;
            }

            await this.disposeClient();
            await this.clearChromiumSingletonArtifacts();
            return this.bootClient();
        }
    }

    /**
     * Creates one WhatsApp client instance and waits for its initialization.
     */
    async bootClient() {
        await this.clearChromiumSingletonArtifacts();

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

        await this.client.initialize();
        return this.client;
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

        let chatId = await this.resolveWhatsAppChatId(normalizedPhoneNumber);
        let sentMessage;

        try {
            sentMessage = await this.client.sendMessage(chatId, normalizedMessage);
        } catch (error) {
            if (!this.isMissingLidError(error)) {
                throw error;
            }

            chatId = await this.syncChatForMissingLid(chatId);
            sentMessage = await this.client.sendMessage(chatId, normalizedMessage);
        }

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
     * Resolves the best WhatsApp chat id for one phone number before sending.
     */
    async resolveWhatsAppChatId(phoneNumber) {
        const candidates = this.buildPhoneNumberCandidates(phoneNumber);

        for (const candidate of candidates) {
            const resolvedNumber = await this.client.getNumberId(candidate);

            if (resolvedNumber?._serialized) {
                return resolvedNumber._serialized;
            }
        }

        throw new Error(`WhatsApp could not resolve a registered account for ${phoneNumber}.`);
    }

    /**
     * Syncs a chat through WhatsApp Web internals when a contact is missing its LID.
     */
    async syncChatForMissingLid(chatId) {
        const page = this.client?.pupPage;

        if (!page) {
            throw new Error(`WhatsApp could not recover the chat for ${chatId}.`);
        }

        const resolvedChatId = await page.evaluate(async currentChatId => {
            const requireModule = window.require;
            const widFactory = requireModule("WAWebWidFactory");
            const findChatAction = requireModule("WAWebFindChatAction");
            const contactSyncUtils = requireModule("WAWebContactSyncUtils");

            const originalWid = widFactory.createWid(currentChatId);

            try {
                const chat = await findChatAction.findOrCreateLatestChat(originalWid);
                return chat?.chat?.id?._serialized || currentChatId;
            } catch {
                const query = contactSyncUtils.constructUsyncDeltaQuery([{
                    type: "add",
                    phoneNumber: originalWid.user,
                }]);
                const result = await query.execute();
                const lid = result?.list?.[0]?.lid;

                if (!lid) {
                    throw new Error(`WhatsApp could not sync contact ${originalWid.user}.`);
                }

                const lidWid = widFactory.createWid(lid);
                const chat = await findChatAction.findOrCreateLatestChat(lidWid);
                return chat?.chat?.id?._serialized || lidWid?._serialized || currentChatId;
            }
        }, chatId);

        if (!resolvedChatId) {
            throw new Error(`WhatsApp could not recover the chat for ${chatId}.`);
        }

        return resolvedChatId;
    }

    /**
     * Builds candidate numbers, including a Brazil mobile 9-digit fallback.
     */
    buildPhoneNumberCandidates(phoneNumber) {
        const normalizedPhoneNumber = normalizePhoneNumber(phoneNumber);
        const candidates = [normalizedPhoneNumber];

        if (normalizedPhoneNumber.startsWith(BRAZIL_COUNTRY_CODE) && normalizedPhoneNumber.length >= 12) {
            const countryCode = normalizedPhoneNumber.slice(0, 2);
            const areaCode = normalizedPhoneNumber.slice(2, 4);
            const subscriberNumber = normalizedPhoneNumber.slice(4);

            if (subscriberNumber.length === 8) {
                candidates.push(`${countryCode}${areaCode}9${subscriberNumber}`);
            }

            if (subscriberNumber.length === 9 && subscriberNumber.startsWith("9")) {
                candidates.push(`${countryCode}${areaCode}${subscriberNumber.slice(1)}`);
            }

            if (subscriberNumber.length === 10 && subscriberNumber.startsWith("99")) {
                candidates.push(`${countryCode}${areaCode}${subscriberNumber.slice(1)}`);
            }
        }

        return [...new Set(candidates)].map(toWhatsAppChatId);
    }

    /**
     * Destroys the current client instance.
     */
    async destroy() {
        if (!this.client) {
            return;
        }

        await this.disposeClient();
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
     * Removes the current client reference after attempting a clean shutdown.
     */
    async disposeClient() {
        if (!this.client) {
            return;
        }

        const activeClient = this.client;
        this.client = null;
        await activeClient.destroy?.().catch(() => {});
    }

    /**
     * Deletes only Chromium lock artifacts from the persisted LocalAuth session.
     */
    async clearChromiumSingletonArtifacts() {
        const sessionPath = path.join(this.config.authPath, `session-${this.config.clientId}`);

        await Promise.all(CHROMIUM_SINGLETON_ARTIFACTS.map(async fileName => {
            const artifactPath = path.join(sessionPath, fileName);

            try {
                await fs.rm(artifactPath, { force: true });
            } catch (error) {
                if (error?.code !== "ENOENT") {
                    throw error;
                }
            }
        }));
    }

    /**
     * Detects the Chromium profile lock error caused by stale LocalAuth artifacts.
     */
    isChromiumProfileLockError(error) {
        return String(error?.message || error || "")
            .toLowerCase()
            .includes("profile appears to be in use");
    }

    /**
     * Detects the WhatsApp Web LID-resolution error raised for unknown contacts.
     */
    isMissingLidError(error) {
        return String(error?.message || error || "")
            .toLowerCase()
            .includes("no lid for user");
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
