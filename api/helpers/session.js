import { HttpError } from "./error.js";

const SESSION_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Normalizes one app session identifier.
 */
function normalizeSessionId(value, { fallback = "main", required = false } = {}) {
    const rawValue = String(value ?? fallback ?? "").trim();

    if (!rawValue) {
        if (required) {
            throw new HttpError(400, "sessionId is required.");
        }

        return null;
    }

    if (!SESSION_ID_PATTERN.test(rawValue)) {
        throw new HttpError(400, "sessionId must contain only letters, numbers, underscores, or hyphens.");
    }

    return rawValue;
}

export { normalizeSessionId };