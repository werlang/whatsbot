const ACTIVE_SESSION_ID_STORAGE_KEY = "whatsbot.sessionId";
const ACTIVE_SESSION_PASSWORD_STORAGE_KEY = "whatsbot.sessionPassword";
const PENDING_SESSION_ID_STORAGE_KEY = "whatsbot.pendingSessionId";
const PENDING_SESSION_PASSWORD_STORAGE_KEY = "whatsbot.pendingSessionPassword";

/**
 * Normalizes one browser-stored session token.
 */
function normalizeStoredValue(value) {
    return typeof value === "string" ? value.trim() : "";
}

/**
 * Reads one trimmed localStorage value.
 */
function readStorageValue(key, storage = globalThis.localStorage) {
    try {
        return normalizeStoredValue(storage?.getItem(key));
    } catch {
        return "";
    }
}

/**
 * Writes or clears one trimmed localStorage value.
 */
function writeStorageValue(key, value, storage = globalThis.localStorage) {
    const normalizedValue = normalizeStoredValue(value);

    try {
        if (normalizedValue) {
            storage?.setItem(key, normalizedValue);
            return;
        }

        storage?.removeItem(key);
    } catch {}
}

/**
 * Reads one session id from the current URL path or query string.
 */
function readSessionIdFromUrl(locationObject = globalThis.location) {
    if (!locationObject?.href) {
        return "";
    }

    const url = new URL(locationObject.href);
    const pathMatch = url.pathname.match(/^\/session\/([^/]+)$/);

    if (pathMatch?.[1]) {
        try {
            return decodeURIComponent(pathMatch[1]);
        } catch {
            return pathMatch[1];
        }
    }

    return url.searchParams.get("sessionId") || "";
}

/**
 * Reads one stored session id from browser storage.
 */
function readStoredSessionId(storage = globalThis.localStorage) {
    return readStorageValue(ACTIVE_SESSION_ID_STORAGE_KEY, storage);
}

/**
 * Reads the active session password stored in the browser.
 */
function readStoredSessionPassword(storage = globalThis.localStorage) {
    return readStorageValue(ACTIVE_SESSION_PASSWORD_STORAGE_KEY, storage);
}

/**
 * Reads the active session access bundle.
 */
function readStoredSessionAccess(storage = globalThis.localStorage) {
    const sessionId = readStoredSessionId(storage);
    const accessPassword = readStoredSessionPassword(storage);

    if (!sessionId || !accessPassword) {
        return {
            sessionId: "",
            accessPassword: "",
        };
    }

    return {
        sessionId,
        accessPassword,
    };
}

/**
 * Persists one active session access bundle for later browser visits.
 */
function persistSessionAccess({ sessionId, accessPassword } = {}, storage = globalThis.localStorage) {
    const normalizedSessionId = normalizeStoredValue(sessionId);
    const normalizedAccessPassword = normalizeStoredValue(accessPassword);

    if (!normalizedSessionId || !normalizedAccessPassword) {
        return;
    }

    writeStorageValue(ACTIVE_SESSION_ID_STORAGE_KEY, normalizedSessionId, storage);
    writeStorageValue(ACTIVE_SESSION_PASSWORD_STORAGE_KEY, normalizedAccessPassword, storage);
}

/**
 * Clears the active session access bundle.
 */
function clearStoredSessionAccess(storage = globalThis.localStorage) {
    writeStorageValue(ACTIVE_SESSION_ID_STORAGE_KEY, "", storage);
    writeStorageValue(ACTIVE_SESSION_PASSWORD_STORAGE_KEY, "", storage);
}

/**
 * Reads the pending login session access bundle.
 */
function readPendingSessionAccess(storage = globalThis.localStorage) {
    const sessionId = readStorageValue(PENDING_SESSION_ID_STORAGE_KEY, storage);
    const accessPassword = readStorageValue(PENDING_SESSION_PASSWORD_STORAGE_KEY, storage);

    if (!sessionId || !accessPassword) {
        return {
            sessionId: "",
            accessPassword: "",
        };
    }

    return {
        sessionId,
        accessPassword,
    };
}

/**
 * Persists the pending login session access bundle.
 */
function persistPendingSessionAccess({ sessionId, accessPassword } = {}, storage = globalThis.localStorage) {
    const normalizedSessionId = normalizeStoredValue(sessionId);
    const normalizedAccessPassword = normalizeStoredValue(accessPassword);

    if (!normalizedSessionId || !normalizedAccessPassword) {
        return;
    }

    writeStorageValue(PENDING_SESSION_ID_STORAGE_KEY, normalizedSessionId, storage);
    writeStorageValue(PENDING_SESSION_PASSWORD_STORAGE_KEY, normalizedAccessPassword, storage);
}

/**
 * Clears the pending login session access bundle.
 */
function clearPendingSessionAccess(storage = globalThis.localStorage) {
    writeStorageValue(PENDING_SESSION_ID_STORAGE_KEY, "", storage);
    writeStorageValue(PENDING_SESSION_PASSWORD_STORAGE_KEY, "", storage);
}

/**
 * Promotes one pending session access bundle into the active login state.
 */
function activateSessionAccess({ sessionId, accessPassword } = {}, storage = globalThis.localStorage) {
    persistSessionAccess({ sessionId, accessPassword }, storage);
    clearPendingSessionAccess(storage);
}

/**
 * Builds the authenticated API headers for one session password.
 */
function buildSessionAccessHeaders(accessPassword) {
    const normalizedAccessPassword = normalizeStoredValue(accessPassword);
    return normalizedAccessPassword
        ? { "x-whatsbot-session-password": normalizedAccessPassword }
        : {};
}

export {
    activateSessionAccess,
    buildSessionAccessHeaders,
    clearPendingSessionAccess,
    clearStoredSessionAccess,
    persistPendingSessionAccess,
    persistSessionAccess,
    readSessionIdFromUrl,
    readStoredSessionId,
    readStoredSessionAccess,
    readStoredSessionPassword,
    readPendingSessionAccess,
};