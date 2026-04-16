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
const ACTIVE_PAIRING_REFRESH_INTERVAL_MS = 4000;
const CONNECTING_REFRESH_INTERVAL_MS = 2000;
const REDIRECT_DELAY_MS = 1200;

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
        sessionProgress: document.querySelector("[data-role=session-progress]"),
        sessionProgressEyebrow: document.querySelector("[data-role=session-progress-eyebrow]"),
        sessionProgressBody: document.querySelector("[data-role=session-progress-body]"),
        sessionProgressMeta: document.querySelector("[data-role=session-progress-meta]"),
        sessionProgressFill: document.querySelector("[data-role=session-progress-fill]"),
        sessionCheckNow: document.querySelector("[data-role=session-check-now]"),
        sessionReload: document.querySelector("[data-role=session-reload]"),
        onboardingSteps: [...document.querySelectorAll("[data-step]")],
        year: document.querySelector("[data-role=year]"),
    };
}

/**
 * Creates the transient browser state used by the login polling flow.
 */
function createLoginUiState() {
    return {
        isRefreshing: false,
        refreshTimerId: 0,
        countdownTimerId: 0,
        nextRefreshAt: 0,
        lastRefreshAt: 0,
        previousDescription: null,
        pairingDetected: false,
        redirectScheduled: false,
        redirectTimerId: 0,
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
        copy: sessionAccess?.sessionId ? (description.showQr || description.label === "Ready" ? "completed" : "active") : "pending",
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
 * Extracts the session id and access token from one API response.
 */
function readSessionAccessFromResponse(response) {
    const sessionId = String(response?.data?.session?.sessionId || "").trim();
    const accessToken = String(response?.data?.accessToken || "").trim();

    if (!sessionId || !accessToken) {
        return null;
    }

    return {
        sessionId,
        accessToken,
    };
}

/**
 * Reads the recovery password from one API response.
 */
function readRecoveryPasswordFromResponse(response) {
    return String(response?.data?.recoveryPassword || "").trim();
}

/**
 * Shows the password modal with one new recovery password.
 */
function openSessionSecretDialog(elements, recoveryPassword) {
    if (!elements.sessionSecretDialog || !elements.sessionSecretValue) {
        return;
    }

    elements.sessionSecretValue.textContent = recoveryPassword;
    setSessionSecretStatus(elements, "Copy and save this recovery password.", "info");

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
    if (!sessionAccess?.sessionId || !sessionAccess?.accessToken) {
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
 * Formats one refresh countdown in seconds.
 */
function formatCountdownLabel(targetTimestamp) {
    const remainingMs = Math.max(0, Number(targetTimestamp) - Date.now());
    const remainingSeconds = Math.max(1, Math.ceil(remainingMs / 1000));
    return `Checking again in ${remainingSeconds}s.`;
}

/**
 * Returns the polling interval that matches the current pairing phase.
 */
function getRefreshInterval(description = {}) {
    if (description.phase === "awaiting-qr") {
        return ACTIVE_PAIRING_REFRESH_INTERVAL_MS;
    }

    if (description.phase === "connecting") {
        return CONNECTING_REFRESH_INTERVAL_MS;
    }

    return SESSION_REFRESH_INTERVAL_MS;
}

/**
 * Renders one progress card that explains what the user should do next.
 */
function renderPairingGuidance(elements, description = {}, uiState, { hasSession = false } = {}) {
    if (!elements.sessionProgress) {
        return;
    }

    let eyebrow = "Waiting to start";
    let body = "Create a session to begin pairing. This page checks automatically and opens your workspace when WhatsApp is ready.";
    let progress = 8;

    if (description.phase === "awaiting-qr") {
        eyebrow = "Waiting for scan";
        body = "Open WhatsApp on your phone and scan the QR code shown below. Keep this page open while we watch for the scan.";
        progress = 38;
    } else if (description.phase === "connecting") {
        eyebrow = uiState.pairingDetected ? "Scan detected" : "Finishing setup";
        body = uiState.pairingDetected
            ? "The QR scan was detected. WhatsApp is finishing the connection now. Wait here and this page will open your workspace automatically."
            : "WhatsApp accepted the session and is still finishing setup. Wait a few seconds while we keep checking.";
        progress = 74;
    } else if (description.phase === "ready") {
        eyebrow = "Connected";
        body = "Pairing is complete. Opening your workspace now.";
        progress = 100;
    } else if (description.phase === "disconnected") {
        eyebrow = "Need another scan";
        body = "The session disconnected before it finished connecting. Wait for a fresh QR code or reload this page if nothing changes.";
        progress = 28;
    } else if (description.phase === "error") {
        eyebrow = "Need attention";
        body = "WhatsApp reported a connection problem. Use Check now to retry, or reload the page if the status stays the same.";
        progress = 20;
    } else if (hasSession) {
        eyebrow = "Preparing session";
        body = "The session exists and WhatsApp is still starting. Wait here and we will keep checking for the next pairing step.";
        progress = 18;
    }

    if (elements.sessionProgressEyebrow) {
        elements.sessionProgressEyebrow.textContent = eyebrow;
    }

    if (elements.sessionProgressBody) {
        elements.sessionProgressBody.textContent = body;
    }

    if (elements.sessionProgressFill) {
        elements.sessionProgressFill.style.width = `${progress}%`;
    }

    updatePairingGuidanceMeta(elements, uiState, { hasSession, isReady: description.phase === "ready" });
}

/**
 * Updates the progress-card meta line with the next polling action.
 */
function updatePairingGuidanceMeta(elements, uiState, { hasSession = false, isReady = false } = {}) {
    if (!elements.sessionProgressMeta) {
        return;
    }

    if (!hasSession) {
        elements.sessionProgressMeta.textContent = "Create a session to begin pairing.";
        return;
    }

    if (isReady) {
        elements.sessionProgressMeta.textContent = "Redirecting automatically.";
        return;
    }

    if (!uiState.nextRefreshAt) {
        elements.sessionProgressMeta.textContent = uiState.lastRefreshAt
            ? "Check now if you want to refresh immediately."
            : "Waiting for the first session update.";
        return;
    }

    elements.sessionProgressMeta.textContent = formatCountdownLabel(uiState.nextRefreshAt);
}

/**
 * Starts or restarts the short countdown shown in the pairing guidance card.
 */
function startGuidanceCountdown(elements, uiState, options = {}) {
    if (uiState.countdownTimerId) {
        globalThis.clearInterval(uiState.countdownTimerId);
    }

    updatePairingGuidanceMeta(elements, uiState, options);

    if (!uiState.nextRefreshAt) {
        uiState.countdownTimerId = 0;
        return;
    }

    uiState.countdownTimerId = globalThis.setInterval(function() {
        updatePairingGuidanceMeta(elements, uiState, options);

        if (Date.now() >= uiState.nextRefreshAt) {
            globalThis.clearInterval(uiState.countdownTimerId);
            uiState.countdownTimerId = 0;
        }
    }, 1000);
}

/**
 * Clears any active polling and countdown timers.
 */
function clearSessionRefresh(uiState) {
    if (uiState.refreshTimerId) {
        globalThis.clearTimeout(uiState.refreshTimerId);
        uiState.refreshTimerId = 0;
    }

    if (uiState.countdownTimerId) {
        globalThis.clearInterval(uiState.countdownTimerId);
        uiState.countdownTimerId = 0;
    }

    uiState.nextRefreshAt = 0;
}

/**
 * Schedules the next session refresh using the current session phase.
 */
function scheduleSessionRefresh(elements, sessionAccess, uiState, description) {
    clearSessionRefresh(uiState);

    if (!sessionAccess?.sessionId || !sessionAccess?.accessToken || description?.phase === "ready") {
        updatePairingGuidanceMeta(elements, uiState, {
            hasSession: Boolean(sessionAccess?.sessionId),
            isReady: description?.phase === "ready",
        });
        return;
    }

    const intervalMs = getRefreshInterval(description);
    uiState.nextRefreshAt = Date.now() + intervalMs;
    uiState.refreshTimerId = globalThis.setTimeout(function() {
        void refreshSessionState(elements, sessionAccess, uiState);
    }, intervalMs);

    startGuidanceCountdown(elements, uiState, {
        hasSession: true,
        isReady: false,
    });
}

/**
 * Loads one session state and updates the pairing UX around it.
 */
async function refreshSessionState(elements, sessionAccess, uiState, { redirectWhenReady = true, force = false } = {}) {
    if (!sessionAccess?.sessionId || !sessionAccess?.accessToken) {
        return null;
    }

    if (uiState.isRefreshing && !force) {
        return null;
    }

    uiState.isRefreshing = true;
    uiState.lastRefreshAt = Date.now();

    try {
        const session = await loadSessionState(elements, sessionAccess, { redirectWhenReady: false });
        if (!session) {
            clearSessionRefresh(uiState);
            renderPairingGuidance(elements, {}, uiState, { hasSession: true });
            return null;
        }

        const description = describeSession(session);
        const scanJustDetected = uiState.previousDescription?.phase === "awaiting-qr" && description.phase === "connecting";
        if (scanJustDetected) {
            uiState.pairingDetected = true;
            setFeedback(elements.feedback, "success", "QR scan detected. WhatsApp is finishing the connection now. Keep this page open.");
        } else if (description.phase === "awaiting-qr") {
            uiState.pairingDetected = false;
        }

        renderPairingGuidance(elements, description, uiState, { hasSession: true });
        uiState.previousDescription = description;

        if (description.phase === "ready" && redirectWhenReady && !uiState.redirectScheduled) {
            uiState.redirectScheduled = true;
            clearSessionRefresh(uiState);
            setFeedback(elements.feedback, "success", "Pairing complete. Opening your workspace...");
            uiState.redirectTimerId = globalThis.setTimeout(function() {
                openSchedulerForSession(sessionAccess, { replace: true });
            }, REDIRECT_DELAY_MS);
            return session;
        }

        scheduleSessionRefresh(elements, sessionAccess, uiState, description);
        return session;
    } finally {
        uiState.isRefreshing = false;
    }
}

/**
 * Loads one session state from the API using the session token.
 */
async function loadSessionState(elements, sessionAccess, { redirectWhenReady = true } = {}) {
    if (!sessionAccess?.sessionId || !sessionAccess?.accessToken) {
        return null;
    }

    const response = await requestApi(`/whatsapp/sessions/${encodeURIComponent(sessionAccess.sessionId)}`, {
        headers: buildSessionAccessHeaders(sessionAccess.accessToken),
    });

    console.debug("[WhatsBot] Login session refresh", {
        sessionId: sessionAccess.sessionId,
        ok: response.ok,
        session: response.data?.session || null,
    });

    if (response.status === 401) {
        clearPendingSessionAccess();
        setFeedback(elements.feedback, "danger", "That session token is not valid anymore.");
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
        const recoveryPassword = readRecoveryPasswordFromResponse(response);
        if (!response.ok || !sessionAccess || !recoveryPassword) {
            setFeedback(elements.feedback, "danger", response.message || "Could not create the WhatsApp session.");
            return null;
        }

        console.debug("[WhatsBot] Session created", {
            sessionId: sessionAccess.sessionId,
            hasAccessToken: Boolean(sessionAccess.accessToken),
        });

        persistPendingSessionAccess(sessionAccess);
        openSessionSecretDialog(elements, recoveryPassword);
        setFeedback(elements.feedback, "success", "Session created. Copy the recovery password, then scan the QR code.");
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
 * Restores one existing session from the pasted recovery password.
 */
async function loginWithRecoveryPassword(elements) {
    if (!elements.existingPasswordInput || !elements.existingPasswordButton) {
        return null;
    }

    const recoveryPassword = elements.existingPasswordInput.value.trim();
    if (!recoveryPassword) {
        setFeedback(elements.feedback, "danger", "Paste the recovery password first.");
        return null;
    }

    elements.existingPasswordButton.disabled = true;
    setFeedback(elements.feedback, "info", "Restoring session...");

    try {
        const response = await requestApi("/whatsapp/sessions/login", {
            method: "POST",
            body: {
                recoveryPassword,
            },
        });

        const sessionAccess = readSessionAccessFromResponse(response);
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
    const uiState = createLoginUiState();
    if (!elements.createButton || !elements.sessionStatus) {
        return;
    }

    if (elements.year) {
        elements.year.textContent = TemplateVar.get("year") || String(new Date().getFullYear());
    }

    let pendingSessionAccess = readPendingSessionAccess();
    renderOnboardingSteps(elements, pendingSessionAccess);
    renderPairingGuidance(elements, {}, uiState, {
        hasSession: Boolean(pendingSessionAccess.sessionId && pendingSessionAccess.accessToken),
    });

    if (pendingSessionAccess.sessionId && pendingSessionAccess.accessToken) {
        void refreshSessionState(elements, pendingSessionAccess, uiState);
    }

    if (elements.sessionSecretCopy) {
        elements.sessionSecretCopy.addEventListener("click", async function() {
            const recoveryPassword = elements.sessionSecretValue?.textContent?.trim() || "";

            if (!recoveryPassword) {
                return;
            }

            try {
                await copyToClipboard(recoveryPassword);
                setSessionSecretStatus(elements, "Recovery password copied. Keep it safe before continuing.", "success");
            } catch {
                setSessionSecretStatus(elements, "Could not copy automatically. Select the recovery password and copy it manually.", "warning");
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

    if (elements.sessionCheckNow) {
        elements.sessionCheckNow.addEventListener("click", function() {
            if (!pendingSessionAccess.sessionId || !pendingSessionAccess.accessToken) {
                setFeedback(elements.feedback, "info", "Create or restore a session first.");
                return;
            }

            setFeedback(elements.feedback, "info", "Checking session status now...");
            void refreshSessionState(elements, pendingSessionAccess, uiState, { force: true });
        });
    }

    if (elements.sessionReload) {
        elements.sessionReload.addEventListener("click", function() {
            globalThis.location.reload();
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
            const restoredSessionAccess = await loginWithRecoveryPassword(elements);
            if (!restoredSessionAccess) {
                return;
            }

            pendingSessionAccess = restoredSessionAccess;
            uiState.redirectScheduled = false;
            void globalThis.clearTimeout(uiState.redirectTimerId);
            await refreshSessionState(elements, pendingSessionAccess, uiState, { force: true });
        });
    }

    elements.createButton.addEventListener("click", async function() {
        const createdSessionAccess = await createSession(elements);
        if (!createdSessionAccess) {
            return;
        }

        pendingSessionAccess = createdSessionAccess;
        uiState.redirectScheduled = false;
        globalThis.clearTimeout(uiState.redirectTimerId);
        await refreshSessionState(elements, pendingSessionAccess, uiState, {
            redirectWhenReady: true,
            force: true,
        });
    });
}

initLoginPage();
