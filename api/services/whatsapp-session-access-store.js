import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { HttpError } from "../helpers/error.js";
import { normalizeAccessPassword, normalizeSessionId } from "../helpers/session.js";
import { WhatsAppSessionAccess } from "../model/whatsapp-session-access.js";

const ACCESS_PASSWORD_ADJECTIVES = [
    "amber",
    "bright",
    "calm",
    "clear",
    "cloud",
    "coral",
    "crisp",
    "dawn",
    "ember",
    "field",
    "flint",
    "fresh",
    "globe",
    "gold",
    "green",
    "harbor",
    "honey",
    "ivory",
    "jade",
    "lake",
    "lime",
    "maple",
    "mint",
    "nova",
    "olive",
    "pearl",
    "pine",
    "plain",
    "river",
    "sable",
    "silver",
    "solar",
    "stone",
    "sunny",
    "tidal",
    "velvet",
    "vivid",
    "willow",
];
const ACCESS_PASSWORD_NOUNS = [
    "anchor",
    "beacon",
    "bridge",
    "brook",
    "cabin",
    "canyon",
    "circle",
    "coast",
    "comet",
    "creek",
    "garden",
    "grove",
    "harbor",
    "island",
    "lagoon",
    "lantern",
    "meadow",
    "market",
    "mesa",
    "monsoon",
    "orchard",
    "path",
    "prairie",
    "quartz",
    "ridge",
    "rocket",
    "shore",
    "signal",
    "spring",
    "summit",
    "temple",
    "thunder",
    "trail",
    "valley",
    "voyage",
    "waterfall",
    "wave",
    "window",
];

/**
 * Stores the mapping between public session ids and user-facing access passwords.
 */
class WhatsAppSessionAccessStore {
    constructor({ authPath, filePath, logger = console, sessionAccessModel = WhatsAppSessionAccess } = {}) {
        this.authPath = String(authPath || "").trim() || "/whatsapp/auth";
        this.filePath = filePath || path.join(this.authPath, "whatsbot-session-access.json");
        this.logger = logger;
        this.sessionAccessModel = sessionAccessModel;
        this.initializationPromise = null;
    }

    /**
     * Loads the registry from disk once.
     */
    async initialize() {
        if (this.initializationPromise) {
            return this.initializationPromise;
        }

        this.initializationPromise = this.migrateLegacyRegistry()
            .catch(error => {
                this.initializationPromise = null;
                throw error;
            });

        return this.initializationPromise;
    }

    /**
     * Returns one cloned registry entry for a session id.
     */
    async getBySessionId(sessionId) {
        await this.initialize();
        const entry = await this.sessionAccessModel.findBySessionId(sessionId);
        return entry ? this.cloneEntry(entry) : null;
    }

    /**
     * Ensures one session id has a persistent access password.
     */
    async ensureSessionAccess(sessionId) {
        await this.initialize();
        const normalizedSessionId = normalizeSessionId(sessionId, { required: true });
        const existingEntry = await this.sessionAccessModel.findBySessionId(normalizedSessionId);

        if (existingEntry) {
            return this.cloneEntry(existingEntry);
        }

        return this.cloneEntry(await this.createSessionAccess({ sessionId: normalizedSessionId }));
    }

    /**
     * Resolves one access password into a known session entry.
     */
    async findByPassword(password) {
        await this.initialize();
        const normalizedPassword = normalizeAccessPassword(password, { required: true });
        const entry = await this.findOptionalByPassword(normalizedPassword);
        if (!entry) {
            throw new HttpError(401, "Invalid session password.");
        }

        return this.cloneEntry(entry);
    }

    /**
     * Verifies that one session id matches the supplied password.
     */
    async assertSessionAccess(sessionId, password, { allowDefaultSession = false, defaultSessionId = "main" } = {}) {
        await this.initialize();
        const normalizedSessionId = normalizeSessionId(sessionId, { required: true });
        const normalizedDefaultSessionId = normalizeSessionId(defaultSessionId, { fallback: "main" });

        if (allowDefaultSession && normalizedSessionId === normalizedDefaultSessionId && !String(password ?? "").trim()) {
            return null;
        }

        const entry = await this.sessionAccessModel.findBySessionId(normalizedSessionId);
        if (!entry) {
            throw new HttpError(401, "Session password is required.");
        }

        const normalizedPassword = normalizeAccessPassword(password, { required: true });
        if (entry.accessPassword !== normalizedPassword) {
            throw new HttpError(401, "Invalid session password.");
        }

        return this.cloneEntry(entry);
    }

    /**
     * Migrates any legacy JSON-backed session registry entries into MySQL.
     */
    async migrateLegacyRegistry() {
        let payload = null;
        try {
            const fileContent = await fs.readFile(this.filePath, "utf8");
            payload = JSON.parse(fileContent);
        } catch (error) {
            if (error?.code !== "ENOENT") {
                this.logger.warn("Could not read legacy WhatsBot session access registry:", error);
            }

            return;
        }

        const sessions = Array.isArray(payload?.sessions) ? payload.sessions : [];

        for (const candidate of sessions) {
            try {
                const entry = {
                    sessionId: normalizeSessionId(candidate?.sessionId, { required: true }),
                    accessPassword: normalizeAccessPassword(candidate?.accessPassword, { required: true }),
                    createdAt: String(candidate?.createdAt || "").trim() || new Date().toISOString(),
                };

                await this.createSessionAccess(entry, { preserveAccessPassword: true });
            } catch (error) {
                this.logger.warn("Skipping legacy session access registry entry:", error?.message || error);
            }
        }
    }

    /**
     * Creates one persisted access record, retrying password collisions when needed.
     */
    async createSessionAccess({ sessionId, accessPassword = "", createdAt = null } = {}, { preserveAccessPassword = false } = {}) {
        const normalizedSessionId = normalizeSessionId(sessionId, { required: true });

        for (let attempt = 0; attempt < 50; attempt += 1) {
            const candidatePassword = preserveAccessPassword
                ? normalizeAccessPassword(accessPassword, { required: true })
                : this.generateUniqueAccessPassword();

            try {
                const entry = await this.sessionAccessModel.create({
                    sessionId: normalizedSessionId,
                    accessPassword: candidatePassword,
                    createdAt,
                    updatedAt: createdAt,
                });

                return this.cloneEntry(entry);
            } catch (error) {
                if (!this.isDuplicateEntryError(error)) {
                    throw error;
                }

                const existingEntry = await this.sessionAccessModel.findBySessionId(normalizedSessionId);
                if (existingEntry) {
                    return this.cloneEntry(existingEntry);
                }

                if (preserveAccessPassword) {
                    const existingPasswordEntry = await this.findOptionalByPassword(candidatePassword);

                    if (existingPasswordEntry && existingPasswordEntry.sessionId !== normalizedSessionId) {
                        throw new HttpError(409, "Session password already belongs to a different session.");
                    }
                }
            }
        }

        throw new HttpError(500, "Could not generate a unique session password.");
    }

    /**
     * Returns one access entry for a password when it exists.
     */
    async findOptionalByPassword(password) {
        return this.sessionAccessModel.findByPassword(password);
    }

    /**
     * Returns true when the error wraps one duplicate-key violation.
     */
    isDuplicateEntryError(error) {
        return error?.data?.error?.code === "ER_DUP_ENTRY";
    }

    /**
     * Creates one user-friendly access password that is not yet in use.
     */
    generateUniqueAccessPassword() {
        return [
            ACCESS_PASSWORD_ADJECTIVES[crypto.randomInt(0, ACCESS_PASSWORD_ADJECTIVES.length)],
            ACCESS_PASSWORD_NOUNS[crypto.randomInt(0, ACCESS_PASSWORD_NOUNS.length)],
            String(crypto.randomInt(1000, 10000)),
        ].join("-");
    }

    /**
     * Clones one entry so callers cannot mutate the store state.
     */
    cloneEntry(entry) {
        return {
            sessionId: entry.sessionId,
            accessPassword: entry.accessPassword,
            createdAt: entry.createdAt,
        };
    }
}

export { WhatsAppSessionAccessStore };
