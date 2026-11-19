import fs from "node:fs/promises";
import path from "node:path";
import { DisconnectReason, makeWASocket, useMultiFileAuthState } from "baileys";
import pino from "pino";
import QRCode from "qrcode";
import { appConfig } from "../config/app-config.js";
import { HttpError } from "../helpers/error.js";
import { CONTACT_TARGET_TYPE, GROUP_TARGET_TYPE, normalizeMessageTarget } from "../helpers/message-target.js";
import { normalizePhoneNumber } from "../helpers/phone-number.js";
import { isWhatsBotCommand } from "./whatsapp-command.js";

const BRAZIL_COUNTRY_CODE = "55";
const CONTACT_SERVER = "s.whatsapp.net";
const CONTACT_CHAT_SERVER = "c.us";
const GROUP_ID_PATTERN = /^(\d+(?:-\d+)?)@g\.us$/i;
const CONTACT_ID_PATTERN = /^(\d{10,15})@(?:s\.whatsapp\.net|c\.us)$/i;
const PROCESSED_MESSAGE_TYPES = new Set(["notify", "append"]);
const BAILEYS_LOG_LEVEL = "warn";
const BAILEYS_AUTH_DIRECTORY = "baileys";
const DIRECTORY_FILE_NAME = "chat-directory.json";
const GROUP_DIRECTORY_TTL_MS = 10 * 60 * 1000;
const DIRECTORY_PERSIST_DELAY_MS = 1000;
const AVATAR_CACHE_HIT_TTL_MS = 15 * 60 * 1000;
const AVATAR_CACHE_MISS_TTL_MS = 2 * 60 * 1000;
const AVATAR_MAX_IN_FLIGHT = 4;
const AVATAR_MAX_QUEUED = 32;
const AVATAR_LOOKUP_TIMEOUT_MS = 5000;
const ptBrCollator = new Intl.Collator("pt-BR");

/**
 * Folds one directory label for prefix comparison, ignoring case and diacritics.
 */
function foldDirectoryLabel(value) {
    return String(value ?? "").normalize("NFD").replace(/\p{Mn}/gu, "").toLowerCase();
}

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

/**
 * Splits one WhatsApp jid into lowercase user and server parts, dropping the device suffix.
 *
 * @param {string} value Raw jid such as `5551999999999:12@s.whatsapp.net`.
 * @returns {{ user: string, server: string }} Normalized parts.
 */
function splitJid(value) {
    const raw = String(value ?? "").trim().toLowerCase();

    if (!raw) {
        return { user: "", server: "" };
    }

    const at = raw.indexOf("@");
    const user = (at >= 0 ? raw.slice(0, at) : raw).split(":")[0];
    const server = at >= 0 ? raw.slice(at + 1) : "";

    return { user, server };
}

/**
 * Rebuilds one jid without its device suffix.
 *
 * @param {string} value Raw jid.
 * @returns {string} Normalized jid, or an empty string when the input has no server.
 */
function normalizeJid(value) {
    const { user, server } = splitJid(value);

    return user && server ? `${user}@${server}` : "";
}

/**
 * Reads the phone-number digits carried by a possible jid or bare number.
 *
 * @param {...string} values Candidate identifiers, most authoritative first.
 * @returns {string|null} 10-to-15-digit phone number or null.
 */
function readContactDigits(...values) {
    for (const value of values) {
        const { user, server } = splitJid(value);

        if (!/^\d{10,15}$/.test(user)) {
            continue;
        }

        if (!server || server === CONTACT_SERVER || server === CONTACT_CHAT_SERVER) {
            return user;
        }
    }

    return null;
}

/**
 * Converts one addressable jid into the public chat-id shape used by the API.
 *
 * @param {string} jid Baileys jid.
 * @returns {string} `@c.us` for contacts, unchanged server for groups and LIDs.
 */
function toPublicChatId(jid) {
    const { user, server } = splitJid(jid);

    if (!user) {
        return "";
    }

    if (server === CONTACT_SERVER || server === CONTACT_CHAT_SERVER) {
        return `${user}@${CONTACT_CHAT_SERVER}`;
    }

    return server ? `${user}@${server}` : user;
}

/**
 * Reads the numeric WhatsApp disconnect status from a Baileys close event.
 *
 * @param {object} lastDisconnect Baileys `lastDisconnect` payload.
 * @returns {number|null} Status code or null.
 */
function readDisconnectStatusCode(lastDisconnect) {
    const error = lastDisconnect?.error;
    const statusCode = Number(
        error?.output?.statusCode
        ?? error?.statusCode
        ?? error?.data?.statusCode
        ?? lastDisconnect?.statusCode,
    );

    return Number.isFinite(statusCode) ? statusCode : null;
}

/**
 * Maps one numeric disconnect status back to its readable Baileys name.
 *
 * @param {number|null} statusCode Disconnect status code.
 * @returns {string} Readable reason such as `loggedOut` or `connectionClosed`.
 */
function readDisconnectReasonName(statusCode) {
    if (!Number.isFinite(statusCode)) {
        return "unknown";
    }

    for (const [name, value] of Object.entries(DisconnectReason)) {
        if (!/^\d+$/.test(name) && value === statusCode) {
            return name;
        }
    }

    return String(statusCode);
}

/**
 * Creates one Baileys socket with a pino logger at warn level and no browser.
 *
 * @param {object} auth Multi-file authentication state.
 * @returns {object} Baileys socket.
 */
function createDefaultSocket(auth) {
    return makeWASocket({
        auth,
        logger: pino({ level: BAILEYS_LOG_LEVEL }),
        printQRInTerminal: false,
        markOnlineOnConnect: false,
        syncFullHistory: false,
        generateHighQualityLinkPreview: false,
        getMessage: async () => undefined,
    });
}

/**
 * Manages one Baileys socket: lifecycle, sending, self commands and the contact directory.
 */
class WhatsAppClientManager {
    /**
     * Creates one session lifecycle owner with an optional shared boot queue.
     *
     * @param {object} config Session configuration.
     * @param {object} [options] Injectable dependencies.
     * @param {object} [options.logger] Internal logger.
     * @param {Function|null} [options.onSelfCommand] Self-command handler.
     * @param {Function|null} [options.buildSelfCommandErrorReply] Error reply builder.
     * @param {Function} [options.runClientBoot] Serializes boots across sessions.
     * @param {Function|null} [options.createSocket] Socket factory (DI seam for tests).
     * @param {Function} [options.createAuthState] Auth-state factory (DI seam for tests).
     */
    constructor(config = appConfig.whatsapp, {
        logger = console,
        onSelfCommand = null,
        buildSelfCommandErrorReply = null,
        runClientBoot = operation => operation(),
        createSocket = createDefaultSocket,
        createAuthState = useMultiFileAuthState,
    } = {}) {
        this.config = config;
        this.runClientBoot = runClientBoot;
        this.logger = logger;
        this.onSelfCommand = onSelfCommand;
        this.buildSelfCommandErrorReply = buildSelfCommandErrorReply;
        this.createSocket = createSocket;
        this.createAuthState = createAuthState;
        this.client = null;
        this.saveCreds = null;
        this.initializingPromise = null;
        this.groupDirectoryRefreshPromise = null;
        this.groupDirectoryRefreshClient = null;
        this.lastGroupDirectoryFetchAt = 0;
        this.chatDirectoryRetryAt = 0;
        this.chatDirectoryLoggedErrors = new Set();
        this.directoryRestorePromise = null;
        this.directoryPersistPromise = null;
        this.directoryPersistTimer = null;
        this.directoryRecords = new Map();
        this.directoryTargetIndex = new Set();
        this.ownJids = new Set();
        this.processedMessageIds = new Set();
        this.qrGeneration = 0;
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
        this.avatarCache = new Map();
        this.avatarInFlight = new Map();
        this.avatarActiveCount = 0;
        this.avatarWaiters = [];
        this.avatarGeneration = 0;
    }

    /**
     * Boots a usable socket; state polls never bypass a scheduled or exhausted retry.
     *
     * @param {{ reconnect?: boolean }} [options] Recovery flag.
     * @returns {Promise<object|null>} Socket or null when booting is skipped.
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
            needsQrCode: false,
            connectionState: "CONNECTING",
        });

        this.initializingPromise = (async () => {
            await this.restoreChatDirectory();
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
     * Schedules a single rebuild: immediate first, bounded exponential backoff while the fast
     * budget lasts, then a slow fixed interval that never gives up until logout or shutdown.
     */
    scheduleReconnect() {
        const maximum = Math.max(0, this.config.reconnectMaxAttempts ?? 5);
        if (this.destroyed || this.reconnectStopped || this.reconnectTimer || this.state.needsQrCode) return;

        // The budget is consumed by failed attempts, never by a socket that already proved it can
        // connect (a QR emission or an open event resets reconnectAttempt to 0). Once the fast
        // attempts are exhausted, a paired account keeps coming back instead of dying forever.
        const delay = this.state.reconnectAttempt >= maximum
            ? Math.max(1, this.config.reconnectSlowRetryMs ?? 300000)
            : this.state.reconnectAttempt === 0 ? 0 : Math.min(
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
     * Creates one Baileys socket from the persisted multi-file auth state.
     *
     * @returns {Promise<object>} Connected socket handle (connection events are asynchronous).
     */
    async initializeClient() {
        return await this.bootClient();
    }

    /**
     * Reads the multi-file auth state and creates the socket.
     *
     * @returns {Promise<object>} Baileys socket.
     */
    async bootClient() {
        const authDirectory = this.getAuthDirectory();
        const { state, saveCreds } = await this.createAuthState(authDirectory);
        this.saveCreds = saveCreds;

        const socket = await this.createSocket(state);
        this.client = socket;
        this.registerLifecycleHandlers();
        return socket;
    }

    /**
     * Returns the per-session auth directory used by Baileys.
     *
     * @returns {string} Absolute auth directory.
     */
    getAuthDirectory() {
        return path.join(this.config.authPath, BAILEYS_AUTH_DIRECTORY, this.config.clientId);
    }

    /**
     * Registers the Baileys lifecycle listeners used by the API and web UI.
     */
    registerLifecycleHandlers() {
        const activeClient = this.client;
        const emitter = activeClient?.ev;

        if (!emitter || typeof emitter.on !== "function") {
            return;
        }

        const on = (event, handler) => emitter.on(event, arg => {
            if (this.client !== activeClient || this.destroyed) return;

            try {
                Promise.resolve(handler(arg)).catch(error => {
                    this.logger.error(`WhatsApp event "${event}" failed for session ${this.config.clientId}:`, error?.message || error);
                });
            } catch (error) {
                this.logger.error(`WhatsApp event "${event}" failed for session ${this.config.clientId}:`, error?.message || error);
            }
        });

        // Credentials must be persisted even while a replacement is settling: losing them means a
        // new QR for the user.
        emitter.on("creds.update", () => {
            Promise.resolve(this.saveCreds?.()).catch(error => {
                this.logger.error(`Could not persist WhatsApp credentials for session ${this.config.clientId}:`, error?.message || error);
            });

            if (this.client === activeClient && this.isReady()) {
                this.ownJids = this.readOwnJids();
                this.updateState({ clientInfo: this.readClientInfo() });
            }
        });

        on("connection.update", update => this.handleConnectionUpdate(update));
        on("messages.upsert", payload => this.handleMessagesUpsert(payload));
        on("messaging-history.set", payload => this.ingestHistorySet(payload));
        on("contacts.upsert", contacts => this.mergeContactRecords(contacts));
        on("contacts.update", contacts => this.mergeContactRecords(contacts));
        on("chats.upsert", chats => this.mergeChatRecords(chats));
        on("chats.update", chats => this.mergeChatRecords(chats));
        on("groups.upsert", groups => this.mergeGroupRecords(groups));
        on("groups.update", groups => this.mergeGroupRecords(groups));
    }

    /**
     * Applies one Baileys connection update to the public session state.
     *
     * @param {object} update Baileys connection update payload.
     */
    async handleConnectionUpdate(update = {}) {
        const { connection, lastDisconnect, qr } = update;
        const activeClient = this.client;

        if (qr) {
            const generation = this.qrGeneration + 1;
            this.qrGeneration = generation;
            const qrCodeDataUrl = await QRCode.toDataURL(qr);

            if (generation !== this.qrGeneration || this.destroyed || this.client !== activeClient) {
                return;
            }

            this.updateState({
                status: "qr",
                ready: false,
                authenticated: false,
                hasQrCode: true,
                qrCodeDataUrl,
                qrCodeUpdatedAt: new Date().toISOString(),
                connectionState: "QR",
                disconnectReason: null,
                lastError: null,
                needsQrCode: false,
                // The socket reached the QR phase, so the connection itself is healthy. A close
                // after an unscanned QR timeout must not consume the retry budget, otherwise the
                // session dies after a few QR rotations (the old browser client refreshed forever).
                reconnectAttempt: 0,
                loading: { percent: 0, message: null },
            });
        }

        if (connection === "connecting") {
            this.updateState({ connectionState: "CONNECTING" });
            return;
        }

        if (connection === "open") {
            this.qrGeneration += 1;
            this.cancelReconnect();
            this.reconnectStopped = false;
            this.chatDirectoryRetryAt = 0;
            this.lastGroupDirectoryFetchAt = 0;
            this.ownJids = this.readOwnJids();
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
                lastError: null,
                disconnectReason: null,
                connectionState: "CONNECTED",
                loading: { percent: 100, message: null },
            });

            this.refreshChatDirectory({ force: true }).catch(error => {
                this.logger.error(`Failed to refresh WhatsApp chat directory for session ${this.config.clientId}:`, error);
            });
            return;
        }

        if (connection !== "close") {
            return;
        }

        const statusCode = readDisconnectStatusCode(lastDisconnect);
        const reason = readDisconnectReasonName(statusCode);
        const loggedOut = statusCode === DisconnectReason.loggedOut;

        this.qrGeneration += 1;
        this.updateState({
            status: "disconnected",
            ready: false,
            authenticated: false,
            hasQrCode: false,
            qrCodeDataUrl: null,
            qrCodeUpdatedAt: null,
            clientInfo: null,
            disconnectReason: reason,
            needsQrCode: loggedOut,
            connectionState: "DISCONNECTED",
            loading: { percent: 0, message: null },
        });
        this.ownJids = new Set();

        if (loggedOut) {
            this.cancelReconnect();
            this.reconnectStopped = true;
            this.disposeClient().catch(() => {});
            return;
        }

        this.scheduleReconnect();
    }

    /**
     * Handles one Baileys messages.upsert payload and schedules commands sent to self.
     *
     * @param {{ messages?: Array<object>, type?: string }} payload Upsert payload.
     */
    async handleMessagesUpsert(payload = {}) {
        if (!PROCESSED_MESSAGE_TYPES.has(String(payload?.type || ""))) {
            return;
        }

        for (const message of Array.isArray(payload.messages) ? payload.messages : []) {
            await this.handleIncomingMessage(message).catch(error => {
                this.logger.error(`Failed to process message command for session ${this.config.clientId}:`, error);
            });
        }
    }

    /**
     * Handles one incoming message and delivers a self-command reply when applicable.
     *
     * @param {object} message Baileys WAMessage.
     * @returns {Promise<object|null>} Command result or null.
     */
    async handleIncomingMessage(message) {
        if (!message?.key?.fromMe || !this.onSelfCommand) {
            return null;
        }

        const body = this.readMessageText(message);

        if (!isWhatsBotCommand(body) || !this.isSelfChatMessage(message)) {
            return null;
        }

        // One command can be delivered again as an append during history sync or after a
        // reconnect. Scheduling it twice would be a visible product bug.
        if (!this.rememberProcessedMessage(message.key.id)) {
            return null;
        }

        const activeClient = this.client;
        const chatJid = normalizeJid(message.key.remoteJid);

        try {
            const result = await this.onSelfCommand({
                sessionId: this.config.clientId,
                body,
                source: {
                    whatsappMessageId: typeof message.key.id === "string" ? message.key.id : null,
                    chatId: message.key.remoteJid || null,
                },
            });

            if (result?.reply && this.client === activeClient) {
                await this.sendTextReply(chatJid, result.reply);
            }

            return result;
        } catch (error) {
            if (this.client === activeClient) {
                await this.sendTextReply(chatJid, this.readCommandErrorReply(error)).catch(() => {});
            }

            throw error;
        }
    }

    /**
     * Remembers one processed self-command id, keeping the dedupe set bounded.
     *
     * @param {string|undefined} messageId WhatsApp message id.
     * @returns {boolean} True when this id has not been processed yet.
     */
    rememberProcessedMessage(messageId) {
        if (typeof messageId !== "string" || !messageId) {
            return true;
        }

        if (this.processedMessageIds.has(messageId)) {
            return false;
        }

        this.processedMessageIds.add(messageId);

        if (this.processedMessageIds.size > 500) {
            const oldest = this.processedMessageIds.values().next().value;
            this.processedMessageIds.delete(oldest);
        }

        return true;
    }

    /**
     * Sends one plain-text reply to a chat jid.
     *
     * @param {string} chatJid Destination jid.
     * @param {string} text Message body.
     * @returns {Promise<object|undefined>} Baileys send result.
     */
    async sendTextReply(chatJid, text) {
        if (!chatJid) {
            return undefined;
        }

        return await this.client.sendMessage(chatJid, { text: String(text ?? "") });
    }

    /**
     * Reads the text body of a Baileys message.
     *
     * @param {object} message Baileys WAMessage.
     * @returns {string} Trimmed text body or an empty string.
     */
    readMessageText(message) {
        const content = message?.message;

        if (!content || typeof content !== "object") {
            return "";
        }

        const candidates = [
            content.conversation,
            content.extendedTextMessage?.text,
            content.imageMessage?.caption,
            content.videoMessage?.caption,
            content.documentMessage?.caption,
        ];

        for (const value of candidates) {
            if (typeof value === "string" && value.trim()) {
                return value.trim();
            }
        }

        return "";
    }

    /**
     * Reports whether one message belongs to the user's own chat (PN or LID form).
     *
     * @param {object} message Baileys WAMessage.
     * @returns {boolean} True for a self-chat message.
     */
    isSelfChatMessage(message) {
        if (this.ownJids.size === 0) {
            this.ownJids = this.readOwnJids();
        }

        if (this.ownJids.size === 0) {
            return false;
        }

        return [message?.key?.remoteJid, message?.key?.remoteJidAlt]
            .map(normalizeJid)
            .some(jid => jid && this.ownJids.has(jid));
    }

    /**
     * Returns every known jid of the paired account, without device suffixes.
     *
     * @returns {Set<string>} Own PN and LID jids.
     */
    readOwnJids() {
        const user = this.client?.user;
        const jids = new Set();

        for (const raw of [user?.id, user?.lid]) {
            const jid = normalizeJid(raw);

            if (jid) {
                jids.add(jid);
            }
        }

        return jids;
    }

    /**
     * Builds one safe error reply for a failed command parse or schedule.
     *
     * @param {Error} error Command failure.
     * @returns {string} User-facing reply.
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
     * Reports whether one normalized target is addressable from the maintained directory.
     *
     * The lookup is a Set membership check so the avatar route never clones the directory.
     *
     * @param {{ targetType?: string, targetValue?: string, phoneNumber?: string }} target Canonical target.
     * @returns {boolean} True when the target is in the directory.
     */
    hasChatDirectoryTarget(target) {
        const normalizedTarget = normalizeMessageTarget(
            typeof target === "string"
                ? { phoneNumber: target }
                : target,
        );

        return this.directoryTargetIndex.has(`${normalizedTarget.targetType}:${normalizedTarget.targetValue}`);
    }

    /**
     * Refreshes group metadata and returns the event-maintained directory snapshot.
     *
     * Contacts and chats are never polled: they arrive through Baileys events. Group subjects are
     * re-read at most once every ten minutes, and failures back off without discarding the cache.
     *
     * @param {{ force?: boolean }} [options] Force a group re-fetch.
     * @returns {Promise<object>} Directory snapshot.
     */
    async refreshChatDirectory({ force = false } = {}) {
        if (!this.client || !this.isReady()) {
            return this.cloneChatDirectory(this.state.chatDirectory);
        }

        if (Date.now() < this.chatDirectoryRetryAt) {
            return this.cloneChatDirectory(this.state.chatDirectory);
        }

        if (!force && this.lastGroupDirectoryFetchAt
            && (Date.now() - this.lastGroupDirectoryFetchAt) < GROUP_DIRECTORY_TTL_MS) {
            return this.cloneChatDirectory(this.state.chatDirectory);
        }

        if (this.groupDirectoryRefreshPromise && this.groupDirectoryRefreshClient === this.client) {
            return await this.groupDirectoryRefreshPromise;
        }

        const activeClient = this.client;
        this.groupDirectoryRefreshClient = activeClient;
        this.groupDirectoryRefreshPromise = (async () => {
            try {
                const groups = typeof activeClient.groupFetchAllParticipating === "function"
                    ? await activeClient.groupFetchAllParticipating()
                    : null;

                if (this.client !== activeClient || !this.isReady()) {
                    return this.cloneChatDirectory(this.state.chatDirectory);
                }

                if (groups) {
                    this.mergeGroupRecords(groups);
                }

                this.lastGroupDirectoryFetchAt = Date.now();
                this.chatDirectoryRetryAt = 0;
                this.chatDirectoryLoggedErrors.clear();
                return this.cloneChatDirectory(this.state.chatDirectory);
            } catch (error) {
                if (this.client === activeClient) {
                    this.chatDirectoryRetryAt = Date.now() + (this.config.chatDirectoryRetryMs ?? 30000);
                    const message = String(error?.message || error);

                    if (!this.chatDirectoryLoggedErrors.has(message)) {
                        this.logger.error(`Could not refresh the chat directory for session ${this.config.clientId}:`, message);
                        this.chatDirectoryLoggedErrors.add(message);
                    }
                }

                return this.cloneChatDirectory(this.state.chatDirectory);
            } finally {
                if (this.groupDirectoryRefreshClient === activeClient) {
                    this.groupDirectoryRefreshPromise = null;
                    this.groupDirectoryRefreshClient = null;
                }
            }
        })();

        return await this.groupDirectoryRefreshPromise;
    }

    /**
     * Reports whether the managed socket is currently ready to send messages.
     */
    isReady() {
        return this.state.ready === true;
    }

    /**
     * Sends one WhatsApp message through the managed socket.
     *
     * @param {{ targetType?: string, targetValue?: string, phoneNumber?: string }|string} target Message target.
     * @param {string} message Message body.
     * @returns {Promise<object>} Send result persisted by the dispatcher.
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

        const client = this.client;
        const chatId = normalizedTarget.targetType === GROUP_TARGET_TYPE
            ? normalizedTarget.targetValue
            : await this.resolveWhatsAppChatId(normalizedTarget.phoneNumber);
        const sentMessage = await client.sendMessage(chatId, { text: normalizedMessage });
        const whatsappMessageId = this.readMessageId(sentMessage);

        if (!whatsappMessageId) {
            this.logger.warn(`WhatsApp send for session ${this.config.clientId} returned no message id.`);
        }

        return {
            chatId: toPublicChatId(chatId),
            phoneNumber: normalizedTarget.phoneNumber,
            targetType: normalizedTarget.targetType,
            targetValue: normalizedTarget.targetValue,
            whatsappMessageId,
            sentAt: this.readSentAt(sentMessage),
        };
    }

    /**
     * Reads the Baileys message id from one send result.
     *
     * @param {object} message Sent WAMessage.
     * @returns {string|null} Message id or null when WhatsApp returned none.
     */
    readMessageId(message) {
        const candidates = [
            message?.key?.id,
            message?.id?._serialized,
            message?.id?.id,
            message?.id,
            message?._data?.id?.id,
            message?._data?.id,
        ];

        for (const id of candidates) {
            if (typeof id === "string" && id.trim()) return id.trim();
        }

        return null;
    }

    /**
     * Reads the send timestamp from one Baileys message.
     *
     * @param {object} message Sent WAMessage.
     * @returns {string} ISO timestamp.
     */
    readSentAt(message) {
        const seconds = Number(message?.messageTimestamp ?? message?.timestamp);

        return Number.isFinite(seconds) && seconds > 0
            ? new Date(seconds * 1000).toISOString()
            : new Date().toISOString();
    }

    /**
     * Verifies that one target can be resolved immediately by the ready socket.
     *
     * @param {{ targetType?: string, targetValue?: string, phoneNumber?: string }|string} target Message target.
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
     * Resolves one profile picture URL through the ready socket.
     *
     * The cache, single-flight map and concurrency slots belong to this client manager, so two
     * sessions can never share a profile URL. A missing photo is cached as null for two minutes;
     * an existing URL stays valid for fifteen minutes. At most four lookups run at once and every
     * caller gives up after five seconds.
     *
     * @param {{ targetType?: string, targetValue?: string, phoneNumber?: string }} target Canonical message target.
     * @returns {Promise<string|null>} Profile picture URL or null when WhatsApp has no photo.
     */
    async getProfilePicUrl(target) {
        const normalizedTarget = normalizeMessageTarget(
            typeof target === "string"
                ? { phoneNumber: target }
                : target,
        );

        if (!this.client || !this.isReady()) {
            throw new HttpError(503, "WhatsApp client is not ready to load profile pictures.");
        }

        const jid = normalizedTarget.targetType === GROUP_TARGET_TYPE
            ? normalizedTarget.targetValue
            : `${normalizedTarget.phoneNumber}@${CONTACT_SERVER}`;
        const cached = this.readAvatarCache(jid);
        if (cached.hit) {
            return cached.url;
        }

        const existingLookup = this.avatarInFlight.get(jid);
        if (existingLookup) {
            return await existingLookup;
        }

        const generation = this.avatarGeneration;
        const lookup = this.resolveAvatarLookup(jid, generation, Date.now() + AVATAR_LOOKUP_TIMEOUT_MS);

        this.avatarInFlight.set(jid, lookup);
        lookup
            .finally(() => {
                if (this.avatarInFlight.get(jid) === lookup) {
                    this.avatarInFlight.delete(jid);
                }
            })
            .catch(() => {});

        return await lookup;
    }

    /**
     * Reads one avatar cache entry while discarding expired entries.
     *
     * @param {string} jid Canonical WhatsApp jid.
     * @returns {{ hit: boolean, url: string|null }} Cache result.
     */
    readAvatarCache(jid) {
        const cached = this.avatarCache.get(jid);

        if (!cached) {
            return { hit: false, url: null };
        }

        if (cached.expiresAt <= Date.now()) {
            this.avatarCache.delete(jid);
            return { hit: false, url: null };
        }

        return { hit: true, url: cached.url };
    }

    /**
     * Stores one profile picture lookup with the TTL that matches a photo or a missing photo.
     *
     * @param {string} jid Canonical WhatsApp jid.
     * @param {string|null} url Resolved URL.
     */
    writeAvatarCache(jid, url) {
        this.avatarCache.set(jid, {
            url: url || null,
            expiresAt: Date.now() + (url ? AVATAR_CACHE_HIT_TTL_MS : AVATAR_CACHE_MISS_TTL_MS),
        });
    }

    /**
     * Clears profile picture state when the underlying socket is disposed.
     *
     * In-flight operations keep their slots until they settle, but their results can no longer be
     * cached or served to the replacement socket because the generation changes.
     */
    clearAvatarCache() {
        this.avatarGeneration += 1;
        this.avatarCache.clear();
        this.avatarInFlight.clear();

        const waiters = this.avatarWaiters.splice(0);
        for (const waiter of waiters) {
            clearTimeout(waiter.timer);
            waiter.reject(new HttpError(503, "WhatsApp client was replaced."));
        }
    }

    /**
     * Resolves one avatar lookup with the concurrency slot and deadline applied.
     *
     * @param {string} jid Canonical WhatsApp jid.
     * @param {number} generation Client generation captured at request time.
     * @param {number} deadline Absolute deadline in milliseconds.
     * @returns {Promise<string|null>} Profile picture URL or null.
     */
    async resolveAvatarLookup(jid, generation, deadline) {
        await this.acquireAvatarSlot(deadline);

        try {
            if (generation !== this.avatarGeneration || !this.client || !this.isReady()) {
                throw new HttpError(503, "WhatsApp client is not ready to load profile pictures.");
            }

            // A queued lookup may inherit a result that landed while it waited for a slot.
            const cached = this.readAvatarCache(jid);
            if (cached.hit) {
                return cached.url;
            }

            const client = this.client;
            const rawUrl = await this.withAvatarDeadline(client.profilePictureUrl(jid, "preview"), deadline);
            const url = typeof rawUrl === "string" && rawUrl.trim() ? rawUrl.trim() : null;

            if (generation === this.avatarGeneration) {
                this.writeAvatarCache(jid, url);
            }

            return url;
        } catch (error) {
            if (error instanceof HttpError) {
                throw error;
            }

            throw new HttpError(503, "Could not load the profile picture from WhatsApp.", error);
        } finally {
            this.releaseAvatarSlot();
        }
    }

    /**
     * Acquires one of the four profile picture lookup slots, waiting until the deadline.
     *
     * @param {number} deadline Absolute deadline in milliseconds.
     * @returns {Promise<void>} Resolves when a slot is owned.
     */
    async acquireAvatarSlot(deadline) {
        if (this.avatarActiveCount < AVATAR_MAX_IN_FLIGHT) {
            this.avatarActiveCount += 1;
            return;
        }

        if (Date.now() >= deadline) {
            throw new HttpError(503, "Profile picture lookup timed out.");
        }

        if (this.avatarWaiters.length >= AVATAR_MAX_QUEUED) {
            throw new HttpError(503, "Profile picture lookup capacity is exhausted.");
        }

        await new Promise((resolve, reject) => {
            const waiter = {
                timer: null,
                resolve: () => {
                    clearTimeout(waiter.timer);
                    resolve();
                },
                reject: error => {
                    clearTimeout(waiter.timer);
                    reject(error);
                },
            };

            waiter.timer = setTimeout(() => {
                const index = this.avatarWaiters.indexOf(waiter);
                if (index >= 0) {
                    this.avatarWaiters.splice(index, 1);
                }
                reject(new HttpError(503, "Profile picture lookup timed out."));
            }, Math.max(0, deadline - Date.now()));

            this.avatarWaiters.push(waiter);
        });
    }

    /**
     * Releases one slot directly or transfers it to the oldest waiter.
     */
    releaseAvatarSlot() {
        const waiter = this.avatarWaiters.shift();

        if (waiter) {
            // The granted slot is already counted in avatarActiveCount.
            waiter.resolve();
            return;
        }

        this.avatarActiveCount = Math.max(0, this.avatarActiveCount - 1);
    }

    /**
     * Races one profile picture lookup against its absolute deadline.
     *
     * @param {Promise<string|undefined>} lookup Library lookup.
     * @param {number} deadline Absolute deadline in milliseconds.
     * @returns {Promise<string|undefined>} Raw library result.
     */
    async withAvatarDeadline(lookup, deadline) {
        const remainingMs = deadline - Date.now();

        if (remainingMs <= 0) {
            throw new HttpError(503, "Profile picture lookup timed out.");
        }

        let timer = null;

        try {
            return await Promise.race([
                lookup,
                new Promise((_resolve, reject) => {
                    timer = setTimeout(
                        () => reject(new HttpError(503, "Profile picture lookup timed out.")),
                        remainingMs,
                    );
                }),
            ]);
        } finally {
            clearTimeout(timer);
        }
    }

    /**
     * Resolves the best WhatsApp chat jid for one phone number before sending.
     *
     * @param {string} phoneNumber Normalized phone number.
     * @returns {Promise<string>} Addressable Baileys jid.
     */
    async resolveWhatsAppChatId(phoneNumber) {
        const client = this.client;

        if (typeof client?.onWhatsApp !== "function") {
            throw new Error(`WhatsApp could not resolve a registered account for ${phoneNumber}.`);
        }

        for (const candidate of this.buildPhoneNumberCandidates(phoneNumber)) {
            let results = null;

            try {
                results = await client.onWhatsApp(candidate);
            } catch {
                continue;
            }

            const match = (Array.isArray(results) ? results : [])
                .find(result => result?.exists && result?.jid);

            if (match) {
                return match.jid;
            }
        }

        throw new Error(`WhatsApp could not resolve a registered account for ${phoneNumber}.`);
    }

    /**
     * Builds candidate numbers, including a Brazil mobile 9-digit fallback.
     *
     * @param {string} phoneNumber Normalized phone number.
     * @returns {string[]} Candidate digits, most likely first.
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

        return [...new Set(candidates)];
    }

    /**
     * Ingests one history-sync batch into the directory.
     *
     * @param {{ chats?: Array<object>, contacts?: Array<object> }} payload History sync payload.
     */
    ingestHistorySet(payload = {}) {
        let changed = false;

        for (const chat of Array.isArray(payload?.chats) ? payload.chats : []) {
            changed = this.mergeChatRecord(chat) || changed;
        }

        for (const contact of Array.isArray(payload?.contacts) ? payload.contacts : []) {
            changed = this.mergeContactRecord(contact) || changed;
        }

        if (changed) {
            this.rebuildChatDirectory();
        }
    }

    /**
     * Merges an array of Baileys chats into the directory.
     *
     * @param {Array<object>} chats Chat models.
     */
    mergeChatRecords(chats) {
        this.mergeDirectoryBatch(Array.isArray(chats) ? chats : [], chat => this.mergeChatRecord(chat));
    }

    /**
     * Merges an array of Baileys contacts into the directory.
     *
     * @param {Array<object>} contacts Contact models.
     */
    mergeContactRecords(contacts) {
        this.mergeDirectoryBatch(Array.isArray(contacts) ? contacts : [], contact => this.mergeContactRecord(contact));
    }

    /**
     * Merges an array or map of group metadata into the directory.
     *
     * @param {Array<object>|Object<string, object>} groups Group metadata models.
     */
    mergeGroupRecords(groups) {
        const list = Array.isArray(groups) ? groups : Object.values(groups ?? {});

        this.mergeDirectoryBatch(list, group => this.mergeGroupRecord(group));
    }

    /**
     * Applies one batch of directory merges and rebuilds once when anything changed.
     *
     * @param {Array<object>} entries Raw models.
     * @param {(entry: object) => boolean} merge One merge operation.
     */
    mergeDirectoryBatch(entries, merge) {
        let changed = false;

        for (const entry of entries) {
            changed = merge(entry) || changed;
        }

        if (changed) {
            this.rebuildChatDirectory();
        }
    }

    /**
     * Merges one chat model into the directory records.
     *
     * @param {object} chat Baileys chat model.
     * @returns {boolean} True when a record changed.
     */
    mergeChatRecord(chat) {
        const jid = normalizeJid(chat?.id);

        if (!jid) {
            return false;
        }

        const target = this.parseDirectoryTarget(jid);

        if (!target) {
            return false;
        }

        const created = !this.directoryRecords.has(target.id);
        const record = this.ensureDirectoryRecord(target);
        const named = this.mergeDirectoryNames(record, { chat: chat?.name });

        return created || named;
    }

    /**
     * Merges one contact model into the directory records.
     *
     * @param {object} contact Baileys contact model.
     * @returns {boolean} True when a record changed.
     */
    mergeContactRecord(contact) {
        const target = this.parseContactTarget(contact);

        if (!target) {
            return false;
        }

        const created = !this.directoryRecords.has(target.id);
        const record = this.ensureDirectoryRecord(target);

        const named = this.mergeDirectoryNames(record, {
            saved: contact?.name,
            pushname: contact?.notify,
            verified: contact?.verifiedName,
        });

        return created || named;
    }

    /**
     * Merges one group metadata model into the directory records.
     *
     * @param {object} group Baileys group metadata.
     * @returns {boolean} True when a record changed.
     */
    mergeGroupRecord(group) {
        const target = this.parseDirectoryTarget(group?.id);

        if (!target || target.targetType !== GROUP_TARGET_TYPE) {
            return false;
        }

        const created = !this.directoryRecords.has(target.id);
        const record = this.ensureDirectoryRecord(target);
        const named = this.mergeDirectoryNames(record, { subject: group?.subject });

        return created || named;
    }

    /**
     * Extracts canonical target identity fields for a valid contact jid.
     *
     * @param {object} contact Baileys contact model.
     * @returns {object|null} Target fields or null when the contact is not addressable by phone.
     */
    parseContactTarget(contact) {
        const digits = readContactDigits(contact?.phoneNumber, contact?.id);

        if (!digits) {
            return null;
        }

        const chatId = `${digits}@${CONTACT_CHAT_SERVER}`;

        return {
            id: chatId,
            targetType: CONTACT_TARGET_TYPE,
            targetValue: digits,
            phoneNumber: digits,
            chatId,
        };
    }

    /**
     * Extracts canonical target identity fields for a valid @c.us or @g.us jid.
     *
     * @param {string} jid Normalized jid.
     * @returns {object|null} Target fields or null for LIDs, broadcasts and malformed ids.
     */
    parseDirectoryTarget(jid) {
        const serializedId = String(jid ?? "").trim();

        if (!serializedId) {
            return null;
        }

        const groupMatch = serializedId.match(GROUP_ID_PATTERN);

        if (groupMatch) {
            const groupId = `${groupMatch[1]}@g.us`;

            return {
                id: groupId,
                targetType: GROUP_TARGET_TYPE,
                targetValue: groupId,
                phoneNumber: null,
                chatId: groupId,
            };
        }

        const contactMatch = serializedId.match(CONTACT_ID_PATTERN);

        if (contactMatch) {
            const digits = contactMatch[1];

            return {
                id: `${digits}@${CONTACT_CHAT_SERVER}`,
                targetType: CONTACT_TARGET_TYPE,
                targetValue: digits,
                phoneNumber: digits,
                chatId: `${digits}@${CONTACT_CHAT_SERVER}`,
            };
        }

        return null;
    }

    /**
     * Returns the directory record for one target, creating it when absent.
     *
     * @param {object} target Canonical target fields.
     * @returns {object} Mutable directory record.
     */
    ensureDirectoryRecord(target) {
        const existing = this.directoryRecords.get(target.id);

        if (existing) {
            return existing;
        }

        const record = {
            id: target.id,
            targetType: target.targetType,
            targetValue: target.targetValue,
            phoneNumber: target.phoneNumber ?? null,
            chatId: target.chatId,
            names: {},
        };
        this.directoryRecords.set(record.id, record);

        return record;
    }

    /**
     * Stores the non-empty name fields reported for one directory record.
     *
     * @param {object} record Directory record.
     * @param {object} names Name candidates by source.
     * @returns {boolean} True when a stored name changed.
     */
    mergeDirectoryNames(record, names) {
        let changed = false;

        for (const [source, value] of Object.entries(names)) {
            if (typeof value !== "string" || !value.trim()) {
                continue;
            }

            const trimmed = value.trim();

            if (record.names[source] !== trimmed) {
                record.names[source] = trimmed;
                changed = true;
            }
        }

        return changed;
    }

    /**
     * Rebuilds the public directory snapshot and its membership index from the records.
     *
     * @returns {object} Directory snapshot.
     */
    rebuildChatDirectory() {
        const contacts = [];
        const groups = [];

        for (const record of this.directoryRecords.values()) {
            const name = this.selectDirectoryName(this.readDirectoryNameCandidates(record), {
                allowAddressLabel: record.targetType === GROUP_TARGET_TYPE,
            });

            if (record.targetType === GROUP_TARGET_TYPE) {
                const displayName = name || record.id;

                groups.push({
                    id: record.id,
                    name: displayName,
                    targetType: GROUP_TARGET_TYPE,
                    targetValue: record.targetValue,
                    phoneNumber: null,
                    chatId: record.chatId,
                    label: displayName,
                });
                continue;
            }

            if (!name) {
                continue;
            }

            contacts.push({
                id: record.id,
                name,
                targetType: CONTACT_TARGET_TYPE,
                targetValue: record.targetValue,
                phoneNumber: record.phoneNumber,
                chatId: record.chatId,
                label: name,
            });
        }

        const compareEntries = (left, right) => (
            ptBrCollator.compare(left.name, right.name)
            || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
        );

        contacts.sort(compareEntries);
        groups.sort(compareEntries);

        const directory = {
            contacts,
            groups,
            refreshedAt: new Date().toISOString(),
        };

        this.directoryTargetIndex = new Set([
            ...contacts.map(entry => `${CONTACT_TARGET_TYPE}:${entry.targetValue}`),
            ...groups.map(entry => `${GROUP_TARGET_TYPE}:${entry.targetValue}`),
        ]);
        this.updateState({ chatDirectory: directory });
        this.scheduleDirectoryPersist();

        return directory;
    }

    /**
     * Returns the ordered name candidates reported for one record.
     *
     * @param {object} record Directory record.
     * @returns {string[]} Candidate labels, best first.
     */
    readDirectoryNameCandidates(record) {
        const names = record.names || {};

        return record.targetType === GROUP_TARGET_TYPE
            ? [names.subject, names.chat, names.extra]
            : [names.chat, names.saved, names.pushname, names.verified, names.extra];
    }

    /**
     * Selects one display name from candidate labels, ignoring addresses.
     *
     * @param {string[]} candidates Raw labels, best first.
     * @param {{ allowAddressLabel?: boolean }} [options] Keep address-shaped labels for groups.
     * @returns {string|null} Trimmed display name or null when unnamed.
     */
    selectDirectoryName(candidates, { allowAddressLabel = false } = {}) {
        const usable = [];

        // WhatsApp fills chat labels with the number when the contact has no saved name; an
        // address is not a name. Skip such labels and keep looking for a real name further down
        // the list instead of discarding the entry wholesale.
        for (const value of candidates) {
            if (typeof value !== "string") {
                continue;
            }

            const trimmed = value.trim();
            if (!trimmed || usable.includes(trimmed)) {
                continue;
            }

            // A group is addressed by its @g.us id, so a numeric title ("2026") is a real name.
            if (!allowAddressLabel && isAddressShapedLabel(trimmed)) {
                continue;
            }

            usable.push(trimmed);
        }

        if (usable.length === 0) {
            return null;
        }

        // The saved label is the default, but a contact saved under a short form ("Vinicius")
        // should read as the complete name WhatsApp reports ("Vinícius Guimarães") when one is a
        // prefix of the other. A deliberate rename ("Mãe") is never overridden.
        const saved = usable[0];
        const foldedSaved = foldDirectoryLabel(saved);
        let displayName = saved;

        for (const candidate of usable.slice(1)) {
            const foldedCandidate = foldDirectoryLabel(candidate);
            if (foldedCandidate.startsWith(`${foldedSaved} `) && candidate.length > displayName.length) {
                displayName = candidate;
            }
        }

        return displayName;
    }

    /**
     * Schedules one directory snapshot write, coalescing bursts of history events.
     */
    scheduleDirectoryPersist() {
        if (this.destroyed) {
            return;
        }

        clearTimeout(this.directoryPersistTimer);
        this.directoryPersistTimer = setTimeout(() => {
            this.directoryPersistTimer = null;
            this.persistChatDirectory().catch(error => {
                this.logger.warn?.(`Could not persist the chat directory for session ${this.config.clientId}:`, error?.message || error);
            });
        }, DIRECTORY_PERSIST_DELAY_MS);
        this.directoryPersistTimer.unref?.();
    }

    /**
     * Writes the current directory snapshot next to the auth state, serialized with prior writes.
     *
     * @returns {Promise<void>} Resolves after the write.
     */
    persistChatDirectory() {
        this.directoryPersistPromise = (this.directoryPersistPromise || Promise.resolve())
            .catch(() => {})
            .then(() => this.writeChatDirectorySnapshot());

        return this.directoryPersistPromise;
    }

    /**
     * Writes one directory snapshot atomically.
     *
     * @returns {Promise<void>} Resolves after the write.
     */
    async writeChatDirectorySnapshot() {
        const directory = this.state.chatDirectory;

        if (!Array.isArray(directory?.contacts) || !Array.isArray(directory?.groups)) {
            return;
        }

        // Never overwrite a persisted snapshot with emptiness just because this manager never
        // received directory events (for example a stub destroyed before its first boot).
        if (directory.contacts.length === 0 && directory.groups.length === 0 && this.directoryRecords.size === 0) {
            return;
        }

        const targetPath = path.join(this.getAuthDirectory(), DIRECTORY_FILE_NAME);
        const temporaryPath = `${targetPath}.tmp`;

        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.writeFile(temporaryPath, JSON.stringify({
            version: 1,
            contacts: directory.contacts,
            groups: directory.groups,
            refreshedAt: directory.refreshedAt || null,
        }), "utf8");
        await fs.rename(temporaryPath, targetPath);
    }

    /**
     * Flushes a pending snapshot write immediately.
     *
     * @returns {Promise<void>} Resolves after the write.
     */
    async flushChatDirectory() {
        clearTimeout(this.directoryPersistTimer);
        this.directoryPersistTimer = null;
        await this.persistChatDirectory();
    }

    /**
     * Restores the persisted directory snapshot once, before the first boot.
     *
     * @returns {Promise<object>} Directory snapshot.
     */
    restoreChatDirectory() {
        if (!this.directoryRestorePromise) {
            this.directoryRestorePromise = this.readChatDirectorySnapshot();
        }

        return this.directoryRestorePromise;
    }

    /**
     * Reads and validates the persisted directory snapshot.
     *
     * @returns {Promise<object>} Restored or current directory snapshot.
     */
    async readChatDirectorySnapshot() {
        try {
            const raw = await fs.readFile(path.join(this.getAuthDirectory(), DIRECTORY_FILE_NAME), "utf8");
            const directory = this.normalizeRestoredDirectory(JSON.parse(raw));

            if (!directory) {
                return this.state.chatDirectory;
            }

            this.directoryRecords.clear();
            for (const entry of [...directory.contacts, ...directory.groups]) {
                const record = this.ensureDirectoryRecord(entry);
                record.names.extra = entry.label;
            }
            this.directoryTargetIndex = new Set([
                ...directory.contacts.map(entry => `${CONTACT_TARGET_TYPE}:${entry.targetValue}`),
                ...directory.groups.map(entry => `${GROUP_TARGET_TYPE}:${entry.targetValue}`),
            ]);
            this.state = { ...this.state, chatDirectory: directory };
        } catch (error) {
            if (error?.code !== "ENOENT") {
                this.logger.warn?.(`Could not restore the chat directory for session ${this.config.clientId}:`, error?.message || error);
            }
        }

        return this.state.chatDirectory;
    }

    /**
     * Validates one persisted directory snapshot.
     *
     * @param {object} raw Parsed JSON.
     * @returns {object|null} Clean snapshot or null when unusable.
     */
    normalizeRestoredDirectory(raw) {
        if (!raw || !Array.isArray(raw.contacts) || !Array.isArray(raw.groups)) {
            return null;
        }

        const normalizeEntry = entry => {
            if (!entry || typeof entry.id !== "string" || !entry.id.trim()) {
                return null;
            }

            const targetType = entry.targetType === GROUP_TARGET_TYPE
                ? GROUP_TARGET_TYPE
                : entry.targetType === CONTACT_TARGET_TYPE ? CONTACT_TARGET_TYPE : null;
            const label = typeof entry.label === "string" && entry.label.trim()
                ? entry.label.trim()
                : typeof entry.name === "string" ? entry.name.trim() : "";

            if (!targetType || !label) {
                return null;
            }

            return {
                id: entry.id,
                name: label,
                targetType,
                targetValue: String(entry.targetValue ?? "").trim(),
                phoneNumber: targetType === CONTACT_TARGET_TYPE ? (entry.phoneNumber ?? null) : null,
                chatId: String(entry.chatId || entry.id),
                label,
            };
        };

        return {
            contacts: raw.contacts.map(normalizeEntry).filter(entry => entry && entry.targetType === CONTACT_TARGET_TYPE),
            groups: raw.groups.map(normalizeEntry).filter(entry => entry && entry.targetType === GROUP_TARGET_TYPE),
            refreshedAt: typeof raw.refreshedAt === "string" ? raw.refreshedAt : null,
        };
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
     * Stops recovery and closes the socket, including any boot still in flight.
     */
    async destroy() {
        this.destroyed = true;
        this.reconnectStopped = true;
        this.cancelReconnect();
        await this.initializingPromise?.catch(() => {});
        await this.flushChatDirectory().catch(() => {});
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
     * Removes the current socket reference after attempting a clean shutdown.
     */
    async disposeClient() {
        this.clearAvatarCache();
        this.saveCreds = null;
        this.ownJids = new Set();

        if (!this.client) {
            return;
        }

        const activeClient = this.client;
        this.client = null;

        try {
            activeClient.ev?.removeAllListeners?.();
        } catch {
            // A socket being torn down may already have destroyed its emitter.
        }

        try {
            await activeClient.end?.(undefined);
        } catch {
            // The socket may already be closed.
        }
    }

    /**
     * Reads the stable public client information exposed to API consumers.
     */
    readClientInfo() {
        const user = this.client?.user;

        if (!user?.id) {
            return null;
        }

        const { user: phoneNumber, server } = splitJid(user.id);

        return {
            wid: server ? `${phoneNumber}@${server}` : phoneNumber,
            phoneNumber: /^\d{10,15}$/.test(phoneNumber) ? phoneNumber : null,
            pushname: user.name || user.notify || null,
            platform: "baileys",
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
