import { requestApi } from "./helpers/api.js";
import { describeSession } from "./helpers/session.js";
import {
    activateSessionAccess,
    buildSessionAccessHeaders,
    clearPendingSessionAccess,
    persistPendingSessionAccess,
    readPendingSessionAccess,
} from "./helpers/session-id.js";
import { TemplateVar } from "./helpers/template-var.js";

const SESSION_REFRESH_INTERVAL_MS = 15000;

/**
 * Collects the DOM nodes used by the login page.
 */
function createElements() {
    return {
        createButton: document.querySelector("#create-session-button"),
        existingPasswordForm: document.querySelector("#login-existing-session-form"),
        existingPasswordInput: document.querySelector("#existing-session-password"),
        existingPasswordButton: document.querySelector("#login-existing-session-button"),
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
        onboardingSteps: [...document.querySelectorAll("[data-step]")],
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
 * Updates the onboarding steps with the current login progress.
 */
function renderOnboardingSteps(elements, sessionAccess, description = {}) {
    const states = {
        create: sessionAccess?.sessionId ? "completed" : "active",
        copy: sessionAccess?.accessPassword ? (description.showQr || description.label === "Ready" ? "completed" : "active") : "pending",
        scan: description.label === "Ready" ? "completed" : (sessionAccess?.sessionId ? "active" : "pending"),
    };

    for (const step of elements.onboardingSteps) {
        const key = step.dataset.step || "";
        step.dataset.state = states[key] || "pending";
    }
}

/**
 * Updates the password modal status line.
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
 * Extracts the session id and password from one API response.
 */
function readSessionAccessFromResponse(response, fallbackPassword = "") {
    const sessionId = String(response?.data?.session?.sessionId || "").trim();
    const accessPassword = String(response?.data?.accessPassword || fallbackPassword || "").trim();

    if (!sessionId || !accessPassword) {
        return null;
    }

    return {
        sessionId,
        accessPassword,
    };
}

/**
 * Shows the password modal with one new access password.
 */
function openSessionSecretDialog(elements, accessPassword) {
    if (!elements.sessionSecretDialog || !elements.sessionSecretValue) {
        return;
    }

    elements.sessionSecretValue.textContent = accessPassword;
    setSessionSecretStatus(elements, "Copy and save this password.", "info");

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
 * Closes the password modal.
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
 * Stores one active session and opens the scheduler entrypoint.
 */
function openSchedulerForSession(sessionAccess, { replace = false } = {}) {
    if (!sessionAccess?.sessionId || !sessionAccess?.accessPassword) {
        return;
    }

    activateSessionAccess(sessionAccess);
    if (replace) {
        globalThis.location.replace("/");
        return;
    }

    globalThis.location.assign("/");
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
    } else if (elements.sessionQrImage) {
        elements.sessionQrImage.removeAttribute("src");
    }

    if (elements.sessionIdPanel) {
        elements.sessionIdPanel.hidden = !sessionId;
    }

    if (elements.sessionId) {
        elements.sessionId.textContent = sessionId || "-";
    }

    if (elements.schedulerLink) {
        elements.schedulerLink.hidden = !sessionId;
        elements.schedulerLink.href = "/";
        if (sessionId) {
            elements.schedulerLink.textContent = description.label === "Ready"
                ? "Open your scheduling workspace"
                : "Open the scheduler for this session";
        }
    }
}

/**
 * Loads one session state from the API using the session password.
 */
async function loadSessionState(elements, sessionAccess, { redirectWhenReady = true } = {}) {
    if (!sessionAccess?.sessionId || !sessionAccess?.accessPassword) {
        return null;
    }

    const response = await requestApi(`/whatsapp/sessions/${encodeURIComponent(sessionAccess.sessionId)}`, {
        headers: buildSessionAccessHeaders(sessionAccess.accessPassword),
    });

    console.debug("[WhatsBot] Login session refresh", {
        sessionId: sessionAccess.sessionId,
        ok: response.ok,
        session: response.data?.session || null,
    });

    if (response.status === 401) {
        clearPendingSessionAccess();
        setFeedback(elements.feedback, "danger", "That session password is not valid anymore.");
        return null;
    }

    if (!response.ok || !response.data?.session) {
        setFeedback(elements.feedback, "danger", response.message || "Could not load the WhatsApp session.");
        return null;
    }

    const description = describeSession(response.data.session);
    renderSessionState(elements, sessionAccess.sessionId, description);
    renderOnboardingSteps(elements, sessionAccess, description);

    if (redirectWhenReady && response.data.session.ready) {
        openSchedulerForSession(sessionAccess, { replace: true });
    }

    return response.data.session;
}

/**
 * Creates one new WhatsApp session through the API.
 */
async function createSession(elements) {
    if (!elements.createButton) {
        return null;
    }

    elements.createButton.disabled = true;
    setFeedback(elements.feedback, "info", "Creating session...");

    try {
        const response = await requestApi("/whatsapp/sessions", {
            method: "POST",
            body: {},
        });

        const sessionAccess = readSessionAccessFromResponse(response);
        if (!response.ok || !sessionAccess) {
            setFeedback(elements.feedback, "danger", response.message || "Could not create the WhatsApp session.");
            return null;
        }

        console.debug("[WhatsBot] Session created", {
            sessionId: sessionAccess.sessionId,
            accessPassword: sessionAccess.accessPassword,
        });

        persistPendingSessionAccess(sessionAccess);
        openSessionSecretDialog(elements, sessionAccess.accessPassword);
        setFeedback(elements.feedback, "success", "Session created. Copy the password, then scan the QR code.");
        if (elements.existingPasswordInput) {
            elements.existingPasswordInput.value = "";
        }
        return sessionAccess;
    } catch (error) {
        setFeedback(elements.feedback, "danger", error instanceof Error ? error.message : "Could not create the WhatsApp session.");
        return null;
    } finally {
        elements.createButton.disabled = false;
    }
}

/**
 * Restores one existing session from the pasted password.
 */
async function loginWithPassword(elements) {
    if (!elements.existingPasswordInput || !elements.existingPasswordButton) {
        return null;
    }

    const password = elements.existingPasswordInput.value.trim();
    if (!password) {
        setFeedback(elements.feedback, "danger", "Paste the session password first.");
        return null;
    }

    elements.existingPasswordButton.disabled = true;
    setFeedback(elements.feedback, "info", "Restoring session...");

    try {
        const response = await requestApi("/whatsapp/sessions/login", {
            method: "POST",
            body: {
                password,
            },
        });

        const sessionAccess = readSessionAccessFromResponse(response, password);
        if (!response.ok || !sessionAccess) {
            setFeedback(elements.feedback, "danger", response.message || "Could not restore the WhatsApp session.");
            return null;
        }

        console.debug("[WhatsBot] Session restored", {
            sessionId: sessionAccess.sessionId,
        });

        persistPendingSessionAccess(sessionAccess);
        elements.existingPasswordInput.value = "";
        setFeedback(elements.feedback, "success", "Session restored.");
        return sessionAccess;
    } catch (error) {
        setFeedback(elements.feedback, "danger", error instanceof Error ? error.message : "Could not restore the WhatsApp session.");
        return null;
    } finally {
        elements.existingPasswordButton.disabled = false;
    }
}

/**
 * Boots the session login page.
 */
function initLoginPage() {
    const elements = createElements();
    if (!elements.createButton || !elements.sessionStatus) {
        return;
    }

    if (elements.year) {
        elements.year.textContent = TemplateVar.get("year") || String(new Date().getFullYear());
    }

    let pendingSessionAccess = readPendingSessionAccess();
    renderOnboardingSteps(elements, pendingSessionAccess);

    if (pendingSessionAccess.sessionId && pendingSessionAccess.accessPassword) {
        loadSessionState(elements, pendingSessionAccess);
    }

    globalThis.setInterval(function() {
        if (pendingSessionAccess.sessionId && pendingSessionAccess.accessPassword) {
            loadSessionState(elements, pendingSessionAccess);
        }
    }, SESSION_REFRESH_INTERVAL_MS);

    if (elements.sessionSecretCopy) {
        elements.sessionSecretCopy.addEventListener("click", async function() {
            const accessPassword = elements.sessionSecretValue?.textContent?.trim() || "";

            if (!accessPassword) {
                return;
            }

            try {
                await copyToClipboard(accessPassword);
                setSessionSecretStatus(elements, "Password copied. Keep it safe before continuing.", "success");
            } catch {
                setSessionSecretStatus(elements, "Could not copy automatically. Select the password and copy it manually.", "warning");
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
            openSchedulerForSession(pendingSessionAccess);
        });
    }

    if (elements.schedulerLink) {
        elements.schedulerLink.addEventListener("click", function(event) {
            event.preventDefault();
            openSchedulerForSession(pendingSessionAccess);
        });
    }

    if (elements.sessionSecretDialog) {
        elements.sessionSecretDialog.addEventListener("click", function(event) {
            if (event.target === elements.sessionSecretDialog) {
                closeSessionSecretDialog(elements);
            }
        });
    }

    if (elements.existingPasswordForm) {
        elements.existingPasswordForm.addEventListener("submit", async function(event) {
            event.preventDefault();
            const restoredSessionAccess = await loginWithPassword(elements);
            if (!restoredSessionAccess) {
                return;
            }

            pendingSessionAccess = restoredSessionAccess;
            await loadSessionState(elements, pendingSessionAccess);
        });
    }

    elements.createButton.addEventListener("click", async function() {
        const createdSessionAccess = await createSession(elements);
        if (!createdSessionAccess) {
            return;
        }

        pendingSessionAccess = createdSessionAccess;
        await loadSessionState(elements, pendingSessionAccess, { redirectWhenReady: false });
    });
}

initLoginPage();
