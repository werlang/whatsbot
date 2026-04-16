import { readStoredSessionId } from "./helpers/session-id.js";

/**
 * Redirects the browser to the right entry point.
 */
function initRootGateway() {
    const sessionId = readStoredSessionId();
    const targetPath = sessionId
        ? `/session/${encodeURIComponent(sessionId)}`
        : "/login";

    globalThis.location.replace(targetPath);
}

initRootGateway();
