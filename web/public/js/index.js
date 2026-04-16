import { TemplateVar } from "./helpers/template-var.js";
import { requestApi } from "./helpers/api.js";
import {
    createDefaultScheduledDateTime,
    convertDateTimeLocalToOffsetIso,
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

/**
 * Collects the DOM nodes used by the scheduler page.
 */
function createElements() {
    return {
        form: document.querySelector("#schedule-form"),
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
        schedulePreview: document.querySelector("[data-role=schedule-preview]"),
        messageCounter: document.querySelector("[data-role=message-counter]"),
        timezoneLabels: [...document.querySelectorAll("[data-role=timezone-label]")],
        activeSessionId: document.querySelector("[data-role=active-session-id]"),
        schedulePresetButtons: [...document.querySelectorAll("[data-role=schedule-preset]")],
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
 * Renders the latest synced contacts and groups into the recipient picker.
 */
function renderRecipientDirectory(elements, session) {
    if (!elements.recipientPicker) {
        return;
    }

    const directory = readRecipientDirectory(session);
    const previousValue = elements.recipientPicker.value;
    const totalRecipients = directory.contacts.length + directory.groups.length;

    elements.recipientPicker.replaceChildren();

    const placeholderOption = document.createElement("option");
    placeholderOption.value = "";
    placeholderOption.textContent = totalRecipients > 0
        ? "Type a number or pick a synced chat"
        : (session?.ready
            ? "No synced contacts or groups found yet"
            : "Pair this session to load contacts and groups");
    elements.recipientPicker.append(placeholderOption);

    appendRecipientGroup(elements.recipientPicker, "Contacts", directory.contacts);
    appendRecipientGroup(elements.recipientPicker, "Groups", directory.groups);

    elements.recipientPicker.disabled = totalRecipients === 0;

    if ([...elements.recipientPicker.options].some(option => option.value === previousValue)) {
        elements.recipientPicker.value = previousValue;
    }

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

    const contactsLabel = `${directory.contacts.length} contact${directory.contacts.length === 1 ? "" : "s"}`;
    const groupsLabel = `${directory.groups.length} group${directory.groups.length === 1 ? "" : "s"}`;
    elements.recipientDirectoryStatus.textContent = `Synced ${contactsLabel} and ${groupsLabel}. Pick one here or type a number below.`;
}

/**
 * Appends one optgroup of recipient options when entries are available.
 */
function appendRecipientGroup(select, label, entries) {
    if (!select || !Array.isArray(entries) || entries.length === 0) {
        return;
    }

    const group = document.createElement("optgroup");
    group.label = label;

    for (const entry of entries) {
        const option = document.createElement("option");
        option.value = buildRecipientChoiceValue(entry);
        option.textContent = entry.phoneNumber
            ? `${entry.label} · ${entry.phoneNumber}`
            : entry.label;
        group.append(option);
    }

    select.append(group);
}

/**
 * Formats one datetime-local value into concise preview text.
 */
function formatScheduledPreview(value) {
    const normalizedValue = String(value ?? "").trim();
    if (!normalizedValue) {
        return "";
    }

    const localDate = new Date(normalizedValue);
    if (Number.isNaN(localDate.getTime())) {
        return "";
    }

    return new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
    }).format(localDate);
}

/**
 * Returns a friendly recipient label for the live preview.
 */
function readPreviewRecipient(elements) {
    const selectedOption = elements.recipientPicker?.selectedOptions?.[0] || null;
    const selectedValue = elements.recipientPicker?.value || "";
    if (selectedOption && selectedValue) {
        return selectedOption.textContent.trim();
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

    elements.recipientPicker?.addEventListener("change", rerender);
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
 * Loads the latest WhatsApp session state from the API.
 */
async function loadSessionState(elements, sessionAccess) {
    const response = await requestApi(`/whatsapp/session?sessionId=${encodeURIComponent(sessionAccess.sessionId)}`, {
        headers: buildSessionAccessHeaders(sessionAccess.accessPassword),
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
        renderRecipientDirectory(elements, null);
        return;
    }

    renderSessionState(elements, describeSession(response.data.session));
    renderRecipientDirectory(elements, response.data.session);
    renderFormEnhancements(elements);
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
            headers: buildSessionAccessHeaders(sessionAccess.accessPassword),
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

    if (!activeSessionAccess.sessionId || !activeSessionAccess.accessPassword) {
        globalThis.location.replace("/login");
        return;
    }

    if (!routeSessionId || routeSessionId !== activeSessionAccess.sessionId) {
        globalThis.location.replace(`/session/${encodeURIComponent(activeSessionAccess.sessionId)}`);
        return;
    }

    hydrateFormDefaults(elements, activeSessionAccess.sessionId);
    bindInteractiveFormHelpers(elements);
    loadSessionState(elements, activeSessionAccess);
    globalThis.setInterval(function() {
        loadSessionState(elements, activeSessionAccess);
    }, SESSION_REFRESH_INTERVAL_MS);

    elements.form.addEventListener("submit", function(event) {
        submitSchedule(event, elements, activeSessionAccess);
    });
}

initSchedulerPage();
