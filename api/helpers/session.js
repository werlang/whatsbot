import { HttpError } from "./error.js";

const SESSION_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const ACCESS_TOKEN_PATTERN = /^[a-f0-9]{64}$/;
const RECOVERY_PASSWORD_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

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
 * Normalizes one session bearer token.
 */
function normalizeAccessToken(value, { required = false } = {}) {
    const rawValue = String(value ?? "").trim().toLowerCase();

    if (!rawValue) {
        if (required) {
            throw new HttpError(400, "session token is required.");
        }

        return "";
    }

    if (!ACCESS_TOKEN_PATTERN.test(rawValue)) {
        throw new HttpError(400, "session token must be a 64-character hexadecimal string.");
    }

    return rawValue;
}

/**
 * Normalizes one human-friendly recovery password.
 */
function normalizeRecoveryPassword(value, { required = false } = {}) {
    const rawValue = String(value ?? "")
        .trim()
        .toLowerCase()
        .replace(/[\s_]+/g, "-");

    if (!rawValue) {
        if (required) {
            throw new HttpError(400, "recoveryPassword is required.");
        }

        return "";
    }

    if (!RECOVERY_PASSWORD_PATTERN.test(rawValue) || rawValue.startsWith("-") || rawValue.endsWith("-") || rawValue.includes("--")) {
        throw new HttpError(400, "recoveryPassword must contain only letters, numbers, and single hyphens.");
    }

    return rawValue;
}

export { normalizeAccessToken, normalizeRecoveryPassword, normalizeSessionId };