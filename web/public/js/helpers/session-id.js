const ACTIVE_SESSION_ID_STORAGE_KEY = "whatsbot.sessionId";
const ACTIVE_SESSION_TOKEN_STORAGE_KEY = "whatsbot.sessionToken";
const PENDING_SESSION_ID_STORAGE_KEY = "whatsbot.pendingSessionId";
const PENDING_SESSION_TOKEN_STORAGE_KEY = "whatsbot.pendingSessionToken";

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
 * Reads the active session token stored in the browser.
 */
function readStoredSessionToken(storage = globalThis.localStorage) {
    return readStorageValue(ACTIVE_SESSION_TOKEN_STORAGE_KEY, storage);
}

/**
 * Reads the active session access bundle.
 */
function readStoredSessionAccess(storage = globalThis.localStorage) {
    const sessionId = readStoredSessionId(storage);
    const accessToken = readStoredSessionToken(storage);

    if (!sessionId || !accessToken) {
        return {
            sessionId: "",
            accessToken: "",
        };
    }

    return {
        sessionId,
        accessToken,
    };
}

/**
 * Persists one active session access bundle for later browser visits.
 */
function persistSessionAccess({ sessionId, accessToken } = {}, storage = globalThis.localStorage) {
    const normalizedSessionId = normalizeStoredValue(sessionId);
    const normalizedAccessToken = normalizeStoredValue(accessToken);

    if (!normalizedSessionId || !normalizedAccessToken) {
        return;
    }

    writeStorageValue(ACTIVE_SESSION_ID_STORAGE_KEY, normalizedSessionId, storage);
    writeStorageValue(ACTIVE_SESSION_TOKEN_STORAGE_KEY, normalizedAccessToken, storage);
}

/**
 * Clears the active session access bundle.
 */
function clearStoredSessionAccess(storage = globalThis.localStorage) {
    writeStorageValue(ACTIVE_SESSION_ID_STORAGE_KEY, "", storage);
    writeStorageValue(ACTIVE_SESSION_TOKEN_STORAGE_KEY, "", storage);
}

/**
 * Reads the pending login session access bundle.
 */
function readPendingSessionAccess(storage = globalThis.localStorage) {
    const sessionId = readStorageValue(PENDING_SESSION_ID_STORAGE_KEY, storage);
    const accessToken = readStorageValue(PENDING_SESSION_TOKEN_STORAGE_KEY, storage);

    if (!sessionId || !accessToken) {
        return {
            sessionId: "",
            accessToken: "",
        };
    }

    return {
        sessionId,
        accessToken,
    };
}

/**
 * Persists the pending login session access bundle.
 */
function persistPendingSessionAccess({ sessionId, accessToken } = {}, storage = globalThis.localStorage) {
    const normalizedSessionId = normalizeStoredValue(sessionId);
    const normalizedAccessToken = normalizeStoredValue(accessToken);

    if (!normalizedSessionId || !normalizedAccessToken) {
        return;
    }

    writeStorageValue(PENDING_SESSION_ID_STORAGE_KEY, normalizedSessionId, storage);
    writeStorageValue(PENDING_SESSION_TOKEN_STORAGE_KEY, normalizedAccessToken, storage);
}

/**
 * Clears the pending login session access bundle.
 */
function clearPendingSessionAccess(storage = globalThis.localStorage) {
    writeStorageValue(PENDING_SESSION_ID_STORAGE_KEY, "", storage);
    writeStorageValue(PENDING_SESSION_TOKEN_STORAGE_KEY, "", storage);
}

/**
 * Promotes one pending session access bundle into the active login state.
 */
function activateSessionAccess({ sessionId, accessToken } = {}, storage = globalThis.localStorage) {
    persistSessionAccess({ sessionId, accessToken }, storage);
    clearPendingSessionAccess(storage);
}

/**
 * Builds the authenticated API headers for one session token.
 */
function buildSessionAccessHeaders(accessToken) {
    const normalizedAccessToken = normalizeStoredValue(accessToken);
    return normalizedAccessToken
        ? { "x-whatsbot-session-token": normalizedAccessToken }
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
    readStoredSessionToken,
    readPendingSessionAccess,
};