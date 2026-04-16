import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { HttpError } from "../helpers/error.js";
import { normalizeAccessToken, normalizeRecoveryPassword, normalizeSessionId } from "../helpers/session.js";
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
const RECOVERY_PASSWORD_WORDS = [...new Set([
    ...ACCESS_PASSWORD_ADJECTIVES,
    ...ACCESS_PASSWORD_NOUNS,
])];
const ACCESS_TOKEN_BYTES = 32;
const RECOVERY_PASSWORD_WORD_COUNT = 6;
const RECOVERY_PASSWORD_NUMBER_MIN = 1000;
const RECOVERY_PASSWORD_NUMBER_MAX = 10000;
const RECOVERY_PASSWORD_HASH_BYTES = 32;

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
        return entry ? this.cloneMetadata(entry) : null;
    }

    /**
     * Creates one persistent access bundle for a new session.
     */
    async createSessionAccess(sessionId) {
        await this.initialize();
        const normalizedSessionId = normalizeSessionId(sessionId, { required: true });
        const existingEntry = await this.sessionAccessModel.findBySessionId(normalizedSessionId);

        if (existingEntry) {
            throw new HttpError(409, "Session access already exists for that session.");
        }

        return this.createPersistedSessionAccess({ sessionId: normalizedSessionId });
    }

    /**
     * Resolves one recovery password into a known session and rotates the bearer token.
     */
    async loginWithRecoveryPassword(recoveryPassword) {
        await this.initialize();
        const normalizedRecoveryPassword = normalizeRecoveryPassword(recoveryPassword, { required: true });
        const entry = await this.findOptionalByRecoveryPassword(normalizedRecoveryPassword);
        if (!entry || !this.verifyRecoveryPassword(normalizedRecoveryPassword, entry)) {
            throw new HttpError(401, "Invalid recovery password.");
        }

        return this.rotateAccessToken(entry);
    }

    /**
     * Verifies that one session id matches the supplied bearer token.
     */
    async assertSessionAccess(sessionId, accessToken, { allowDefaultSession = false, defaultSessionId = "main" } = {}) {
        await this.initialize();
        const normalizedSessionId = normalizeSessionId(sessionId, { required: true });
        const normalizedDefaultSessionId = normalizeSessionId(defaultSessionId, { fallback: "main" });

        if (allowDefaultSession && normalizedSessionId === normalizedDefaultSessionId && !String(accessToken ?? "").trim()) {
            return null;
        }

        const entry = await this.sessionAccessModel.findBySessionId(normalizedSessionId);
        if (!entry) {
            throw new HttpError(401, "Session token is required.");
        }

        const normalizedAccessToken = normalizeAccessToken(accessToken, { required: true });
        if (!this.matchesAccessToken(entry, normalizedAccessToken)) {
            throw new HttpError(401, "Invalid session token.");
        }

        return this.cloneMetadata(entry);
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
                    recoveryPassword: normalizeRecoveryPassword(candidate?.accessPassword, { required: true }),
                    createdAt: String(candidate?.createdAt || "").trim() || new Date().toISOString(),
                };

                await this.createPersistedSessionAccess(entry, { preserveRecoveryPassword: true });
            } catch (error) {
                this.logger.warn("Skipping legacy session access registry entry:", error?.message || error);
            }
        }
    }

    /**
     * Creates one persisted access record, retrying secret collisions when needed.
     */
    async createPersistedSessionAccess({ sessionId, recoveryPassword = "", createdAt = null } = {}, { preserveRecoveryPassword = false } = {}) {
        const normalizedSessionId = normalizeSessionId(sessionId, { required: true });

        for (let attempt = 0; attempt < 50; attempt += 1) {
            const candidateRecoveryPassword = preserveRecoveryPassword
                ? normalizeRecoveryPassword(recoveryPassword, { required: true })
                : this.generateRecoveryPassword();
            const accessToken = this.generateAccessToken();
            const recoveryPasswordSalt = this.generateRecoveryPasswordSalt();

            try {
                const entry = await this.sessionAccessModel.create({
                    sessionId: normalizedSessionId,
                    accessTokenHash: this.hashSecret(normalizeAccessToken(accessToken, { required: true })),
                    recoveryPasswordHash: this.hashRecoveryPassword(candidateRecoveryPassword, recoveryPasswordSalt),
                    recoveryPasswordSalt,
                    recoveryPasswordLookup: this.hashSecret(candidateRecoveryPassword),
                    createdAt,
                    updatedAt: createdAt,
                });

                return this.buildIssuedAccess(entry, {
                    accessToken,
                    recoveryPassword: candidateRecoveryPassword,
                });
            } catch (error) {
                if (!this.isDuplicateEntryError(error)) {
                    throw error;
                }

                const existingEntry = await this.sessionAccessModel.findBySessionId(normalizedSessionId);
                if (existingEntry) {
                    throw new HttpError(409, "Session access already exists for that session.");
                }

                if (preserveRecoveryPassword) {
                    const existingPasswordEntry = await this.findOptionalByRecoveryPassword(candidateRecoveryPassword);

                    if (existingPasswordEntry && existingPasswordEntry.sessionId !== normalizedSessionId) {
                        throw new HttpError(409, "Recovery password already belongs to a different session.");
                    }
                }
            }
        }

        throw new HttpError(500, "Could not generate a unique recovery password.");
    }

    /**
     * Returns one access entry for a recovery password when it exists.
     */
    async findOptionalByRecoveryPassword(recoveryPassword) {
        const lookupHash = this.hashSecret(normalizeRecoveryPassword(recoveryPassword, { required: true }));
        return this.sessionAccessModel.findByRecoveryPasswordLookup(lookupHash);
    }

    /**
     * Returns true when the error wraps one duplicate-key violation.
     */
    isDuplicateEntryError(error) {
        return error?.data?.error?.code === "ER_DUP_ENTRY";
    }

    /**
     * Rotates the bearer token for one existing session entry.
     */
    async rotateAccessToken(entry) {
        const sessionEntry = entry?.sessionId
            ? entry
            : await this.sessionAccessModel.findBySessionId(entry);

        if (!sessionEntry) {
            throw new HttpError(401, "Invalid recovery password.");
        }

        for (let attempt = 0; attempt < 50; attempt += 1) {
            const accessToken = this.generateAccessToken();

            try {
                await this.sessionAccessModel.update({ session_id: sessionEntry.sessionId }, {
                    sessionId: sessionEntry.sessionId,
                    accessTokenHash: this.hashSecret(accessToken),
                    recoveryPasswordHash: sessionEntry.recoveryPasswordHash,
                    recoveryPasswordSalt: sessionEntry.recoveryPasswordSalt,
                    recoveryPasswordLookup: sessionEntry.recoveryPasswordLookup,
                    createdAt: sessionEntry.createdAt,
                    updatedAt: new Date().toISOString(),
                });

                const updatedEntry = await this.sessionAccessModel.findBySessionId(sessionEntry.sessionId);
                return this.buildIssuedAccess(updatedEntry, { accessToken });
            } catch (error) {
                if (!this.isDuplicateEntryError(error)) {
                    throw error;
                }
            }
        }

        throw new HttpError(500, "Could not rotate the session token.");
    }

    /**
     * Creates one random bearer token for the browser session.
     */
    generateAccessToken() {
        return crypto.randomBytes(ACCESS_TOKEN_BYTES).toString("hex");
    }

    /**
     * Creates one human-friendly recovery password.
     */
    generateRecoveryPassword() {
        const words = [];

        for (let index = 0; index < RECOVERY_PASSWORD_WORD_COUNT; index += 1) {
            words.push(RECOVERY_PASSWORD_WORDS[crypto.randomInt(0, RECOVERY_PASSWORD_WORDS.length)]);
        }

        words.push(String(crypto.randomInt(RECOVERY_PASSWORD_NUMBER_MIN, RECOVERY_PASSWORD_NUMBER_MAX)));

        return words.join("-");
    }

    /**
     * Creates one fresh salt for the recovery-password hash.
     */
    generateRecoveryPasswordSalt() {
        return crypto.randomBytes(16).toString("hex");
    }

    /**
     * Hashes one secret with SHA-256 for deterministic lookups.
     */
    hashSecret(secret) {
        return crypto.createHash("sha256").update(String(secret || "")).digest("hex");
    }

    /**
     * Derives one recovery-password hash using scrypt.
     */
    hashRecoveryPassword(recoveryPassword, salt) {
        return crypto.scryptSync(recoveryPassword, salt, RECOVERY_PASSWORD_HASH_BYTES).toString("hex");
    }

    /**
     * Returns true when one supplied access token matches the stored hash.
     */
    matchesAccessToken(entry, accessToken) {
        return this.safeEqualHex(entry.accessTokenHash, this.hashSecret(accessToken));
    }

    /**
     * Returns true when one supplied recovery password matches the stored hash.
     */
    verifyRecoveryPassword(recoveryPassword, entry) {
        return this.safeEqualHex(
            entry.recoveryPasswordHash,
            this.hashRecoveryPassword(recoveryPassword, entry.recoveryPasswordSalt),
        );
    }

    /**
     * Compares two hexadecimal digests in constant time when possible.
     */
    safeEqualHex(left, right) {
        const leftBuffer = Buffer.from(String(left || ""), "hex");
        const rightBuffer = Buffer.from(String(right || ""), "hex");

        if (leftBuffer.length === 0 || leftBuffer.length !== rightBuffer.length) {
            return false;
        }

        return crypto.timingSafeEqual(leftBuffer, rightBuffer);
    }

    /**
     * Builds the issued secret payload returned to callers.
     */
    buildIssuedAccess(entry, { accessToken, recoveryPassword = "" } = {}) {
        return {
            sessionId: entry.sessionId,
            accessToken: normalizeAccessToken(accessToken, { required: true }),
            recoveryPassword: recoveryPassword
                ? normalizeRecoveryPassword(recoveryPassword, { required: true })
                : "",
            createdAt: entry.createdAt,
        };
    }

    /**
     * Clones one stored entry metadata so callers cannot mutate the store state.
     */
    cloneMetadata(entry) {
        return {
            sessionId: entry.sessionId,
            createdAt: entry.createdAt,
        };
    }
}

export { WhatsAppSessionAccessStore };
