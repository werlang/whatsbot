import { formatDateTimeForDisplay } from "./datetime.js";

/**
 * Normalizes unknown values into one trimmed string.
 */
function normalizeText(value) {
    return typeof value === "string" ? value.trim() : "";
}

/**
 * Humanizes one machine-friendly token.
 */
export function humanizeSessionToken(value) {
    const normalized = normalizeText(value);
    if (!normalized) {
        return "Unknown";
    }

    return normalized
        .replace(/[_-]+/g, " ")
        .toLowerCase()
        .replace(/\b\w/g, function(character) {
            return character.toUpperCase();
        });
}

/**
 * Formats one session timestamp for concise UI copy.
 */
export function formatSessionTimestamp(value, locale) {
    return formatDateTimeForDisplay(value, locale);
}

/**
 * Returns one friendly UI summary for the current WhatsApp session state.
 */
export function describeSession(session = {}, locale) {
    const loading = session.loading && typeof session.loading === "object" ? session.loading : null;
    const lastError = normalizeText(
        typeof session.lastError === "string"
            ? session.lastError
            : session.lastError && session.lastError.message,
    );
    const clientInfo = session.clientInfo && typeof session.clientInfo === "object" ? session.clientInfo : null;
    const status = normalizeText(session.status);
    const connectionState = normalizeText(session.connectionState);
    const disconnectReason = normalizeText(session.disconnectReason);

    let label = "Checking status";
    let tone = "info";
    let note = "You can still schedule future messages while the session finishes connecting.";

    if (session.ready) {
        label = "Ready";
        tone = "success";
        note = "WhatsApp is connected and scheduled messages can be delivered when they become due.";
    } else if (session.hasQrCode) {
        label = "Pairing required";
        tone = "warning";
        note = "Scan the QR code below with WhatsApp to finish pairing. You can still schedule future messages now.";
    } else if (lastError) {
        label = "Connection error";
        tone = "danger";
        note = lastError;
    } else if (status) {
        const statusLabels = {
            idle: "Starting",
            initializing: "Initializing",
            authenticating: "Authenticating",
            qr: "Waiting for QR scan",
            disconnected: "Disconnected",
        };

        label = statusLabels[status] || humanizeSessionToken(status);
        if (status === "disconnected") {
            tone = "warning";
        }
    }

    if (!session.ready && session.authenticated && !session.hasQrCode && !lastError) {
        note = "WhatsApp is authenticated and still connecting. You can keep scheduling future messages in the meantime.";
    }

    if (!session.ready && disconnectReason && !lastError) {
        note = "Session disconnected: " + humanizeSessionToken(disconnectReason) + ". You can still queue future messages.";
    }

    let connection = "Waiting for session details.";
    if (loading && Number.isFinite(loading.percent)) {
        connection = "Loading " + loading.percent + "%";
        if (normalizeText(loading.message)) {
            connection += " · " + normalizeText(loading.message);
        }
    } else if (connectionState) {
        connection = "Connection: " + humanizeSessionToken(connectionState);
    }

    let clientLabel = "";
    if (clientInfo) {
        const name = normalizeText(clientInfo.pushname || clientInfo.name || clientInfo.platform);
        const wid = clientInfo.wid && typeof clientInfo.wid === "object"
            ? normalizeText(clientInfo.wid.user || clientInfo.wid._serialized)
            : normalizeText(clientInfo.wid);
        const parts = [];
        if (name) {
            parts.push(name);
        }
        if (wid) {
            parts.push(wid);
        }
        if (parts.length > 0) {
            clientLabel = "Connected account: " + parts.join(" · ");
        }
    }

    return {
        label,
        tone,
        note,
        connection,
        showQr: Boolean(session.hasQrCode && normalizeText(session.qrCodeDataUrl)),
        qrCodeDataUrl: normalizeText(session.qrCodeDataUrl),
        lastEventLabel: session.lastEventAt
            ? "Last update: " + formatSessionTimestamp(session.lastEventAt, locale)
            : "",
        clientLabel,
    };
}
