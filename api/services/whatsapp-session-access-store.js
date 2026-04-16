import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { HttpError } from "../helpers/error.js";
import { normalizeAccessPassword, normalizeSessionId } from "../helpers/session.js";

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
    constructor({ authPath, filePath, logger = console } = {}) {
        this.authPath = String(authPath || "").trim() || "/whatsapp/auth";
        this.filePath = filePath || path.join(this.authPath, "whatsbot-session-access.json");
        this.logger = logger;
        this.entriesBySessionId = new Map();
        this.sessionIdByPassword = new Map();
        this.initializationPromise = null;
    }

    /**
     * Loads the registry from disk once.
     */
    async initialize() {
        if (this.initializationPromise) {
            return this.initializationPromise;
        }

        this.initializationPromise = this.loadRegistry()
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
        const entry = this.entriesBySessionId.get(normalizeSessionId(sessionId, { required: true }));
        return entry ? this.cloneEntry(entry) : null;
    }

    /**
     * Ensures one session id has a persistent access password.
     */
    async ensureSessionAccess(sessionId) {
        await this.initialize();
        const normalizedSessionId = normalizeSessionId(sessionId, { required: true });
        const existingEntry = this.entriesBySessionId.get(normalizedSessionId);

        if (existingEntry) {
            return this.cloneEntry(existingEntry);
        }

        const entry = {
            sessionId: normalizedSessionId,
            accessPassword: this.generateUniqueAccessPassword(),
            createdAt: new Date().toISOString(),
        };

        this.entriesBySessionId.set(entry.sessionId, entry);
        this.sessionIdByPassword.set(entry.accessPassword, entry.sessionId);
        await this.persistRegistry();
        return this.cloneEntry(entry);
    }

    /**
     * Resolves one access password into a known session entry.
     */
    async findByPassword(password) {
        await this.initialize();
        const normalizedPassword = normalizeAccessPassword(password, { required: true });
        const sessionId = this.sessionIdByPassword.get(normalizedPassword);

        if (!sessionId) {
            throw new HttpError(401, "Invalid session password.");
        }

        const entry = this.entriesBySessionId.get(sessionId);
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

        const entry = this.entriesBySessionId.get(normalizedSessionId);
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
     * Loads any persisted registry entries from disk.
     */
    async loadRegistry() {
        await fs.mkdir(path.dirname(this.filePath), { recursive: true });

        let payload = null;
        try {
            const fileContent = await fs.readFile(this.filePath, "utf8");
            payload = JSON.parse(fileContent);
        } catch (error) {
            if (error?.code !== "ENOENT") {
                this.logger.warn("Could not load WhatsBot session access registry:", error);
            }
        }

        const sessions = Array.isArray(payload?.sessions) ? payload.sessions : [];
        this.entriesBySessionId.clear();
        this.sessionIdByPassword.clear();

        for (const candidate of sessions) {
            try {
                const entry = {
                    sessionId: normalizeSessionId(candidate?.sessionId, { required: true }),
                    accessPassword: normalizeAccessPassword(candidate?.accessPassword, { required: true }),
                    createdAt: String(candidate?.createdAt || "").trim() || new Date().toISOString(),
                };

                this.entriesBySessionId.set(entry.sessionId, entry);
                this.sessionIdByPassword.set(entry.accessPassword, entry.sessionId);
            } catch (error) {
                this.logger.warn("Skipping invalid session access registry entry:", error?.message || error);
            }
        }
    }

    /**
     * Writes the in-memory registry back to disk.
     */
    async persistRegistry() {
        const payload = {
            version: 1,
            sessions: [...this.entriesBySessionId.values()].sort((left, right) => left.sessionId.localeCompare(right.sessionId)),
        };

        await fs.mkdir(path.dirname(this.filePath), { recursive: true });
        await fs.writeFile(this.filePath, JSON.stringify(payload, null, 2) + "\n", "utf8");
    }

    /**
     * Creates one user-friendly access password that is not yet in use.
     */
    generateUniqueAccessPassword() {
        for (let attempt = 0; attempt < 50; attempt += 1) {
            const accessPassword = [
                ACCESS_PASSWORD_ADJECTIVES[crypto.randomInt(0, ACCESS_PASSWORD_ADJECTIVES.length)],
                ACCESS_PASSWORD_NOUNS[crypto.randomInt(0, ACCESS_PASSWORD_NOUNS.length)],
                String(crypto.randomInt(1000, 10000)),
            ].join("-");

            if (!this.sessionIdByPassword.has(accessPassword)) {
                return accessPassword;
            }
        }

        throw new HttpError(500, "Could not generate a unique session password.");
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
