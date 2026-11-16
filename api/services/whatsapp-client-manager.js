import fs from "node:fs/promises";
import path from "node:path";
import QRCode from "qrcode";
import WhatsAppWeb from "whatsapp-web.js";
import { appConfig } from '../config/app-config.js';
import { HttpError } from "../helpers/error.js";
import { CONTACT_TARGET_TYPE, GROUP_TARGET_TYPE, normalizeMessageTarget } from "../helpers/message-target.js";
import { normalizePhoneNumber, toWhatsAppChatId } from "../helpers/phone-number.js";
import { isWhatsBotCommand } from "./whatsapp-command.js";

const CHROMIUM_SINGLETON_ARTIFACTS = [
    "SingletonCookie",
    "SingletonLock",
    "SingletonSocket",
    "DevToolsActivePort",
];

const BRAZIL_COUNTRY_CODE = "55";
const CHAT_DIRECTORY_TTL_MS = 60 * 1000;
const DIRECTORY_CONTACT_ID_PATTERN = /^(\d+)@c\.us$/i;
const DIRECTORY_GROUP_ID_PATTERN = /^(\d+(?:-\d+)?)@g\.us$/i;
const ptBrCollator = new Intl.Collator("pt-BR");

/**
 * Manages the single whatsapp-web.js client used by the API runtime.
 */
/**
 * Reports whether one directory label is really an address (bare digits, a formatted phone number
 * or a serialized chat id) instead of a name a person would recognise.
 */
function isAddressShapedLabel(value) {
    const trimmed = String(value ?? "").trim();

    if (!trimmed) {
        return true;
    }

    if (/^[\d\s()+.\-]+$/.test(trimmed)) {
        return true;
    }

    return /^\d+@[cg]\.us$/i.test(trimmed);
}

const { Client, LocalAuth } = WhatsAppWeb;

class WhatsAppClientManager {
    /**
     * Creates one session lifecycle owner with an optional shared browser-boot queue.
     */
    constructor(config = appConfig.whatsapp, {
        logger = console,
        onSelfCommand = null,
        buildSelfCommandErrorReply = null,
        runClientBoot = operation => operation(),
    } = {}) {
        this.config = config;
        this.runClientBoot = runClientBoot;
        this.logger = logger;
        this.onSelfCommand = onSelfCommand;
        this.buildSelfCommandErrorReply = buildSelfCommandErrorReply;
        this.client = null;
        this.initializingPromise = null;
        this.chatDirectoryRefreshPromise = null;
        this.chatDirectoryRetryAt = 0;
        this.chatDirectoryLoggedErrors = new Set();
        this.chatDirectoryPrimaryOutageLogged = false;
        this.reconnectTimer = null;
        this.reconnectStopped = false;
        this.destroyed = false;
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
            chatDirectory: this.createEmptyChatDirectory(),
            lastError: null,
            lastEventAt: null,
            disconnectReason: null,
            reconnectAttempt: 0,
            nextReconnectAt: null,
            needsQrCode: false,
        };
    }

    /**
     * Boots a usable client; state polls never bypass a scheduled or exhausted retry.
     */
    async initialize({ reconnect = false } = {}) {
        if (this.destroyed || this.state.needsQrCode || (!reconnect && this.reconnectStopped)) {
            return null;
        }

        if (this.initializingPromise) {
            return this.initializingPromise;
        }

        if (!reconnect && this.reconnectTimer) {
            return null;
        }

        if (this.client && !["disconnected", "error"].includes(this.state.status)) {
            return this.client;
        }

        this.updateState({
            status: "initializing",
            ready: false,
            authenticated: false,
            lastError: null,
            disconnectReason: null,
        });

        this.initializingPromise = (async () => {
            await this.disposeClient();
            if (this.destroyed || this.state.needsQrCode) return null;
            return this.runClientBoot(() => {
                if (this.destroyed || this.state.needsQrCode) return null;
                return this.initializeClient();
            });
        })()
            .catch(async error => {
                await this.disposeClient();
                if (!this.destroyed && !this.state.needsQrCode) {
                    this.captureError(error, { status: "error" });
                    this.scheduleReconnect();
                }
                throw error;
            })
            .finally(() => {
                this.initializingPromise = null;
            });

        return this.initializingPromise;
    }

    /**
     * Schedules a single rebuild, immediately first and then with bounded exponential backoff.
     */
    scheduleReconnect() {
        const maximum = Math.max(0, this.config.reconnectMaxAttempts ?? 5);
        if (this.destroyed || this.reconnectStopped || this.reconnectTimer || this.state.needsQrCode) return;
        if (this.state.reconnectAttempt >= maximum) {
            this.reconnectStopped = true;
            this.updateState({ nextReconnectAt: null });
            return;
        }

        const delay = this.state.reconnectAttempt === 0 ? 0 : Math.min(
            this.config.reconnectMaxDelayMs ?? 30000,
            (this.config.reconnectDelayMs ?? 1000) * (2 ** (this.state.reconnectAttempt - 1)),
        );
        this.updateState({ nextReconnectAt: new Date(Date.now() + delay).toISOString() });
        const timer = setTimeout(async () => {
            // A ready event may cancel recovery while an earlier boot is still unwinding.
            await this.initializingPromise?.catch(() => {});
            if (this.reconnectTimer !== timer) return;
            this.reconnectTimer = null;
            if (this.destroyed || this.reconnectStopped || this.state.needsQrCode) return;
            this.updateState({ reconnectAttempt: this.state.reconnectAttempt + 1, nextReconnectAt: null });
            await this.initialize({ reconnect: true }).catch(() => {});
        }, delay);
        this.reconnectTimer = timer;
        timer.unref?.();
    }

    /**
     * Cancels pending recovery before logout, shutdown, or a successful connection.
     */
    cancelReconnect() {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
        this.updateState({ nextReconnectAt: null });
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
                // Injecting the WhatsApp Web bundle into a slow ARM browser can exceed
                // puppeteer's 180 s default, which used to abort the whole client boot.
                protocolTimeout: this.config.protocolTimeout,
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
        const activeClient = this.client;
        const on = (event, handler) => activeClient.on(event, (...args) => {
            if (this.client === activeClient && !this.destroyed) handler(...args);
        });
        on("qr", async qr => {
            try {
                const qrCodeDataUrl = await QRCode.toDataURL(qr);
                if (this.client !== activeClient || this.destroyed) return;
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
                if (this.client === activeClient && !this.destroyed) this.captureError(error, { status: "error" });
            }
        });

        on("authenticated", () => {
            this.updateState({
                status: "authenticated",
                authenticated: true,
                ready: false,
                hasQrCode: false,
                qrCodeDataUrl: null,
                qrCodeUpdatedAt: null,
                chatDirectory: this.createEmptyChatDirectory(),
                lastError: null,
            });
        });

        on("ready", () => {
            this.cancelReconnect();
            this.reconnectStopped = false;
            this.chatDirectoryRetryAt = 0;
            this.updateState({
                status: "ready",
                reconnectAttempt: 0,
                needsQrCode: false,
                ready: true,
                authenticated: true,
                hasQrCode: false,
                qrCodeDataUrl: null,
                qrCodeUpdatedAt: null,
                clientInfo: this.readClientInfo(),
                chatDirectory: this.createEmptyChatDirectory(),
                lastError: null,
            });

            this.refreshChatDirectory({ force: true }).catch(error => {
                this.logger.error(`Failed to refresh WhatsApp chat directory for session ${this.config.clientId}:`, error);
            });
        });

        on("auth_failure", message => {
            this.cancelReconnect();
            this.reconnectStopped = true;
            this.updateState({
                status: "auth_failure",
                needsQrCode: true,
                ready: false,
                authenticated: false,
                hasQrCode: false,
                qrCodeDataUrl: null,
                qrCodeUpdatedAt: null,
                clientInfo: null,
                chatDirectory: this.createEmptyChatDirectory(),
                lastError: {
                    message: String(message || "WhatsApp authentication failed."),
                    at: new Date().toISOString(),
                },
            });
            this.disposeClient().catch(() => {});
        });

        on("disconnected", reason => {
            const loggedOut = ["LOGOUT", "UNPAIRED", "UNPAIRED_IDLE"]
                .includes(String(reason || "").toUpperCase());
            this.updateState({
                status: "disconnected",
                ready: false,
                authenticated: false,
                hasQrCode: false,
                qrCodeDataUrl: null,
                qrCodeUpdatedAt: null,
                clientInfo: null,
                chatDirectory: this.createEmptyChatDirectory(),
                disconnectReason: String(reason || "unknown"),
                needsQrCode: loggedOut,
            });
            if (loggedOut) {
                this.cancelReconnect();
                this.reconnectStopped = true;
                this.disposeClient().catch(() => {});
                return;
            }
            this.scheduleReconnect();
        });

        on("change_state", state => {
            this.updateState({
                connectionState: state || null,
            });
        });

        on("loading_screen", (percent, message) => {
            this.updateState({
                loading: {
                    percent: Number(percent || 0),
                    message: message || null,
                },
            });
        });

        on("message_create", message => {
            this.handleCreatedMessage(message).catch(error => {
                this.logger.error(`Failed to process message command for session ${this.config.clientId}:`, error);
            });
        });
    }

    /**
     * Handles one created WhatsApp message and schedules commands sent to self.
     */
    async handleCreatedMessage(message) {
        if (!message?.fromMe || !isWhatsBotCommand(message.body) || !this.onSelfCommand) {
            return null;
        }

        if (!await this.isSelfChatMessage(message)) {
            return null;
        }

        try {
            const result = await this.onSelfCommand({
                sessionId: this.config.clientId,
                body: String(message.body || ""),
                source: {
                    whatsappMessageId: message.id?._serialized || null,
                    chatId: message.to || message.from || message.id?.remote || null,
                },
            });

            if (result?.reply && typeof message.reply === "function") {
                await message.reply(result.reply);
            }

            return result;
        } catch (error) {
            if (typeof message.reply === "function") {
                await message.reply(this.readCommandErrorReply(error)).catch(() => {});
            }

            throw error;
        }
    }

    /**
     * Returns true when a created message belongs to the user's self chat.
     */
    async isSelfChatMessage(message) {
        const ownWid = this.readClientInfo()?.wid;

        if (!ownWid) {
            return false;
        }

        const chatId = typeof message._getChatId === "function"
            ? message._getChatId()
            : null;

        if (
            message.to === ownWid
            || message.from === ownWid
            || message.id?.remote === ownWid
            || chatId === ownWid
        ) {
            return true;
        }

        const chat = await message.getChat?.().catch?.(() => null);
        return chat?.id?._serialized === ownWid;
    }

    /**
     * Builds one safe error reply for a failed command parse or schedule.
     */
    readCommandErrorReply(error) {
        if (typeof this.buildSelfCommandErrorReply === "function") {
            return this.buildSelfCommandErrorReply(error);
        }

        return String(error?.message || error || "Could not schedule the command.");
    }

    /**
     * Returns the current session snapshot used by API consumers.
     */
    getSessionState() {
        return {
            ...this.state,
            loading: { ...this.state.loading },
            clientInfo: this.state.clientInfo ? { ...this.state.clientInfo } : null,
            chatDirectory: this.cloneChatDirectory(this.state.chatDirectory),
            lastError: this.state.lastError ? { ...this.state.lastError } : null,
        };
    }

    /**
     * Refreshes enrichment data when ready, retaining the cache and backing off on failure.
     */
    async refreshChatDirectory({ force = false } = {}) {
        if (!this.client || !this.isReady()) {
            return this.cloneChatDirectory(this.state.chatDirectory);
        }

        if (Date.now() < this.chatDirectoryRetryAt || (!force && !this.shouldRefreshChatDirectory(this.state.chatDirectory))) {
            return this.cloneChatDirectory(this.state.chatDirectory);
        }

        // A refresh belongs to the client that started it. Same client: share it. Replacement:
        // start its own read and take over the slot, so a stale operation that may never settle
        // (a disposed browser keeps it pending) cannot stall the new one.
        if (this.chatDirectoryRefreshPromise && this.chatDirectoryRefreshClient === this.client) {
            return await this.chatDirectoryRefreshPromise;
        }

        const activeClient = this.client;
        this.chatDirectoryRefreshClient = activeClient;
        let usedFallback = false;
        this.chatDirectoryRefreshPromise = this.readChatDirectory({
            onSourceSelected: result => {
                usedFallback = Boolean(result?.usedFallback);
            },
        })
            .then(chatDirectory => {
                if (this.client !== activeClient || !this.isReady()) return this.cloneChatDirectory(this.state.chatDirectory);
                if (usedFallback) {
                    if (!this.chatDirectoryPrimaryOutageLogged) {
                        this.logger.warn?.(`WhatsApp chat directory primary source unavailable for session ${this.config.clientId}; using contacts.`);
                        this.chatDirectoryPrimaryOutageLogged = true;
                    }
                } else {
                    this.chatDirectoryPrimaryOutageLogged = false;
                }
                this.chatDirectoryRetryAt = 0;
                this.chatDirectoryLoggedErrors.clear();
                this.updateState({ chatDirectory });
                return this.cloneChatDirectory(chatDirectory);
            })
            .catch(error => {
                if (this.client === activeClient) {
                    this.chatDirectoryRetryAt = Date.now() + (this.config.chatDirectoryRetryMs ?? 30000);
                    const message = String(error?.message || error);
                    if (!this.chatDirectoryLoggedErrors.has(message)) {
                        this.logger.error(`Could not refresh the chat directory for session ${this.config.clientId}:`, message);
                        this.chatDirectoryLoggedErrors.add(message);
                    }
                }
                return this.cloneChatDirectory(this.state.chatDirectory);
            })
            .finally(() => {
                // Only the owner clears the shared slot; a newer refresh must not be detached by
                // this operation finishing late.
                if (this.chatDirectoryRefreshClient === activeClient) {
                    this.chatDirectoryRefreshPromise = null;
                    this.chatDirectoryRefreshClient = null;
                }
            });

        return await this.chatDirectoryRefreshPromise;
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
    async sendMessage(target, message) {
        const normalizedTarget = normalizeMessageTarget(
            typeof target === "string"
                ? { phoneNumber: target }
                : target,
        );
        const normalizedMessage = String(message ?? "").trim();

        if (!normalizedMessage) {
            throw new Error("Message content is required before sending.");
        }

        if (!this.client || !this.isReady()) {
            throw new Error("WhatsApp client is not ready to send messages.");
        }

        let chatId = normalizedTarget.targetType === GROUP_TARGET_TYPE
            ? normalizedTarget.targetValue
            : await this.resolveWhatsAppChatId(normalizedTarget.phoneNumber);
        let sentMessage;

        try {
            sentMessage = await this.client.sendMessage(chatId, normalizedMessage);
        } catch (error) {
            if (normalizedTarget.targetType !== CONTACT_TARGET_TYPE || !this.isMissingLidError(error)) {
                throw error;
            }

            chatId = await this.syncChatForMissingLid(chatId);
            sentMessage = await this.client.sendMessage(chatId, normalizedMessage);
        }

        const whatsappMessageId = this.readMessageId(sentMessage);
        if (!whatsappMessageId) {
            this.logger.warn(`WhatsApp send for session ${this.config.clientId} returned no message id.`);
        }

        return {
            chatId,
            phoneNumber: normalizedTarget.phoneNumber,
            targetType: normalizedTarget.targetType,
            targetValue: normalizedTarget.targetValue,
            whatsappMessageId,
            sentAt: sentMessage?.timestamp
                ? new Date(sentMessage.timestamp * 1000).toISOString()
                : new Date().toISOString(),
        };
    }

    /**
     * Preserves identifiers supplied by WhatsApp, including raw model and component ids.
     * An acknowledgement may arrive later; no unrelated event is guessed to belong to a send.
     */
    readMessageId(message) {
        const candidates = [message?.id, message?._data?.id];
        for (const id of candidates) {
            if (typeof id?._serialized === "string" && id._serialized) return id._serialized;
        }
        for (const id of candidates) {
            if (typeof id === "string" && id) return id;
            if (typeof id?.id === "string" && id.id) return id.id;
        }
        return null;
    }

    /**
     * Verifies that one target can be resolved immediately by the ready client.
     */
    async assertTargetReachable(target) {
        const normalizedTarget = normalizeMessageTarget(
            typeof target === "string"
                ? { phoneNumber: target }
                : target,
        );

        if (!this.client || !this.isReady() || normalizedTarget.targetType !== CONTACT_TARGET_TYPE) {
            return;
        }

        try {
            await this.resolveWhatsAppChatId(normalizedTarget.phoneNumber);
        } catch (error) {
            throw new HttpError(400, error.message);
        }
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
     * Returns true when the cached chat directory should be refreshed.
     */
    shouldRefreshChatDirectory(chatDirectory = this.state.chatDirectory) {
        const refreshedAt = Date.parse(chatDirectory?.refreshedAt || "");

        if (!Number.isFinite(refreshedAt)) {
            return true;
        }

        return (Date.now() - refreshedAt) >= CHAT_DIRECTORY_TTL_MS;
    }

    /**
     * Reads raw directory entries from chats, falling back to contacts only when getChats() throws.
     *
     * @returns {Promise<{ entries: Array<object>, usedFallback: boolean }>} Directory source entries and origin flag.
     */
    async readDirectorySource() {
        // Acquisition is bound to the client captured before the first await: a browser replaced
        // mid-read must never receive the fallback call, and its own refresh must not inherit this
        // operation's outcome.
        const client = this.client;

        try {
            const entries = await client.getChats();
            return {
                entries: Array.isArray(entries) ? entries : [],
                usedFallback: false,
            };
        } catch (primaryError) {
            if (typeof client?.getContacts !== "function" || this.client !== client) {
                throw primaryError;
            }

            const entries = await client.getContacts();
            return {
                entries: Array.isArray(entries) ? entries : [],
                usedFallback: true,
            };
        }
    }

    /**
     * Builds the latest cached contact and group directory from WhatsApp chats or contacts.
     *
     * @param {{ onSourceSelected?: (meta: { usedFallback: boolean }) => void }} [options] Optional acquisition hook.
     * @returns {Promise<{ contacts: Array<object>, groups: Array<object>, refreshedAt: string }>} Directory snapshot.
     */
    async readChatDirectory({ onSourceSelected } = {}) {
        const { entries, usedFallback } = await this.readDirectorySource();
        onSourceSelected?.({ usedFallback });
        const { contacts, groups } = this.normalizeDirectoryEntries(entries);

        return {
            contacts,
            groups,
            refreshedAt: new Date().toISOString(),
        };
    }

    /**
     * Normalizes, deduplicates, filters, and sorts raw chat or contact models into directory entries.
     *
     * @param {Array<object>} entries Raw WhatsApp chat or contact models.
     * @returns {{ contacts: Array<object>, groups: Array<object> }} Sorted contact and group directory lists.
     */
    normalizeDirectoryEntries(entries) {
        const entriesById = new Map();

        for (const entry of Array.isArray(entries) ? entries : []) {
            const target = this.parseDirectoryTarget(entry);
            if (!target) {
                continue;
            }

            const name = this.readDirectoryName(entry, {
                allowAddressLabel: target.targetType === GROUP_TARGET_TYPE,
            });
            const existing = entriesById.get(target.id);

            if (!existing || (!existing.name && name)) {
                entriesById.set(target.id, { ...target, name });
            }
        }

        const contacts = [];
        const groups = [];

        for (const entry of entriesById.values()) {
            if (entry.targetType === GROUP_TARGET_TYPE) {
                const displayName = entry.name || entry.id;
                groups.push({
                    id: entry.id,
                    name: displayName,
                    targetType: GROUP_TARGET_TYPE,
                    targetValue: entry.id,
                    phoneNumber: null,
                    chatId: entry.id,
                    label: displayName,
                });
                continue;
            }

            if (!entry.name) {
                continue;
            }

            contacts.push({
                id: entry.id,
                name: entry.name,
                targetType: CONTACT_TARGET_TYPE,
                targetValue: entry.targetValue,
                phoneNumber: entry.phoneNumber,
                chatId: entry.id,
                label: entry.name,
            });
        }

        const compareEntries = (left, right) => (
            ptBrCollator.compare(left.name, right.name)
            || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
        );

        contacts.sort(compareEntries);
        groups.sort(compareEntries);

        return { contacts, groups };
    }

    /**
     * Extracts canonical target identity fields for a valid @c.us or @g.us model, ignoring LIDs and unsupported ids.
     *
     * @param {object} entry Raw WhatsApp chat or contact model.
     * @returns {{ id: string, targetType: string, targetValue: string, phoneNumber: string|null }|null} Target fields or null.
     */
    parseDirectoryTarget(entry) {
        const serializedId = typeof entry?.id?._serialized === "string"
            ? entry.id._serialized.trim()
            : "";

        if (!serializedId || entry?.id?.server === "lid" || /@lid$/i.test(serializedId) || /@broadcast$/i.test(serializedId)) {
            return null;
        }

        const groupMatch = serializedId.match(DIRECTORY_GROUP_ID_PATTERN);
        if (groupMatch) {
            const groupId = `${groupMatch[1]}@g.us`;
            return {
                id: groupId,
                targetType: GROUP_TARGET_TYPE,
                targetValue: groupId,
                phoneNumber: null,
            };
        }

        const contactMatch = serializedId.match(DIRECTORY_CONTACT_ID_PATTERN);
        if (contactMatch && contactMatch[1].length >= 10 && contactMatch[1].length <= 15) {
            const digits = contactMatch[1];
            return {
                id: `${digits}@c.us`,
                targetType: CONTACT_TARGET_TYPE,
                targetValue: digits,
                phoneNumber: digits,
            };
        }

        return null;
    }

    /**
     * Reads the first non-empty real display name from chat or contact model fields without falling back to phone digits.
     *
     * @param {object} entry Raw WhatsApp chat or contact model.
     * @returns {string|null} Trimmed display name or null when unnamed.
     */
    readDirectoryName(entry, { allowAddressLabel = false } = {}) {
        const candidates = [
            entry?.name,
            entry?.formattedTitle,
            entry?.contact?.name,
            entry?.contact?.pushname,
            entry?.contact?.shortName,
            entry?.contact?.verifiedName,
            entry?.pushname,
            entry?.shortName,
            entry?.verifiedName,
        ];

        // WhatsApp fills formattedTitle with the number when the contact has no saved name; an
        // address is not a name. Skip such labels and keep looking for a real name further down
        // the list instead of discarding the entry wholesale.
        for (const value of candidates) {
            if (typeof value !== "string") {
                continue;
            }

            const trimmed = value.trim();
            if (!trimmed) {
                continue;
            }

            // A group is addressed by its @g.us id, so a numeric title ("2026") is a real name.
            if (!allowAddressLabel && isAddressShapedLabel(trimmed)) {
                continue;
            }

            return trimmed;
        }

        return null;
    }

    /**
     * Builds an empty directory snapshot for sessions without synced chats yet.
     */
    createEmptyChatDirectory() {
        return {
            contacts: [],
            groups: [],
            refreshedAt: null,
        };
    }

    /**
     * Clones one directory snapshot so callers cannot mutate internal state.
     */
    cloneChatDirectory(chatDirectory = this.createEmptyChatDirectory()) {
        return {
            contacts: (chatDirectory?.contacts || []).map(entry => ({ ...entry })),
            groups: (chatDirectory?.groups || []).map(entry => ({ ...entry })),
            refreshedAt: chatDirectory?.refreshedAt || null,
        };
    }

    /**
     * Stops recovery and closes the client, including any boot still in flight.
     */
    async destroy() {
        this.destroyed = true;
        this.reconnectStopped = true;
        this.cancelReconnect();
        await this.initializingPromise?.catch(() => {});
        await this.disposeClient();
        this.updateState({
            status: "idle",
            ready: false,
            authenticated: false,
            hasQrCode: false,
            qrCodeDataUrl: null,
            qrCodeUpdatedAt: null,
            clientInfo: null,
            chatDirectory: this.createEmptyChatDirectory(),
            disconnectReason: null,
        });
    }

    /**
     * Removes the current client reference after attempting a clean shutdown.
     */
    async disposeClient() {
        this.chatDirectoryPrimaryOutageLogged = false;
        if (!this.client) {
            return;
        }

        const activeClient = this.client;
        this.client = null;
        activeClient.removeAllListeners?.();
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
            chatDirectory: this.createEmptyChatDirectory(),
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
