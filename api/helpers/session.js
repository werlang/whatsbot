import { HttpError } from "./error.js";

const SESSION_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const ACCESS_PASSWORD_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

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

/**
 * Normalizes one human-friendly session access password.
 */
function normalizeAccessPassword(value, { required = false } = {}) {
    const rawValue = String(value ?? "")
        .trim()
        .toLowerCase()
        .replace(/[\s_]+/g, "-");

    if (!rawValue) {
        if (required) {
            throw new HttpError(400, "password is required.");
        }

        return "";
    }

    if (!ACCESS_PASSWORD_PATTERN.test(rawValue) || rawValue.startsWith("-") || rawValue.endsWith("-") || rawValue.includes("--")) {
        throw new HttpError(400, "password must contain only letters, numbers, and single hyphens.");
    }

    return rawValue;
}

export { normalizeAccessPassword, normalizeSessionId };