import { requestApi } from "./helpers/api.js";
import { describeSession } from "./helpers/session.js";
import { TemplateVar } from "./helpers/template-var.js";
import { persistSessionId, readSessionIdFromUrl, writeSessionIdToUrl } from "./helpers/session-id.js";

const SESSION_REFRESH_INTERVAL_MS = 15000;

/**
 * Collects the DOM nodes used by the login page.
 */
function createElements() {
    return {
        createButton: document.querySelector("#create-session-button"),
        feedback: document.querySelector("#login-feedback"),
        sessionSecretDialog: document.querySelector("#session-secret-dialog"),
        sessionSecretValue: document.querySelector("[data-role=session-secret-value]"),
        sessionSecretCopy: document.querySelector("[data-role=session-secret-copy]"),
        sessionSecretSendNow: document.querySelector("[data-role=session-secret-send-now]"),
        sessionSecretClose: document.querySelector("[data-role=session-secret-close]"),
        sessionSecretStatus: document.querySelector("[data-role=session-secret-status]"),
        sessionStatus: document.querySelector("#session-status"),
        sessionConnection: document.querySelector("#session-connection"),
        sessionNote: document.querySelector("#session-note"),
        sessionLastEvent: document.querySelector("#session-last-event"),
        sessionClientInfo: document.querySelector("#session-client-info"),
        sessionQrPanel: document.querySelector("#session-qr-panel"),
        sessionQrImage: document.querySelector("#session-qr-image"),
        sessionId: document.querySelector("[data-role=session-id]"),
        sessionIdPanel: document.querySelector("[data-role=session-id-panel]"),
        schedulerLink: document.querySelector("[data-role=scheduler-link]"),
        year: document.querySelector("[data-role=year]"),
    };
}

/**
 * Copies one string into the clipboard.
 */
async function copyToClipboard(text) {
    if (!text) {
        return false;
    }

    if (globalThis.navigator?.clipboard?.writeText) {
        await globalThis.navigator.clipboard.writeText(text);
        return true;
    }

    const textArea = document.createElement("textarea");
    textArea.value = text;
    textArea.setAttribute("readonly", "true");
    textArea.style.position = "fixed";
    textArea.style.top = "-9999px";
    document.body.append(textArea);
    textArea.select();

    try {
        return document.execCommand("copy");
    } finally {
        textArea.remove();
    }
}

/**
 * Updates the UUID modal status line.
 */
function setSessionSecretStatus(elements, message, tone = "") {
    if (!elements.sessionSecretStatus) {
        return;
    }

    const text = typeof message === "string" ? message.trim() : "";
    elements.sessionSecretStatus.hidden = !text;
    elements.sessionSecretStatus.dataset.tone = text ? tone : "";
    elements.sessionSecretStatus.textContent = text;
}

/**
 * Shows the UUID modal with one session id.
 */
function openSessionSecretDialog(elements, sessionId) {
    if (!elements.sessionSecretDialog || !elements.sessionSecretValue) {
        return;
    }

    elements.sessionSecretValue.textContent = sessionId;
    setSessionSecretStatus(elements, "This UUID is the password for this session. Copy it now and keep it safe.", "info");

    if (typeof elements.sessionSecretDialog.showModal === "function") {
        elements.sessionSecretDialog.showModal();
    } else {
        elements.sessionSecretDialog.open = true;
    }

    if (elements.sessionSecretCopy) {
        elements.sessionSecretCopy.focus();
    }
}

/**
 * Closes the UUID modal.
 */
function closeSessionSecretDialog(elements) {
    if (!elements.sessionSecretDialog) {
        return;
    }

    if (typeof elements.sessionSecretDialog.close === "function") {
        elements.sessionSecretDialog.close();
        return;
    }

    elements.sessionSecretDialog.open = false;
}

/**
 * Opens the scheduler with one specific session id selected.
 */
function openSchedulerForSession(sessionId) {
    const normalizedSessionId = String(sessionId ?? "").trim();

    if (!normalizedSessionId) {
        return;
    }

    globalThis.location.assign(`/?sessionId=${encodeURIComponent(normalizedSessionId)}`);
}

/**
 * Renders one inline feedback box.
 */
function setFeedback(node, tone, message) {
    if (!node) {
        return;
    }

    const text = typeof message === "string" ? message.trim() : "";
    node.hidden = !text;
    node.dataset.tone = text ? tone : "";
    node.textContent = text;
}

/**
 * Applies one session description to the login page.
 */
function renderSessionState(elements, sessionId, description) {
    if (elements.sessionStatus) {
        elements.sessionStatus.textContent = description.label;
        elements.sessionStatus.dataset.tone = description.tone;
    }

    if (elements.sessionConnection) {
        elements.sessionConnection.textContent = description.connection;
    }

    if (elements.sessionNote) {
        elements.sessionNote.textContent = description.note;
    }

    if (elements.sessionLastEvent) {
        elements.sessionLastEvent.hidden = !description.lastEventLabel;
        elements.sessionLastEvent.textContent = description.lastEventLabel;
    }

    if (elements.sessionClientInfo) {
        elements.sessionClientInfo.hidden = !description.clientLabel;
        elements.sessionClientInfo.textContent = description.clientLabel;
    }

    if (elements.sessionQrPanel) {
        elements.sessionQrPanel.hidden = !description.showQr;
    }

    if (elements.sessionQrImage && description.showQr) {
        elements.sessionQrImage.src = description.qrCodeDataUrl;
    }

    if (elements.sessionIdPanel) {
        elements.sessionIdPanel.hidden = !sessionId;
    }

    if (elements.sessionId) {
        elements.sessionId.textContent = sessionId || "-";
    }

    if (elements.schedulerLink) {
        elements.schedulerLink.hidden = !sessionId;
        if (sessionId) {
            elements.schedulerLink.href = `/?sessionId=${encodeURIComponent(sessionId)}`;
        }
    }
}

/**
 * Loads one session state from the API.
 */
async function loadSessionState(elements, sessionId) {
    if (!sessionId) {
        return;
    }

    const response = await requestApi(`/whatsapp/sessions/${encodeURIComponent(sessionId)}`);

    if (!response.ok || !response.data?.session) {
        setFeedback(elements.feedback, "danger", response.message || "Could not load the WhatsApp session.");
        return;
    }

    renderSessionState(elements, sessionId, describeSession(response.data.session));
}

/**
 * Creates one new WhatsApp session through the API.
 */
async function createSession(elements) {
    if (!elements.createButton) {
        return "";
    }

    elements.createButton.disabled = true;
    setFeedback(elements.feedback, "info", "Creating WhatsApp session...");

    try {
        const response = await requestApi("/whatsapp/sessions", {
            method: "POST",
            body: {},
        });

        if (!response.ok || !response.data?.session?.sessionId) {
            setFeedback(elements.feedback, "danger", response.message || "Could not create the WhatsApp session.");
            return "";
        }

        const sessionId = response.data.session.sessionId;
        persistSessionId(sessionId);
        writeSessionIdToUrl(sessionId);
        openSessionSecretDialog(elements, sessionId);
        setFeedback(elements.feedback, "success", "WhatsApp session created. Copy the UUID shown in the modal, then scan the QR code when it appears.");
        return sessionId;
    } catch (error) {
        setFeedback(elements.feedback, "danger", error instanceof Error ? error.message : "Could not create the WhatsApp session.");
        return "";
    } finally {
        elements.createButton.disabled = false;
    }
}

/**
 * Boots the session-login page.
 */
function initLoginPage() {
    const elements = createElements();
    if (!elements.createButton || !elements.sessionStatus) {
        return;
    }

    if (elements.year) {
        elements.year.textContent = TemplateVar.get("year") || String(new Date().getFullYear());
    }

    let activeSessionId = readSessionIdFromUrl();

    if (activeSessionId) {
        persistSessionId(activeSessionId);
        loadSessionState(elements, activeSessionId);
    }

    globalThis.setInterval(function() {
        if (activeSessionId) {
            loadSessionState(elements, activeSessionId);
        }
    }, SESSION_REFRESH_INTERVAL_MS);

    if (elements.sessionSecretCopy) {
        elements.sessionSecretCopy.addEventListener("click", async function() {
            const sessionId = elements.sessionSecretValue?.textContent?.trim() || "";

            if (!sessionId) {
                return;
            }

            try {
                await copyToClipboard(sessionId);
                setSessionSecretStatus(elements, "UUID copied. Keep it safe before continuing.", "success");
            } catch {
                setSessionSecretStatus(elements, "Could not copy automatically. Select the UUID and copy it manually.", "warning");
            }
        });
    }

    if (elements.sessionSecretClose) {
        elements.sessionSecretClose.addEventListener("click", function() {
            closeSessionSecretDialog(elements);
        });
    }

    if (elements.sessionSecretSendNow) {
        elements.sessionSecretSendNow.addEventListener("click", function() {
            const sessionId = elements.sessionSecretValue?.textContent?.trim() || "";
            if (!sessionId) {
                return;
            }

            openSchedulerForSession(sessionId);
        });
    }

    if (elements.sessionSecretDialog) {
        elements.sessionSecretDialog.addEventListener("click", function(event) {
            if (event.target === elements.sessionSecretDialog) {
                closeSessionSecretDialog(elements);
            }
        });
    }

    elements.createButton.addEventListener("click", async function() {
        const createdSessionId = await createSession(elements);
        if (!createdSessionId) {
            return;
        }

        activeSessionId = createdSessionId;
        await loadSessionState(elements, activeSessionId);
    });
}

initLoginPage();