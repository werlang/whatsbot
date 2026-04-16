import { Model } from "./model.js";
import { normalizeAccessPassword, normalizeSessionId } from "../helpers/session.js";

/**
 * Persists the mapping between app session ids and user-facing access passwords.
 */
class WhatsAppSessionAccess extends Model {
    static table = "whatsapp_session_access";
    static view = [
        "session_id",
        "access_password",
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
            accessPassword: normalizeAccessPassword(row.accessPassword || row.access_password, { required: true }),
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
            access_password: normalizeAccessPassword(payload.accessPassword, { required: true }),
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
     * Returns one access record by user-facing password.
     */
    static async findByPassword(accessPassword) {
        return this.get({ access_password: normalizeAccessPassword(accessPassword, { required: true }) });
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