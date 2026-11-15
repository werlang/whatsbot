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
    const needsQrCode = Boolean(session.needsQrCode);
    const reconnectAttempt = Number.isFinite(Number(session.reconnectAttempt)) && Number(session.reconnectAttempt) > 0
        ? Number(session.reconnectAttempt)
        : 0;
    const nextReconnectAt = normalizeText(session.nextReconnectAt);

    let label = "Checking status";
    let tone = "info";
    let note = "You can still schedule future messages while the session finishes connecting.";
    let phase = "starting";

    if (session.ready) {
        label = "Ready";
        tone = "success";
        note = "WhatsApp is connected and scheduled messages can be delivered when they become due.";
        phase = "ready";
    } else if (session.hasQrCode) {
        label = "Pairing required";
        tone = "warning";
        note = "Scan the QR code below with WhatsApp to finish pairing. You can still schedule future messages now.";
        phase = "awaiting-qr";
    } else if (needsQrCode) {
        label = "New QR required";
        tone = "danger";
        note = lastError
            ? `${lastError} Pair again to generate a new QR code.`
            : "WhatsApp authentication expired. Pair again to generate a new QR code.";
        phase = "needs-qr";
    } else if (lastError) {
        label = "Connection error";
        tone = "danger";
        note = lastError;
        phase = "error";
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
            phase = "disconnected";
        } else if (status === "authenticating") {
            phase = "connecting";
        }
    }

    if (!session.ready && session.authenticated && !session.hasQrCode && !lastError && !needsQrCode) {
        note = "WhatsApp is authenticated and still connecting. You can keep scheduling future messages in the meantime.";
        phase = "connecting";
    }

    if (!session.ready && disconnectReason && !lastError && !needsQrCode) {
        note = "Session disconnected (" + humanizeSessionToken(disconnectReason) + "). Scheduled messages stay queued while it reconnects.";
        phase = "disconnected";
    }

    if (!session.ready && !session.hasQrCode && !lastError && !needsQrCode && phase === "starting" && connectionState) {
        phase = connectionState === "CONNECTED" ? "connecting" : phase;
    }

    let connection = "Waiting for session details.";
    if (loading && Number.isFinite(loading.percent) && !needsQrCode && phase !== "disconnected") {
        connection = "Loading " + loading.percent + "%";
        if (normalizeText(loading.message)) {
            connection += " · " + normalizeText(loading.message);
        }
    } else if (connectionState) {
        connection = humanizeSessionToken(connectionState);
    } else if (phase === "disconnected" && disconnectReason) {
        connection = "Disconnected · " + humanizeSessionToken(disconnectReason);
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
            clientLabel = parts.join(" · ");
        }
    }

    return {
        phase,
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
        needsQrCode,
        reconnectAttempt,
        nextReconnectAt,
    };
}
