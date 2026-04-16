import { readStoredSessionAccess } from "./helpers/session-id.js";

/**
 * Redirects the browser to the right entry point.
 */
function initRootGateway() {
    const sessionAccess = readStoredSessionAccess();
    const targetPath = sessionAccess.sessionId && sessionAccess.accessToken
        ? `/session/${encodeURIComponent(sessionAccess.sessionId)}`
        : "/login";

    globalThis.location.replace(targetPath);
}

initRootGateway();
