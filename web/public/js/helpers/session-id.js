const SESSION_STORAGE_KEY = "whatsbot.sessionId";

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
    try {
        return storage?.getItem(SESSION_STORAGE_KEY) || "";
    } catch {
        return "";
    }
}

/**
 * Persists one session id for later browser visits.
 */
function persistSessionId(sessionId, storage = globalThis.localStorage) {
    const normalizedSessionId = String(sessionId ?? "").trim();

    if (!normalizedSessionId) {
        return;
    }

    try {
        storage?.setItem(SESSION_STORAGE_KEY, normalizedSessionId);
    } catch {}
}

/**
 * Resolves the best active session id for the current browser context.
 */
function resolveActiveSessionId({ fallback = "main" } = {}) {
    const sessionId = readSessionIdFromUrl() || readStoredSessionId() || fallback;
    persistSessionId(sessionId);
    return sessionId;
}

/**
 * Rewrites the current URL so the active session id is bookmarkable.
 */
function writeSessionIdToUrl(sessionId, locationObject = globalThis.location, historyObject = globalThis.history) {
    const normalizedSessionId = String(sessionId ?? "").trim();

    if (!normalizedSessionId || !locationObject?.href || !historyObject?.replaceState) {
        return;
    }

    const url = new URL(locationObject.href);
    url.pathname = `/session/${encodeURIComponent(normalizedSessionId)}`;
    url.searchParams.delete("sessionId");
    historyObject.replaceState({}, "", url);
}

export {
    persistSessionId,
    readSessionIdFromUrl,
    readStoredSessionId,
    resolveActiveSessionId,
    writeSessionIdToUrl,
};