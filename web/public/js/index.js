import { TemplateVar } from "./helpers/template-var.js";
import { requestApi } from "./helpers/api.js";
import {
    createDefaultScheduledDateTime,
    convertDateTimeLocalToOffsetIso,
    formatDateTimeForDisplay,
    formatIsoForDisplay,
    getCurrentTimezoneLabel,
    toDateTimeLocalValue,
} from "./helpers/datetime.js";
import {
    buildRecipientChoiceValue,
    readRecipientDirectory,
    resolveScheduledMessageTarget,
} from "./helpers/recipient.js";
import { describeSession } from "./helpers/session.js";
import {
    buildSessionAccessHeaders,
    clearStoredSessionAccess,
    readSessionIdFromUrl,
    readStoredSessionAccess,
} from "./helpers/session-id.js";

const SESSION_REFRESH_INTERVAL_MS = 15000;
const ACTIVE_PAIRING_REFRESH_INTERVAL_MS = 4000;
const CONNECTING_REFRESH_INTERVAL_MS = 2000;

/**
 * Collects the DOM nodes used by the scheduler page.
 */
function createElements() {
    return {
        form: document.querySelector("#schedule-form"),
        recipientEntry: document.querySelector("#recipient-entry"),
        recipientDirectory: document.querySelector("#recipient-directory"),
        recipientPicker: document.querySelector("#recipient-picker"),
        recipientDirectoryStatus: document.querySelector("#recipient-directory-status"),
        phoneNumber: document.querySelector("#phone-number"),
        message: document.querySelector("#message"),
        scheduledFor: document.querySelector("#scheduled-for"),
        submitButton: document.querySelector("#schedule-submit"),
        formFeedback: document.querySelector("#form-feedback"),
        sessionStatus: document.querySelector("#session-status"),
        sessionConnection: document.querySelector("#session-connection"),
        sessionNote: document.querySelector("#session-note"),
        sessionLastEvent: document.querySelector("#session-last-event"),
        sessionClientInfo: document.querySelector("#session-client-info"),
        sessionQrPanel: document.querySelector("#session-qr-panel"),
        sessionQrImage: document.querySelector("#session-qr-image"),
        sessionProgress: document.querySelector("[data-role=session-progress]"),
        sessionProgressEyebrow: document.querySelector("[data-role=session-progress-eyebrow]"),
        sessionProgressBody: document.querySelector("[data-role=session-progress-body]"),
        sessionProgressMeta: document.querySelector("[data-role=session-progress-meta]"),
        sessionProgressFill: document.querySelector("[data-role=session-progress-fill]"),
        sessionCheckNow: document.querySelector("[data-role=session-check-now]"),
        schedulePreview: document.querySelector("[data-role=schedule-preview]"),
        messageCounter: document.querySelector("[data-role=message-counter]"),
        timezoneLabels: [...document.querySelectorAll("[data-role=timezone-label]")],
        activeSessionId: document.querySelector("[data-role=active-session-id]"),
        schedulePresetButtons: [...document.querySelectorAll("[data-role=schedule-preset]")],
        year: document.querySelector("[data-role=year]"),
        currentSession: null,
        recipientLabelByValue: new Map(),
        recipientValueByLabel: new Map(),
        uiState: {
            isRefreshingSession: false,
            refreshTimerId: 0,
            countdownTimerId: 0,
            nextRefreshAt: 0,
            lastRefreshAt: 0,
            pairingDetected: false,
            previousDescription: null,
        },
    };
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
 * Returns the best response message available.
 */
function readResponseMessage(response, fallbackMessage) {
    const message = typeof response?.message === "string"
        ? response.message.trim()
        : "";

    return message || fallbackMessage;
}

/**
 * Renders the latest synced contacts and groups into the recipient picker.
 */
function renderRecipientDirectory(elements, session) {
    if (!elements.recipientPicker || !elements.recipientDirectory || !elements.recipientEntry) {
        return;
    }

    elements.currentSession = session;
    const directory = readRecipientDirectory(session);
    const totalRecipients = directory.contacts.length + directory.groups.length;

    renderRecipientAutocomplete(elements, [
        ...directory.contacts,
        ...directory.groups,
    ], {
        sessionReady: Boolean(session?.ready),
        totalRecipients,
    });

    if (!elements.recipientDirectoryStatus) {
        return;
    }

    if (!session?.ready) {
        elements.recipientDirectoryStatus.textContent = "Pair this session to load your WhatsApp contacts and groups. You can still type a number manually.";
        return;
    }

    if (totalRecipients === 0) {
        elements.recipientDirectoryStatus.textContent = "No synced contacts or groups were found yet. You can still type a number manually.";
        return;
    }

    const contactsLabel = formatRecipientCount(directory.contacts.length, "contact");
    const groupsLabel = formatRecipientCount(directory.groups.length, "group");

    elements.recipientDirectoryStatus.textContent = `Synced ${contactsLabel} and ${groupsLabel}. Start typing a name, number, or group, or enter a number manually.`;
}

/**
 * Renders one searchable recipient directory backed by native suggestions.
 */
function renderRecipientAutocomplete(elements, entries, { sessionReady = false, totalRecipients = 0 } = {}) {
    if (!elements.recipientDirectory || !elements.recipientEntry || !elements.recipientPicker) {
        return;
    }

    const previousValue = elements.recipientPicker.value;
    const previousLabel = elements.recipientLabelByValue.get(previousValue) || String(elements.recipientEntry.value ?? "").trim();

    elements.recipientDirectory.replaceChildren();
    elements.recipientLabelByValue = new Map();
    elements.recipientValueByLabel = new Map();

    for (const entry of Array.isArray(entries) ? entries : []) {
        const option = document.createElement("option");
        const optionLabel = formatRecipientOptionLabel(entry);

        option.value = optionLabel;
        elements.recipientDirectory.append(option);
        elements.recipientLabelByValue.set(buildRecipientChoiceValue(entry), optionLabel);
        elements.recipientValueByLabel.set(optionLabel, buildRecipientChoiceValue(entry));
    }

    elements.recipientEntry.disabled = totalRecipients === 0;
    elements.recipientEntry.placeholder = totalRecipients > 0
        ? "Start typing a name, number, or group"
        : (sessionReady
            ? "No synced contacts or groups found yet"
            : "Pair this session to load contacts and groups");

    if (previousValue && elements.recipientLabelByValue.has(previousValue)) {
        elements.recipientEntry.value = elements.recipientLabelByValue.get(previousValue);
        elements.recipientPicker.value = previousValue;
        return;
    }

    if (previousLabel && elements.recipientValueByLabel.has(previousLabel)) {
        elements.recipientEntry.value = previousLabel;
        elements.recipientPicker.value = elements.recipientValueByLabel.get(previousLabel);
        return;
    }

    if (totalRecipients === 0) {
        elements.recipientEntry.value = "";
    }

    syncRecipientSelection(elements);
}

/**
 * Formats one recipient entry for the autocomplete suggestions.
 */
function formatRecipientOptionLabel(entry) {
    if (entry?.phoneNumber) {
        return `${entry.label} · ${entry.phoneNumber}`;
    }

    return `${entry?.label || "Unknown"} · Group`;
}

/**
 * Synchronizes the hidden selected recipient value with the visible entry field.
 */
function syncRecipientSelection(elements) {
    if (!elements.recipientEntry || !elements.recipientPicker) {
        return;
    }

    const visibleLabel = String(elements.recipientEntry.value ?? "").trim();
    elements.recipientPicker.value = elements.recipientValueByLabel.get(visibleLabel) || "";
}

/**
 * Formats one recipient count for concise helper copy.
 */
function formatRecipientCount(count, label) {
    return `${count} ${label}${count === 1 ? "" : "s"}`;
}

/**
 * Formats one datetime-local value into concise preview text.
 */
function formatScheduledPreview(value) {
    return formatDateTimeForDisplay(value);
}

/**
 * Returns a friendly recipient label for the live preview.
 */
function readPreviewRecipient(elements) {
    const selectedValue = elements.recipientPicker?.value || "";
    if (selectedValue) {
        return elements.recipientLabelByValue.get(selectedValue) || String(elements.recipientEntry?.value ?? "").trim();
    }

    const phoneNumber = String(elements.phoneNumber?.value ?? "").trim();
    if (phoneNumber) {
        return phoneNumber;
    }

    return "";
}

/**
 * Updates the character counter beside the message field.
 */
function renderMessageCounter(elements) {
    if (!elements.messageCounter) {
        return;
    }

    const length = String(elements.message?.value ?? "").trim().length;
    elements.messageCounter.textContent = `${length} character${length === 1 ? "" : "s"}`;
}

/**
 * Renders one non-technical delivery preview.
 */
function renderSchedulePreview(elements) {
    if (!elements.schedulePreview) {
        return;
    }

    const recipient = readPreviewRecipient(elements);
    const scheduledFor = formatScheduledPreview(elements.scheduledFor?.value);
    const timezone = elements.timezoneLabels[0]?.textContent?.trim() || getCurrentTimezoneLabel();
    const message = String(elements.message?.value ?? "").trim();

    if (!recipient && !scheduledFor && !message) {
        elements.schedulePreview.textContent = "Preview appears here.";
        return;
    }

    if (!recipient || !scheduledFor || !message) {
        elements.schedulePreview.textContent = "Complete the fields to preview.";
        return;
    }

    const previewMessage = message.length > 110
        ? `${message.slice(0, 107)}...`
        : message;

    elements.schedulePreview.textContent = `Sends "${previewMessage}" to ${recipient} on ${scheduledFor} (${timezone}).`;
}

/**
 * Updates the live helper text around the form.
 */
function renderFormEnhancements(elements) {
    renderMessageCounter(elements);
    renderSchedulePreview(elements);
}

/**
 * Computes one datetime-local value from a quick preset id.
 */
function buildPresetDateTimeValue(preset) {
    const now = new Date();
    const scheduled = new Date(now.getTime());

    if (preset === "15-minutes") {
        scheduled.setSeconds(0, 0);
        scheduled.setMinutes(scheduled.getMinutes() + 15);
        return toDateTimeLocalValue(scheduled);
    }

    if (preset === "tonight") {
        scheduled.setHours(18, 0, 0, 0);
        if (scheduled.getTime() <= now.getTime()) {
            scheduled.setDate(scheduled.getDate() + 1);
        }
        return toDateTimeLocalValue(scheduled);
    }

    if (preset === "tomorrow-morning") {
        scheduled.setDate(scheduled.getDate() + 1);
        scheduled.setHours(9, 0, 0, 0);
        return toDateTimeLocalValue(scheduled);
    }

    return "";
}

/**
 * Marks the active quick preset button for the current time choice.
 */
function setActivePreset(elements, activePreset) {
    for (const button of elements.schedulePresetButtons) {
        button.dataset.active = button.dataset.preset === activePreset ? "true" : "false";
    }
}

/**
 * Wires up live preview interactions on the scheduler form.
 */
function bindInteractiveFormHelpers(elements) {
    const rerender = function() {
        setActivePreset(elements, "");
        renderFormEnhancements(elements);
    };

    elements.recipientEntry?.addEventListener("input", function() {
        syncRecipientSelection(elements);
        rerender();
    });
    elements.recipientEntry?.addEventListener("change", function() {
        syncRecipientSelection(elements);
        renderFormEnhancements(elements);
    });
    elements.phoneNumber?.addEventListener("input", rerender);
    elements.message?.addEventListener("input", renderFormEnhancements.bind(null, elements));
    elements.scheduledFor?.addEventListener("input", rerender);

    for (const button of elements.schedulePresetButtons) {
        button.addEventListener("click", function() {
            const nextValue = buildPresetDateTimeValue(button.dataset.preset || "");
            if (!elements.scheduledFor || !nextValue) {
                return;
            }

            elements.scheduledFor.value = nextValue;
            setActivePreset(elements, button.dataset.preset || "");
            renderFormEnhancements(elements);
        });
    }
}

/**
 * Applies the initial browser-local scheduling hints.
 */
function hydrateFormDefaults(elements, sessionId) {
    if (elements.year) {
        elements.year.textContent = TemplateVar.get("year") || String(new Date().getFullYear());
    }

    if (elements.activeSessionId) {
        elements.activeSessionId.textContent = sessionId;
    }

    if (elements.timezoneLabels.length > 0) {
        const timezoneLabel = getCurrentTimezoneLabel();
        for (const node of elements.timezoneLabels) {
            node.textContent = timezoneLabel;
        }
    }

    if (elements.scheduledFor) {
        elements.scheduledFor.min = toDateTimeLocalValue(new Date());
        if (!elements.scheduledFor.value) {
            elements.scheduledFor.value = createDefaultScheduledDateTime();
        }
    }

    renderFormEnhancements(elements);
}

/**
 * Renders the latest WhatsApp session summary on the page.
 */
function renderSessionState(elements, description) {
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
}

/**
 * Returns the polling interval that matches the current session phase.
 */
function getSessionRefreshInterval(description = {}) {
    if (description.phase === "awaiting-qr") {
        return ACTIVE_PAIRING_REFRESH_INTERVAL_MS;
    }

    if (description.phase === "connecting") {
        return CONNECTING_REFRESH_INTERVAL_MS;
    }

    return SESSION_REFRESH_INTERVAL_MS;
}

/**
 * Formats the time until the next automatic scheduler refresh.
 */
function formatRefreshCountdown(targetTimestamp) {
    const remainingMs = Math.max(0, Number(targetTimestamp) - Date.now());
    const remainingSeconds = Math.max(1, Math.ceil(remainingMs / 1000));
    return `Checking again in ${remainingSeconds}s.`;
}

/**
 * Updates the session progress meta line.
 */
function updateSessionProgressMeta(elements) {
    if (!elements.sessionProgressMeta) {
        return;
    }

    const uiState = elements.uiState;
    if (!uiState.nextRefreshAt) {
        elements.sessionProgressMeta.textContent = uiState.lastRefreshAt
            ? "Use Check now if you want an immediate refresh."
            : "Loading the latest WhatsApp state.";
        return;
    }

    elements.sessionProgressMeta.textContent = formatRefreshCountdown(uiState.nextRefreshAt);
}

/**
 * Starts the visible session refresh countdown.
 */
function startSessionCountdown(elements) {
    const uiState = elements.uiState;

    if (uiState.countdownTimerId) {
        globalThis.clearInterval(uiState.countdownTimerId);
    }

    updateSessionProgressMeta(elements);

    if (!uiState.nextRefreshAt) {
        uiState.countdownTimerId = 0;
        return;
    }

    uiState.countdownTimerId = globalThis.setInterval(function() {
        updateSessionProgressMeta(elements);

        if (Date.now() >= uiState.nextRefreshAt) {
            globalThis.clearInterval(uiState.countdownTimerId);
            uiState.countdownTimerId = 0;
        }
    }, 1000);
}

/**
 * Clears any active session refresh timers.
 */
function clearSessionRefresh(elements) {
    const uiState = elements.uiState;

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
 * Renders one action-oriented session progress card for the scheduler workspace.
 */
function renderSessionProgress(elements, description = {}) {
    if (!elements.sessionProgress) {
        return;
    }

    const uiState = elements.uiState;
    let eyebrow = "Preparing workspace";
    let body = "This workspace keeps checking the session automatically while you can still prepare or queue future messages.";
    let progress = 16;

    if (description.phase === "awaiting-qr") {
        eyebrow = "Waiting for scan";
        body = "Scan the QR code below with WhatsApp on your phone. You can already write the message and choose the delivery time while this session finishes pairing.";
        progress = 38;
    } else if (description.phase === "connecting") {
        eyebrow = uiState.pairingDetected ? "Scan detected" : "Finishing setup";
        body = uiState.pairingDetected
            ? "The QR scan was detected. WhatsApp is finishing the connection now. Keep this page open and the session tools will update automatically."
            : "WhatsApp accepted the session and is still loading chats. You can keep preparing messages while we continue checking.";
        progress = 74;
    } else if (description.phase === "ready") {
        eyebrow = "Session ready";
        body = "WhatsApp is connected. Contacts, groups, and scheduled deliveries should now work normally.";
        progress = 100;
    } else if (description.phase === "disconnected") {
        eyebrow = "Connection interrupted";
        body = "This session disconnected. Wait for a fresh QR code, or use Pair another phone if you need to restart the pairing flow.";
        progress = 24;
    } else if (description.phase === "error") {
        eyebrow = "Need attention";
        body = "The session could not be refreshed right now. Use Check now to retry, or reopen the pairing page if the problem continues.";
        progress = 20;
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

    updateSessionProgressMeta(elements);
}

/**
 * Plans the next automatic refresh of the workspace session state.
 */
function scheduleSessionRefresh(elements, sessionAccess, description = {}) {
    clearSessionRefresh(elements);

    const intervalMs = getSessionRefreshInterval(description);
    elements.uiState.nextRefreshAt = Date.now() + intervalMs;
    elements.uiState.refreshTimerId = globalThis.setTimeout(function() {
        void refreshSessionState(elements, sessionAccess);
    }, intervalMs);

    startSessionCountdown(elements);
}

/**
 * Loads the latest WhatsApp session state from the API and updates scheduler guidance.
 */
async function refreshSessionState(elements, sessionAccess, { force = false } = {}) {
    const uiState = elements.uiState;

    if (uiState.isRefreshingSession && !force) {
        return;
    }

    uiState.isRefreshingSession = true;
    uiState.lastRefreshAt = Date.now();

    try {
        const response = await requestApi(`/whatsapp/session?sessionId=${encodeURIComponent(sessionAccess.sessionId)}`, {
            headers: buildSessionAccessHeaders(sessionAccess.accessToken),
        });

        console.debug("[WhatsBot] Scheduler session refresh", {
            sessionId: sessionAccess.sessionId,
            ok: response.ok,
            session: response.data?.session || null,
        });

        if (response.status === 401) {
            clearStoredSessionAccess();
            globalThis.location.replace("/login");
            return;
        }

        if (!response.ok || !response.data || !response.data.session) {
            clearSessionRefresh(elements);
            renderSessionState(elements, {
                label: "Unavailable",
                tone: "danger",
                connection: "Could not load the current session state.",
                note: "Check whether the API service is reachable. You can still try scheduling future messages after the API reconnects.",
                lastEventLabel: "",
                clientLabel: "",
                showQr: false,
                qrCodeDataUrl: "",
            });
            renderSessionProgress(elements, { phase: "error" });
            renderRecipientDirectory(elements, null);
            return;
        }

        const description = describeSession(response.data.session);
        const scanJustDetected = uiState.previousDescription?.phase === "awaiting-qr" && description.phase === "connecting";
        if (scanJustDetected) {
            uiState.pairingDetected = true;
            setFeedback(elements.formFeedback, "info", "QR scan detected. WhatsApp is finishing the connection while you stay in this workspace.");
        } else if (description.phase === "awaiting-qr") {
            uiState.pairingDetected = false;
        }

        renderSessionState(elements, description);
        renderSessionProgress(elements, description);
        renderRecipientDirectory(elements, response.data.session);
        renderFormEnhancements(elements);

        uiState.previousDescription = description;
        scheduleSessionRefresh(elements, sessionAccess, description);
    } finally {
        uiState.isRefreshingSession = false;
    }
}

/**
 * Schedules one message through POST /messages.
 */
async function submitSchedule(event, elements, sessionAccess) {
    event.preventDefault();

    if (!elements.form || !elements.submitButton) {
        return;
    }

    setFeedback(elements.formFeedback, "info", "Scheduling message...");
    elements.submitButton.disabled = true;

    try {
        const targetPayload = resolveScheduledMessageTarget({
            selectedRecipientValue: elements.recipientPicker?.value,
            phoneNumber: elements.phoneNumber?.value,
        });
        const response = await requestApi("/messages", {
            method: "POST",
            headers: buildSessionAccessHeaders(sessionAccess.accessToken),
            body: {
                sessionId: sessionAccess.sessionId,
                ...targetPayload,
                message: elements.message?.value.trim(),
                scheduledFor: convertDateTimeLocalToOffsetIso(elements.scheduledFor?.value),
            },
        });

        if (response.status === 401) {
            clearStoredSessionAccess();
            globalThis.location.replace("/login");
            return;
        }

        if (!response.ok) {
            setFeedback(elements.formFeedback, "danger", readResponseMessage(response, "Could not schedule the WhatsApp message."));
            return;
        }

        console.debug("[WhatsBot] Message scheduled", {
            sessionId: sessionAccess.sessionId,
            targetPayload,
            scheduledMessage: response.data?.scheduledMessage || null,
        });

        const scheduledMessage = response.data && response.data.scheduledMessage ? response.data.scheduledMessage : null;
        let successMessage = "Message scheduled successfully.";
        if (scheduledMessage && scheduledMessage.scheduledFor) {
            successMessage += " Planned for " + formatIsoForDisplay(scheduledMessage.scheduledFor) + ".";
        }

        setFeedback(elements.formFeedback, "success", successMessage);

        if (elements.message) {
            elements.message.value = "";
        }
        if (elements.scheduledFor) {
            elements.scheduledFor.value = createDefaultScheduledDateTime();
        }
        setActivePreset(elements, "");
        renderFormEnhancements(elements);
    } catch (error) {
        setFeedback(
            elements.formFeedback,
            "danger",
            error instanceof Error && error.message
                ? error.message
                : "Could not schedule the WhatsApp message.",
        );
    } finally {
        elements.submitButton.disabled = false;
    }
}

/**
 * Boots the simple scheduler page.
 */
function initSchedulerPage() {
    const elements = createElements();
    if (!elements.form) {
        return;
    }

    const routeSessionId = readSessionIdFromUrl();
    const activeSessionAccess = readStoredSessionAccess();

    if (!activeSessionAccess.sessionId || !activeSessionAccess.accessToken) {
        globalThis.location.replace("/login");
        return;
    }

    if (!routeSessionId || routeSessionId !== activeSessionAccess.sessionId) {
        globalThis.location.replace(`/session/${encodeURIComponent(activeSessionAccess.sessionId)}`);
        return;
    }

    hydrateFormDefaults(elements, activeSessionAccess.sessionId);
    bindInteractiveFormHelpers(elements);
    renderSessionProgress(elements);
    void refreshSessionState(elements, activeSessionAccess);

    elements.sessionCheckNow?.addEventListener("click", function() {
        setFeedback(elements.formFeedback, "info", "Checking session status now...");
        void refreshSessionState(elements, activeSessionAccess, { force: true });
    });

    elements.form.addEventListener("submit", function(event) {
        submitSchedule(event, elements, activeSessionAccess);
    });
}

initSchedulerPage();
