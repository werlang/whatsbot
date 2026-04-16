import { Model } from "./model.js";
import { normalizeSessionId } from "../helpers/session.js";

/**
 * Persists the mapping between app session ids and user-facing access passwords.
 */
class WhatsAppSessionAccess extends Model {
    static table = "whatsapp_session_access";
    static view = [
        "session_id",
        "access_token_hash",
        "recovery_password_hash",
        "recovery_password_salt",
        "recovery_password_lookup",
        "created_at",
        "updated_at",
    ];

    /**
     * Normalizes one raw database row into the public session access shape.
     */
    static normalize(row) {
        if (!row) {
            return null;
        }

        return {
            sessionId: normalizeSessionId(row.sessionId || row.session_id, { required: true }),
            accessTokenHash: String(row.accessTokenHash || row.access_token_hash || "").trim().toLowerCase(),
            recoveryPasswordHash: String(row.recoveryPasswordHash || row.recovery_password_hash || "").trim().toLowerCase(),
            recoveryPasswordSalt: String(row.recoveryPasswordSalt || row.recovery_password_salt || "").trim().toLowerCase(),
            recoveryPasswordLookup: String(row.recoveryPasswordLookup || row.recovery_password_lookup || "").trim().toLowerCase(),
            createdAt: row.createdAt || row.created_at
                ? new Date(row.createdAt || row.created_at).toISOString()
                : null,
            updatedAt: row.updatedAt || row.updated_at
                ? new Date(row.updatedAt || row.updated_at).toISOString()
                : null,
        };
    }

    /**
     * Serializes one session access payload into database column names.
     */
    static serialize(payload = {}) {
        const createdAt = payload.createdAt ? new Date(payload.createdAt) : new Date();
        const updatedAt = payload.updatedAt ? new Date(payload.updatedAt) : createdAt;

        return {
            session_id: normalizeSessionId(payload.sessionId, { required: true }),
            access_token_hash: String(payload.accessTokenHash || "").trim().toLowerCase(),
            recovery_password_hash: String(payload.recoveryPasswordHash || "").trim().toLowerCase(),
            recovery_password_salt: String(payload.recoveryPasswordSalt || "").trim().toLowerCase(),
            recovery_password_lookup: String(payload.recoveryPasswordLookup || "").trim().toLowerCase(),
            created_at: this.driver.toDateTime(createdAt),
            updated_at: this.driver.toDateTime(updatedAt),
        };
    }

    /**
     * Returns one access record by session id.
     */
    static async findBySessionId(sessionId) {
        return this.get({ session_id: normalizeSessionId(sessionId, { required: true }) });
    }

    /**
     * Returns one access record by password lookup hash.
     */
    static async findByRecoveryPasswordLookup(recoveryPasswordLookup) {
        return this.get({ recovery_password_lookup: String(recoveryPasswordLookup || "").trim().toLowerCase() });
    }

    /**
     * Returns one access record by bearer-token hash.
     */
    static async findByAccessTokenHash(accessTokenHash) {
        return this.get({ access_token_hash: String(accessTokenHash || "").trim().toLowerCase() });
    }

    /**
     * Creates and returns one persisted session access record.
     */
    static async create(payload) {
        await this.insert(payload);
        return this.findBySessionId(payload.sessionId);
    }
}

export { WhatsAppSessionAccess };