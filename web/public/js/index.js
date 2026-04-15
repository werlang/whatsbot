import { TemplateVar } from "./helpers/template-var.js";
import { requestApi } from "./helpers/api.js";
import {
    createDefaultScheduledDateTime,
    convertDateTimeLocalToOffsetIso,
    formatIsoForDisplay,
    getCurrentTimezoneLabel,
    toDateTimeLocalValue,
} from "./helpers/datetime.js";
import { describeSession } from "./helpers/session.js";
import { resolveActiveSessionId } from "./helpers/session-id.js";

const SESSION_REFRESH_INTERVAL_MS = 15000;

/**
 * Collects the DOM nodes used by the scheduler page.
 */
function createElements() {
    return {
        form: document.querySelector("#schedule-form"),
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
        timezoneLabel: document.querySelector("[data-role=timezone-label]"),
        activeSessionId: document.querySelector("[data-role=active-session-id]"),
        year: document.querySelector("[data-role=year]"),
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
 * Applies the initial browser-local scheduling hints.
 */
function hydrateFormDefaults(elements, sessionId) {
    if (elements.year) {
        elements.year.textContent = TemplateVar.get("year") || String(new Date().getFullYear());
    }

    if (elements.activeSessionId) {
        elements.activeSessionId.textContent = sessionId;
    }

    if (elements.timezoneLabel) {
        elements.timezoneLabel.textContent = getCurrentTimezoneLabel();
    }

    if (elements.scheduledFor) {
        elements.scheduledFor.min = toDateTimeLocalValue(new Date());
        if (!elements.scheduledFor.value) {
            elements.scheduledFor.value = createDefaultScheduledDateTime();
        }
    }
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
    }
}

/**
 * Loads the latest WhatsApp session state from the API.
 */
async function loadSessionState(elements, sessionId) {
    const response = await requestApi(`/whatsapp/session?sessionId=${encodeURIComponent(sessionId)}`);
    if (!response.ok || !response.data || !response.data.session) {
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
        return;
    }

    renderSessionState(elements, describeSession(response.data.session));
}

/**
 * Schedules one message through POST /messages.
 */
async function submitSchedule(event, elements, sessionId) {
    event.preventDefault();

    if (!elements.form || !elements.submitButton) {
        return;
    }

    setFeedback(elements.formFeedback, "info", "Scheduling message...");
    elements.submitButton.disabled = true;

    try {
        const response = await requestApi("/messages", {
            method: "POST",
            body: {
                sessionId,
                phoneNumber: elements.phoneNumber?.value.trim(),
                message: elements.message?.value.trim(),
                scheduledFor: convertDateTimeLocalToOffsetIso(elements.scheduledFor?.value),
            },
        });

        if (!response.ok) {
            setFeedback(elements.formFeedback, "danger", readResponseMessage(response, "Could not schedule the WhatsApp message."));
            return;
        }

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

    const activeSessionId = resolveActiveSessionId();

    hydrateFormDefaults(elements, activeSessionId);
    loadSessionState(elements, activeSessionId);
    globalThis.setInterval(function() {
        loadSessionState(elements, activeSessionId);
    }, SESSION_REFRESH_INTERVAL_MS);

    elements.form.addEventListener("submit", function(event) {
        submitSchedule(event, elements, activeSessionId);
    });
}

initSchedulerPage();
