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
    formatPhoneNumberForDisplay,
    readRecipientDirectory,
    resolveScheduledMessageTarget,
} from "./helpers/recipient.js";
import {
    buildScheduledMessageDraft,
    buildScheduledMessageViewModel,
    createScheduleFormMode,
    removeScheduledMessageFromCollection,
    sortScheduledMessages,
    upsertScheduledMessageInCollection,
} from "./helpers/scheduled-message.js";
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
        phoneEcho: document.querySelector("#phone-echo"),
        message: document.querySelector("#message"),
        scheduledFor: document.querySelector("#scheduled-for"),
        submitButton: document.querySelector("#schedule-submit"),
        formFeedback: document.querySelector("#form-feedback"),
        scheduleList: document.querySelector("[data-role=schedule-list]"),
        scheduleListEmpty: document.querySelector("[data-role=schedule-list-empty]"),
        scheduleListLoading: document.querySelector("[data-role=schedule-list-loading]"),
        scheduleListFeedback: document.querySelector("[data-role=schedule-list-feedback]"),
        scheduleCount: document.querySelector("[data-role=schedule-count]"),
        queueTally: document.querySelector("#queue-tally"),
        queueEmptyCompose: document.querySelector("#queue-empty-compose"),
        scheduleRefresh: document.querySelector("[data-role=schedule-refresh]"),
        scheduleFormKicker: document.querySelector("[data-role=schedule-form-kicker]"),
        scheduleFormTitle: document.querySelector("[data-role=schedule-form-title]"),
        scheduleCancelEdit: document.querySelector("[data-role=schedule-cancel-edit]"),
        tabQueue: document.querySelector("#tab-queue"),
        tabCompose: document.querySelector("#tab-compose"),
        composePane: document.querySelector("#compose-pane"),
        queuePane: document.querySelector("#queue-pane"),
        nextSend: document.querySelector("#next-send"),
        nextSendTime: document.querySelector("#next-send-time"),
        nextSendDay: document.querySelector("#next-send-day"),
        nextSendTo: document.querySelector("#next-send-to"),
        nextSendMessage: document.querySelector("#next-send-message"),
        nextSendFill: document.querySelector("#next-send-fill"),
        nextSendCountdownLabel: document.querySelector("#next-send-countdown-label"),
        nextSendCountdown: document.querySelector("#next-send-countdown"),
        sessionStatus: document.querySelector("#session-status"),
        sessionConnection: document.querySelector("#session-connection"),
        sessionNote: document.querySelector("#session-note"),
        sessionReconnect: document.querySelector("#session-reconnect"),
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
        sessionPanel: document.querySelector("[data-role=session-panel]"),
        sessionReadyIndicator: document.querySelector("[data-role=session-ready-indicator]"),
        currentSession: null,
        recipientLabelByValue: new Map(),
        recipientValueByLabel: new Map(),
        uiState: {
            isRefreshingSession: false,
            refreshTimerId: 0,
            countdownTimerId: 0,
            boardTimerId: 0,
            nextRefreshAt: 0,
            lastRefreshAt: 0,
            pairingDetected: false,
            previousDescription: null,
            reconnectAttempt: 0,
            nextReconnectAt: "",
            scheduledMessages: [],
            previousStatuses: new Map(),
            hasLoadedMessages: false,
            messagesLoadError: false,
            editingScheduledMessageId: "",
            isRefreshingScheduledMessages: false,
            activeTab: "queue",
            lastCountdownText: "",
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
        elements.recipientDirectoryStatus.textContent = "Pair to load contacts. Or type a number.";
        return;
    }

    if (totalRecipients === 0) {
        elements.recipientDirectoryStatus.textContent = "No contacts yet. You can still type a number.";
        return;
    }

    const contactsLabel = formatRecipientCount(directory.contacts.length, "contact");
    const groupsLabel = formatRecipientCount(directory.groups.length, "group");

    elements.recipientDirectoryStatus.textContent = `Synced ${contactsLabel} and ${groupsLabel}. Start typing, or enter a number.`;
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
        ? "Start typing"
        : (sessionReady
            ? "No contacts found yet"
            : "Pair to load contacts");

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

    if (previousValue) {
        elements.recipientEntry.value = previousLabel;
        elements.recipientPicker.value = previousValue;
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
        return formatPhoneNumberForDisplay(phoneNumber) || phoneNumber;
    }

    return "";
}

/**
 * Updates the formatted phone echo below the phone input without mutating the stored value.
 */
function renderPhoneEcho(elements) {
    if (!elements.phoneEcho) {
        return;
    }

    const raw = String(elements.phoneNumber?.value ?? "").trim();
    if (!raw) {
        elements.phoneEcho.textContent = "";
        return;
    }

    const formatted = formatPhoneNumberForDisplay(raw);
    elements.phoneEcho.textContent = formatted && formatted !== raw
        ? `Displays as ${formatted}`
        : "";
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
    const message = String(elements.message?.value ?? "").trim();

    if (!recipient && !scheduledFor && !message) {
        elements.schedulePreview.textContent = "Add a number, a message and a time.";
        return;
    }

    if (!recipient || !scheduledFor || !message) {
        elements.schedulePreview.textContent = "Add the missing details.";
        return;
    }

    const toSpan = document.createElement("span");
    toSpan.className = "compose__summary-to";
    toSpan.textContent = `To ${recipient}`;

    const timeLabel = document.createElement("strong");
    timeLabel.textContent = scheduledFor;

    elements.schedulePreview.replaceChildren(toSpan, document.createTextNode("Leaves "), timeLabel);
}

/**
 * Updates the live helper text around the form.
 */
function renderFormEnhancements(elements) {
    renderPhoneEcho(elements);
    renderMessageCounter(elements);
    renderSchedulePreview(elements);
}

/**
 * Returns the scheduled message currently being edited, if any.
 */
function readEditingScheduledMessage(elements) {
    const editingScheduledMessageId = String(elements.uiState.editingScheduledMessageId || "").trim();

    if (!editingScheduledMessageId) {
        return null;
    }

    return elements.uiState.scheduledMessages.find(scheduledMessage => scheduledMessage.id === editingScheduledMessageId) || null;
}

/**
 * Renders the scheduler form header and actions for create or edit mode.
 */
function renderScheduleFormMode(elements) {
    const formMode = createScheduleFormMode(readEditingScheduledMessage(elements));

    if (elements.scheduleFormKicker) {
        elements.scheduleFormKicker.hidden = !formMode.isEditing;
        elements.scheduleFormKicker.textContent = formMode.kicker;
    }

    if (elements.scheduleFormTitle) {
        elements.scheduleFormTitle.textContent = formMode.isEditing ? "Edit message" : "New message";
    }

    if (elements.submitButton) {
        elements.submitButton.textContent = formMode.submitLabel;
    }

    if (elements.scheduleCancelEdit) {
        elements.scheduleCancelEdit.hidden = !formMode.isEditing;
        elements.scheduleCancelEdit.textContent = formMode.cancelLabel;
    }
}

/**
 * Resets the form after a create flow or when leaving edit mode.
 */
function resetScheduleForm(elements, { preserveRecipient = false } = {}) {
    elements.uiState.editingScheduledMessageId = "";

    if (!preserveRecipient) {
        if (elements.recipientEntry) {
            elements.recipientEntry.value = "";
        }
        if (elements.recipientPicker) {
            elements.recipientPicker.value = "";
        }
        if (elements.phoneNumber) {
            elements.phoneNumber.value = "";
        }
    }

    if (elements.message) {
        elements.message.value = "";
    }

    if (elements.scheduledFor) {
        elements.scheduledFor.value = createDefaultScheduledDateTime();
    }

    setActivePreset(elements, "");
    renderScheduleFormMode(elements);
    renderFormEnhancements(elements);
}

/**
 * Creates one SVG `<use>` icon node from `/img/icons.svg`.
 */
function createIcon(symbolId) {
    const svgNS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("class", "icon");
    svg.setAttribute("aria-hidden", "true");
    const use = document.createElementNS(svgNS, "use");
    use.setAttribute("href", `/img/icons.svg#${symbolId}`);
    svg.append(use);
    return svg;
}

/**
 * Formats one timestamp into 24-hour HH:MM and a compact day label.
 */
function formatTicketWhen(isoValue) {
    const date = new Date(isoValue || "");
    if (Number.isNaN(date.getTime())) {
        return { time: "--:--", day: "Unknown" };
    }

    const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const dateStart = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
    const dayDiff = Math.round((dateStart - todayStart) / 86_400_000);

    let day = "";
    if (dayDiff === 0) {
        day = "Today";
    } else if (dayDiff === 1) {
        day = "Tomorrow";
    } else if (dayDiff === -1) {
        day = "Yesterday";
    } else {
        day = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(date);
    }

    return { time, day };
}

/**
 * Formats one short relative time string for queue rows.
 */
function formatRelativeDelta(isoValue, status) {
    const targetMs = new Date(isoValue || "").getTime();
    if (Number.isNaN(targetMs)) {
        return "";
    }

    const diffSec = Math.round((targetMs - Date.now()) / 1000);
    if (status === "pending") {
        if (diffSec <= 0) {
            return "Due now";
        }
        if (diffSec < 60) {
            return `in ${diffSec}s`;
        }
        const mins = Math.round(diffSec / 60);
        if (mins < 60) {
            return `in ${mins}m`;
        }
        const hours = Math.floor(mins / 60);
        const remMins = mins % 60;
        if (hours < 24) {
            return remMins > 0 ? `in ${hours}h ${remMins}m` : `in ${hours}h`;
        }
        const days = Math.round(hours / 24);
        return `in ${days}d`;
    }

    const agoSec = Math.max(0, Math.round((Date.now() - targetMs) / 1000));
    if (agoSec < 60) {
        return "just now";
    }
    const agoMins = Math.round(agoSec / 60);
    if (agoMins < 60) {
        return `${agoMins}m ago`;
    }
    const agoHours = Math.round(agoMins / 60);
    if (agoHours < 24) {
        return `${agoHours}h ago`;
    }
    const agoDays = Math.round(agoHours / 24);
    return `${agoDays}d ago`;
}

/**
 * Formats a recipient label cleanly for the board and queue rows.
 */
function formatRecipientDisplay(scheduledMessage, viewModel, recipientLabelByValue) {
    const choiceValue = buildRecipientChoiceValue({
        targetType: scheduledMessage.targetType,
        targetValue: scheduledMessage.targetValue,
    });
    if (recipientLabelByValue.has(choiceValue)) {
        return recipientLabelByValue.get(choiceValue);
    }

    if (scheduledMessage.targetType === "group") {
        const rawGroup = String(scheduledMessage.targetValue || "").trim();
        return rawGroup ? `Group ${rawGroup.replace(/@g\.us$/i, "")}` : "Group";
    }

    return formatPhoneNumberForDisplay(viewModel.recipientLabel) || viewModel.recipientLabel;
}

/**
 * Formats countdown digits as HH:MM:SS (or Xd HH:MM when >= 100h).
 */
function formatBoardCountdown(remainingMs) {
    const totalSeconds = Math.max(0, Math.floor(remainingMs / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    if (hours >= 100) {
        const days = Math.floor(hours / 24);
        const remHours = hours % 24;
        return `${days}d ${String(remHours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
    }

    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

/**
 * Renders the departure board countdown digits with per-digit turn animation.
 */
function renderBoardDigits(elements, text) {
    if (!elements.nextSendCountdown) {
        return;
    }

    const previous = elements.uiState.lastCountdownText;
    const existingDigits = [...elements.nextSendCountdown.children];

    if (existingDigits.length !== text.length || !previous) {
        const nodes = [...text].map(character => {
            const cell = document.createElement("span");
            cell.className = "board__digit";
            const face = document.createElement("span");
            face.className = "board__digit-face";
            face.textContent = character;
            cell.append(face);
            return cell;
        });
        elements.nextSendCountdown.replaceChildren(...nodes);
        elements.uiState.lastCountdownText = text;
        return;
    }

    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        const cell = existingDigits[i];
        const face = cell?.firstElementChild;
        if (!cell || !face) {
            continue;
        }
        if (previous[i] !== char) {
            face.textContent = char;
            cell.classList.remove("is-turning");
            void cell.offsetWidth;
            cell.classList.add("is-turning");
        }
    }

    elements.uiState.lastCountdownText = text;
}

/**
 * Finds the next upcoming pending message and updates the departure board strip.
 */
function renderNextSendBoard(elements) {
    if (!elements.nextSend) {
        return;
    }

    const nextMessage = elements.uiState.scheduledMessages
        .find(item => String(item?.status || "").toLowerCase() === "pending") || null;

    if (!nextMessage) {
        elements.nextSend.dataset.state = "empty";
        elements.nextSend.style.setProperty("--progress", "0");
        if (elements.nextSendTime) {
            elements.nextSendTime.textContent = "--:--";
            elements.nextSendTime.removeAttribute("datetime");
        }
        if (elements.nextSendDay) {
            elements.nextSendDay.textContent = "Nothing queued";
        }
        if (elements.nextSendTo) {
            elements.nextSendTo.textContent = "The board is clear";
        }
        if (elements.nextSendMessage) {
            elements.nextSendMessage.textContent = "Schedule a message and its departure shows here.";
        }
        if (elements.nextSendCountdownLabel) {
            elements.nextSendCountdownLabel.textContent = "Leaves in";
        }
        renderBoardDigits(elements, "--:--:--");
        return;
    }

    const when = formatTicketWhen(nextMessage.scheduledFor);
    const viewModel = buildScheduledMessageViewModel(nextMessage, elements.recipientLabelByValue);
    const recipient = formatRecipientDisplay(nextMessage, viewModel, elements.recipientLabelByValue);

    const scheduledMs = new Date(nextMessage.scheduledFor || 0).getTime();
    const createdMs = new Date(nextMessage.createdAt || 0).getTime();
    const nowMs = Date.now();
    const remainingMs = scheduledMs - nowMs;
    const isDue = remainingMs <= 0;

    let progress = 1;
    if (!isDue && Number.isFinite(scheduledMs)) {
        const originMs = Number.isFinite(createdMs) && createdMs < scheduledMs
            ? createdMs
            : scheduledMs - 3_600_000;
        const spanMs = Math.max(1000, scheduledMs - originMs);
        progress = Math.min(1, Math.max(0.03, (nowMs - originMs) / spanMs));
    }

    elements.nextSend.dataset.state = isDue ? "due" : "active";
    elements.nextSend.style.setProperty("--progress", progress.toFixed(4));

    if (elements.nextSendTime) {
        elements.nextSendTime.textContent = when.time;
        if (nextMessage.scheduledFor) {
            elements.nextSendTime.setAttribute("datetime", nextMessage.scheduledFor);
        }
    }
    if (elements.nextSendDay) {
        elements.nextSendDay.textContent = when.day;
    }
    if (elements.nextSendTo) {
        elements.nextSendTo.textContent = recipient;
    }
    if (elements.nextSendMessage) {
        elements.nextSendMessage.textContent = viewModel.messagePreview;
    }
    if (elements.nextSendCountdownLabel) {
        elements.nextSendCountdownLabel.textContent = isDue ? "Due · within 15s" : "Leaves in";
    }

    renderBoardDigits(elements, isDue ? "00:00:00" : formatBoardCountdown(remainingMs));
}

/**
 * Starts or stops the 1-second ticker for the departure board and relative queue labels.
 */
function syncBoardTicker(elements) {
    const hasPending = elements.uiState.scheduledMessages
        .some(item => String(item?.status || "").toLowerCase() === "pending");

    if (!hasPending) {
        if (elements.uiState.boardTimerId) {
            globalThis.clearInterval(elements.uiState.boardTimerId);
            elements.uiState.boardTimerId = 0;
        }
        return;
    }

    if (elements.uiState.boardTimerId) {
        return;
    }

    elements.uiState.boardTimerId = globalThis.setInterval(function() {
        renderNextSendBoard(elements);
        updateQueueRelativeLabels(elements);
    }, 1000);
}

/**
 * Refreshes relative time labels on rendered queue tickets without rebuilding the DOM.
 */
function updateQueueRelativeLabels(elements) {
    if (!elements.scheduleList) {
        return;
    }

    const byId = new Map(elements.uiState.scheduledMessages.map(item => [item.id, item]));
    for (const node of elements.scheduleList.querySelectorAll("[data-relative-for]")) {
        const item = byId.get(node.dataset.relativeFor || "");
        if (item) {
            node.textContent = formatRelativeDelta(item.scheduledFor, String(item.status || "pending").toLowerCase());
        }
    }
}

/**
 * Switches the visible pane on narrow viewports while keeping both visible on desktop.
 */
function applyWorkspaceTabLayout(elements) {
    const isDesktop = globalThis.matchMedia?.("(min-width: 1024px)")?.matches ?? true;
    const activeTab = elements.uiState.activeTab === "compose" ? "compose" : "queue";

    if (elements.tabQueue) {
        elements.tabQueue.setAttribute("aria-selected", activeTab === "queue" ? "true" : "false");
    }
    if (elements.tabCompose) {
        elements.tabCompose.setAttribute("aria-selected", activeTab === "compose" ? "true" : "false");
    }

    if (isDesktop) {
        if (elements.composePane) {
            elements.composePane.hidden = false;
        }
        if (elements.queuePane) {
            elements.queuePane.hidden = false;
        }
        return;
    }

    if (elements.composePane) {
        elements.composePane.hidden = activeTab !== "compose";
    }
    if (elements.queuePane) {
        elements.queuePane.hidden = activeTab !== "queue";
    }
}

/**
 * Activates one mobile workspace tab ("queue" or "compose").
 */
function setWorkspaceTab(elements, tabName) {
    elements.uiState.activeTab = tabName === "compose" ? "compose" : "queue";
    applyWorkspaceTabLayout(elements);
}

/**
 * Loads one scheduled message into the form for editing.
 */
function startScheduledMessageEdit(elements, scheduledMessage) {
    if (!scheduledMessage?.id) {
        return;
    }

    const draft = buildScheduledMessageDraft(scheduledMessage);
    const viewModel = buildScheduledMessageViewModel(scheduledMessage, elements.recipientLabelByValue);

    elements.uiState.editingScheduledMessageId = draft.id;

    if (elements.recipientPicker) {
        elements.recipientPicker.value = draft.recipientValue;
    }

    if (elements.recipientEntry) {
        elements.recipientEntry.value = elements.recipientLabelByValue.get(draft.recipientValue) || viewModel.recipientLabel;
    }

    if (elements.phoneNumber) {
        elements.phoneNumber.value = draft.phoneNumber;
    }

    if (elements.message) {
        elements.message.value = draft.message;
    }

    if (elements.scheduledFor) {
        elements.scheduledFor.value = draft.scheduledFor;
    }

    renderScheduleFormMode(elements);
    renderFormEnhancements(elements);
    setWorkspaceTab(elements, "compose");
    elements.form?.scrollIntoView({ behavior: "smooth", block: "start" });
    elements.message?.focus();
}

/**
 * Renders the summary tally in the queue pane header.
 */
function renderQueueTally(elements, scheduledMessages) {
    if (!elements.queueTally) {
        return;
    }

    if (scheduledMessages.length === 0) {
        elements.queueTally.replaceChildren();
        return;
    }

    let pendingCount = 0;
    let failedCount = 0;
    let sentCount = 0;

    for (const item of scheduledMessages) {
        const status = String(item?.status || "pending").toLowerCase();
        if (status === "failed") {
            failedCount++;
        } else if (status === "sent") {
            sentCount++;
        } else {
            pendingCount++;
        }
    }

    const parts = [];
    if (pendingCount > 0) {
        parts.push(document.createTextNode(`${pendingCount} pending`));
    }
    if (failedCount > 0) {
        const failedSpan = document.createElement("span");
        failedSpan.className = "queue__tally-failed";
        failedSpan.textContent = `${failedCount} failed`;
        parts.push(failedSpan);
    }
    if (sentCount > 0) {
        parts.push(document.createTextNode(`${sentCount} sent`));
    }

    const nodes = [];
    parts.forEach((part, index) => {
        if (index > 0) {
            nodes.push(document.createTextNode(" · "));
        }
        nodes.push(part);
    });
    elements.queueTally.replaceChildren(...nodes);
}

/**
 * Builds one ticket row DOM node for the dispatch queue.
 */
function buildTicketElement(elements, scheduledMessage, { isNextPending = false, isChanged = false } = {}) {
    const viewModel = buildScheduledMessageViewModel(scheduledMessage, elements.recipientLabelByValue);
    const when = formatTicketWhen(scheduledMessage.scheduledFor);
    const recipient = formatRecipientDisplay(scheduledMessage, viewModel, elements.recipientLabelByValue);

    const row = document.createElement("article");
    row.className = isChanged ? "ticket is-changed" : "ticket";
    row.dataset.scheduledMessageId = viewModel.id;
    row.dataset.status = viewModel.status;
    if (isNextPending) {
        row.dataset.next = "true";
    }

    const whenCell = document.createElement("div");
    whenCell.className = "ticket__when";
    const timeEl = document.createElement("time");
    timeEl.className = "ticket__time";
    timeEl.textContent = when.time;
    if (scheduledMessage.scheduledFor) {
        timeEl.setAttribute("datetime", scheduledMessage.scheduledFor);
    }
    const dayEl = document.createElement("span");
    dayEl.className = "ticket__day";
    dayEl.textContent = when.day;
    whenCell.append(timeEl, dayEl);

    const whatCell = document.createElement("div");
    whatCell.className = "ticket__what";
    const toEl = document.createElement("p");
    toEl.className = "ticket__to";
    toEl.append(createIcon(scheduledMessage.targetType === "group" ? "i-group" : "i-phone"));
    const toLabel = document.createElement("span");
    toLabel.textContent = recipient;
    toEl.append(toLabel);

    const msgEl = document.createElement("p");
    msgEl.className = "ticket__message";
    msgEl.textContent = viewModel.messagePreview;
    whatCell.append(toEl, msgEl);

    const errorText = typeof scheduledMessage.errorMessage === "string" ? scheduledMessage.errorMessage.trim() : "";
    if (errorText && viewModel.status === "failed") {
        const errEl = document.createElement("p");
        errEl.className = "ticket__error";
        errEl.textContent = errorText;
        whatCell.append(errEl);
    }

    const statusCell = document.createElement("div");
    statusCell.className = "ticket__status";

    const statusTone = viewModel.status === "pending" ? "time" : viewModel.statusTone;
    const statusIcon = viewModel.status === "sent"
        ? "i-check"
        : (viewModel.status === "failed" ? "i-fault" : "i-clock");

    const statusMark = document.createElement("span");
    statusMark.className = "status-mark";
    statusMark.dataset.tone = statusTone;
    statusMark.append(createIcon(statusIcon));
    const statusText = document.createElement("span");
    statusText.textContent = viewModel.statusLabel;
    statusMark.append(statusText);

    const relativeEl = document.createElement("span");
    relativeEl.className = "ticket__relative";
    relativeEl.dataset.relativeFor = viewModel.id;
    relativeEl.textContent = formatRelativeDelta(
        scheduledMessage.sentAt && viewModel.status === "sent" ? scheduledMessage.sentAt : scheduledMessage.scheduledFor,
        viewModel.status,
    );

    statusCell.append(statusMark, relativeEl);

    const actionsCell = document.createElement("div");
    actionsCell.className = "ticket__actions";

    if (viewModel.canEdit) {
        const editButton = document.createElement("button");
        editButton.className = "button button--quiet button--icon";
        editButton.type = "button";
        editButton.dataset.action = "edit";
        editButton.dataset.scheduledMessageId = viewModel.id;
        editButton.setAttribute("aria-label", `Edit message to ${recipient}`);
        editButton.title = "Edit";
        editButton.append(createIcon("i-edit"));
        actionsCell.append(editButton);
    }

    if (viewModel.canDelete) {
        const deleteButton = document.createElement("button");
        deleteButton.className = "button button--quiet button--icon button--danger";
        deleteButton.type = "button";
        deleteButton.dataset.action = "delete";
        deleteButton.dataset.scheduledMessageId = viewModel.id;
        deleteButton.setAttribute("aria-label", `Delete message to ${recipient}`);
        deleteButton.title = "Delete";
        deleteButton.append(createIcon("i-trash"));
        actionsCell.append(deleteButton);
    }

    row.append(whenCell, whatCell, statusCell, actionsCell);
    return row;
}

/**
 * Renders the schedule queue panel.
 */
function renderScheduledMessages(elements) {
    if (!elements.scheduleList) {
        return;
    }

    const scheduledMessages = sortScheduledMessages(elements.uiState.scheduledMessages);
    elements.uiState.scheduledMessages = scheduledMessages;

    if (elements.scheduleCount) {
        elements.scheduleCount.textContent = String(scheduledMessages.length);
    }

    renderQueueTally(elements, scheduledMessages);
    renderNextSendBoard(elements);
    syncBoardTicker(elements);

    if (elements.scheduleListLoading) {
        elements.scheduleListLoading.hidden = elements.uiState.hasLoadedMessages;
    }

    if (elements.scheduleListEmpty) {
        elements.scheduleListEmpty.hidden = !elements.uiState.hasLoadedMessages
            || elements.uiState.messagesLoadError
            || scheduledMessages.length > 0;
    }

    const upcoming = [];
    const failed = [];
    const delivered = [];

    for (const item of scheduledMessages) {
        const status = String(item?.status || "pending").toLowerCase();
        if (status === "failed") {
            failed.push(item);
        } else if (status === "sent") {
            delivered.push(item);
        } else {
            upcoming.push(item);
        }
    }

    failed.reverse();
    delivered.reverse();

    const groups = [
        { label: "Upcoming", items: upcoming },
        { label: "Needs attention", items: failed },
        { label: "Delivered", items: delivered },
    ].filter(group => group.items.length > 0);

    const nextPendingId = upcoming.find(item => String(item?.status || "").toLowerCase() === "pending")?.id || "";
    const hasPreviousSnapshot = elements.uiState.previousStatuses.size > 0;
    const nextStatusMap = new Map();

    const fragment = document.createDocumentFragment();
    for (const group of groups) {
        const groupHeader = document.createElement("div");
        groupHeader.className = "queue__group";
        const titleSpan = document.createElement("span");
        titleSpan.textContent = group.label;
        const countSpan = document.createElement("span");
        countSpan.textContent = String(group.items.length);
        groupHeader.append(titleSpan, countSpan);

        const rowsWrap = document.createElement("div");
        rowsWrap.className = "queue__rows";

        for (const item of group.items) {
            const status = String(item?.status || "pending").toLowerCase();
            nextStatusMap.set(item.id, status);
            const previousStatus = elements.uiState.previousStatuses.get(item.id);
            const isChanged = hasPreviousSnapshot && Boolean(previousStatus) && previousStatus !== status;

            rowsWrap.append(buildTicketElement(elements, item, {
                isNextPending: item.id === nextPendingId,
                isChanged,
            }));
        }

        fragment.append(groupHeader, rowsWrap);
    }

    elements.uiState.previousStatuses = nextStatusMap;
    elements.scheduleList.replaceChildren(fragment);
    renderScheduleFormMode(elements);
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
        scheduled.setHours(9, 0, 0, 0);
        if (scheduled.getTime() <= now.getTime()) {
            scheduled.setDate(scheduled.getDate() + 1);
        }
        return toDateTimeLocalValue(scheduled);
    }

    return "";
}

/**
 * Marks the active quick preset button for the current time choice.
 */
function setActivePreset(elements, activePreset) {
    for (const button of elements.schedulePresetButtons) {
        const isActive = button.dataset.preset === activePreset;
        button.dataset.active = isActive ? "true" : "false";
        button.setAttribute("aria-pressed", isActive ? "true" : "false");
    }
}

/**
 * Wires up live preview interactions on the scheduler form and workspace tabs.
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

    elements.scheduleCancelEdit?.addEventListener("click", function() {
        resetScheduleForm(elements, { preserveRecipient: false });
        setFeedback(elements.formFeedback, "info", "Edit canceled.");
    });

    elements.tabQueue?.addEventListener("click", function() {
        setWorkspaceTab(elements, "queue");
    });

    elements.tabCompose?.addEventListener("click", function() {
        setWorkspaceTab(elements, "compose");
    });

    const handleTabKeydown = function(event) {
        if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
            const next = elements.uiState.activeTab === "queue" ? "compose" : "queue";
            setWorkspaceTab(elements, next);
            (next === "queue" ? elements.tabQueue : elements.tabCompose)?.focus();
        }
    };
    elements.tabQueue?.addEventListener("keydown", handleTabKeydown);
    elements.tabCompose?.addEventListener("keydown", handleTabKeydown);

    elements.queueEmptyCompose?.addEventListener("click", function() {
        setWorkspaceTab(elements, "compose");
        elements.phoneNumber?.focus();
    });

    const mediaQuery = globalThis.matchMedia?.("(min-width: 1024px)");
    mediaQuery?.addEventListener("change", function() {
        applyWorkspaceTabLayout(elements);
    });
    applyWorkspaceTabLayout(elements);

    elements.scheduleList?.addEventListener("click", function(event) {
        const actionButton = event.target instanceof HTMLElement
            ? event.target.closest("[data-action][data-scheduled-message-id]")
            : null;

        if (!actionButton) {
            return;
        }

        const scheduledMessageId = actionButton.dataset.scheduledMessageId || "";
        const scheduledMessage = elements.uiState.scheduledMessages
            .find(entry => entry.id === scheduledMessageId) || null;

        if (!scheduledMessage) {
            return;
        }

        if (actionButton.dataset.action === "edit") {
            startScheduledMessageEdit(elements, scheduledMessage);
            setFeedback(elements.formFeedback, "info", "Editing scheduled message.");
        }
    });
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
    renderScheduleFormMode(elements);
}

function formatReconnectLine(reconnectAttempt, nextReconnectAt) {
    const parts = [];
    if (reconnectAttempt > 0) {
        parts.push(`Attempt ${reconnectAttempt}`);
    }
    if (nextReconnectAt) {
        const targetMs = new Date(nextReconnectAt).getTime();
        if (Number.isFinite(targetMs)) {
            const secs = Math.max(0, Math.ceil((targetMs - Date.now()) / 1000));
            parts.push(secs > 0 ? `retrying in ${secs}s` : "retrying now");
        }
    }
    return parts.join(" · ");
}

/**
 * Updates the reconnect countdown line if present.
 */
function updateSessionReconnectFact(elements) {
    if (!elements.sessionReconnect) {
        return;
    }

    const line = formatReconnectLine(elements.uiState.reconnectAttempt, elements.uiState.nextReconnectAt);
    elements.sessionReconnect.hidden = !line;
    elements.sessionReconnect.textContent = line;
}

/**
 * Renders the latest WhatsApp session summary on the page.
 */
function renderSessionState(elements, description) {
    const isReady = description.phase === "ready";

    elements.uiState.reconnectAttempt = Number(description.reconnectAttempt || 0);
    elements.uiState.nextReconnectAt = description.nextReconnectAt || "";

    if (elements.sessionPanel) {
        elements.sessionPanel.hidden = isReady;
    }

    if (elements.sessionReadyIndicator) {
        elements.sessionReadyIndicator.hidden = !isReady;
        elements.sessionReadyIndicator.dataset.tone = isReady ? "success" : "";
    }

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

    updateSessionReconnectFact(elements);

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
    return `Checks again in ${remainingSeconds}s.`;
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
            ? "Use Check for an instant refresh."
            : "Loading status.";
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
        updateSessionReconnectFact(elements);

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
    let eyebrow = "Checking the WhatsApp connection";
    let body = "Messages still queue while the phone connects.";
    let progress = 16;

    if (description.phase === "awaiting-qr") {
        eyebrow = "Scan the QR code";
        body = "Open WhatsApp on your phone to link this session. You can still schedule messages now.";
        progress = 38;
    } else if (description.phase === "connecting") {
        eyebrow = uiState.pairingDetected ? "Scan received" : "Connecting to WhatsApp";
        body = uiState.pairingDetected
            ? "Finishing setup now."
            : "WhatsApp is still connecting.";
        progress = 74;
    } else if (description.phase === "ready") {
        eyebrow = "Session ready";
        body = "WhatsApp is connected.";
        progress = 100;
    } else if (description.phase === "needs-qr") {
        eyebrow = "New QR required";
        body = "Authentication expired or failed. Pair again to generate a fresh QR code.";
        progress = 12;
    } else if (description.phase === "disconnected") {
        eyebrow = "Connection dropped";
        body = description.reconnectAttempt > 0
            ? `Reconnecting automatically (attempt ${description.reconnectAttempt}). Scheduled messages stay queued.`
            : "This session disconnected. Waiting to reconnect or issue a new QR code.";
        progress = 28;
    } else if (description.phase === "error") {
        eyebrow = "Session unavailable";
        body = "Could not reach the session state. Check again or pair again.";
        progress = 12;
    }

    if (elements.sessionProgressEyebrow) {
        elements.sessionProgressEyebrow.textContent = eyebrow;
    }

    if (elements.sessionProgressBody) {
        elements.sessionProgressBody.textContent = body;
    }

    if (elements.sessionProgressFill) {
        elements.sessionProgressFill.style.inlineSize = `${progress}%`;
    }

    updateSessionProgressMeta(elements);
}

/**
 * Loads the latest schedules for the active session.
 */
async function refreshScheduledMessages(elements, sessionAccess, { announce = false } = {}) {
    if (elements.uiState.isRefreshingScheduledMessages) {
        return;
    }

    elements.uiState.isRefreshingScheduledMessages = true;

    if (announce) {
        setFeedback(elements.scheduleListFeedback, "info", "Refreshing scheduled messages...");
    }

    if (elements.scheduleRefresh) {
        elements.scheduleRefresh.disabled = true;
    }

    try {
        const response = await requestApi(`/messages?sessionId=${encodeURIComponent(sessionAccess.sessionId)}`, {
            headers: buildSessionAccessHeaders(sessionAccess.accessToken),
        });

        if (response.status === 401) {
            clearStoredSessionAccess();
            globalThis.location.replace("/login");
            return;
        }

        if (!response.ok) {
            elements.uiState.hasLoadedMessages = true;
            elements.uiState.messagesLoadError = true;
            renderScheduledMessages(elements);
            setFeedback(elements.scheduleListFeedback, "danger", readResponseMessage(response, "Could not load scheduled messages."));
            return;
        }

        elements.uiState.hasLoadedMessages = true;
        elements.uiState.messagesLoadError = false;
        elements.uiState.scheduledMessages = sortScheduledMessages(response.data?.scheduledMessages || []);
        renderScheduledMessages(elements);
        setFeedback(elements.scheduleListFeedback, "", "");
    } catch (error) {
        elements.uiState.hasLoadedMessages = true;
        elements.uiState.messagesLoadError = true;
        renderScheduledMessages(elements);
        setFeedback(
            elements.scheduleListFeedback,
            "danger",
            error instanceof Error && error.message
                ? error.message
                : "Could not load scheduled messages.",
        );
    } finally {
        elements.uiState.isRefreshingScheduledMessages = false;
        if (elements.scheduleRefresh) {
            elements.scheduleRefresh.disabled = false;
        }
    }
}

/**
 * Deletes one scheduled message after confirmation.
 */
async function deleteScheduledMessage(elements, sessionAccess, scheduledMessage) {
    if (!scheduledMessage?.id) {
        return;
    }

    const viewModel = buildScheduledMessageViewModel(scheduledMessage, elements.recipientLabelByValue);
    const confirmed = globalThis.confirm(`Delete the message to ${viewModel.recipientLabel} planned for ${viewModel.scheduledForLabel}?`);

    if (!confirmed) {
        return;
    }

    setFeedback(elements.scheduleListFeedback, "info", "Deleting scheduled message...");

    try {
        const response = await requestApi(`/messages/${encodeURIComponent(scheduledMessage.id)}`, {
            method: "DELETE",
            headers: buildSessionAccessHeaders(sessionAccess.accessToken),
        });

        if (response.status === 401) {
            clearStoredSessionAccess();
            globalThis.location.replace("/login");
            return;
        }

        if (!response.ok) {
            setFeedback(elements.scheduleListFeedback, "danger", readResponseMessage(response, "Could not delete the scheduled message."));
            return;
        }

        elements.uiState.scheduledMessages = removeScheduledMessageFromCollection(elements.uiState.scheduledMessages, scheduledMessage.id);
        if (elements.uiState.editingScheduledMessageId === scheduledMessage.id) {
            resetScheduleForm(elements, { preserveRecipient: false });
        }
        renderScheduledMessages(elements);
        setFeedback(elements.scheduleListFeedback, "success", "Scheduled message deleted.");
    } catch (error) {
        setFeedback(
            elements.scheduleListFeedback,
            "danger",
            error instanceof Error && error.message
                ? error.message
                : "Could not delete the scheduled message.",
        );
    }
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
        renderScheduledMessages(elements);
        renderFormEnhancements(elements);

        uiState.previousDescription = description;
        scheduleSessionRefresh(elements, sessionAccess, description);
    } catch (error) {
        clearSessionRefresh(elements);
        renderSessionState(elements, {
            label: "Unavailable",
            tone: "danger",
            connection: "Could not reach the API service.",
            note: error instanceof Error && error.message
                ? error.message
                : "Check whether the API service is reachable.",
            lastEventLabel: "",
            clientLabel: "",
            showQr: false,
            qrCodeDataUrl: "",
            reconnectAttempt: 0,
            nextReconnectAt: "",
        });
        renderSessionProgress(elements, { phase: "error" });
        renderRecipientDirectory(elements, null);
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

    const editingScheduledMessageId = String(elements.uiState.editingScheduledMessageId || "").trim();
    const isEditing = Boolean(editingScheduledMessageId);

    setFeedback(elements.formFeedback, "info", isEditing ? "Saving changes..." : "Scheduling message...");
    elements.submitButton.disabled = true;

    try {
        const targetPayload = resolveScheduledMessageTarget({
            selectedRecipientValue: elements.recipientPicker?.value,
            phoneNumber: elements.phoneNumber?.value,
        });
        const response = await requestApi(isEditing
            ? `/messages/${encodeURIComponent(editingScheduledMessageId)}`
            : "/messages", {
            method: isEditing ? "PUT" : "POST",
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
            isEditing,
        });

        const scheduledMessage = response.data && response.data.scheduledMessage ? response.data.scheduledMessage : null;
        let successMessage = isEditing ? "Scheduled message updated." : "Message scheduled successfully.";
        if (scheduledMessage && scheduledMessage.scheduledFor) {
            successMessage += " Planned for " + formatIsoForDisplay(scheduledMessage.scheduledFor) + ".";
        }

        setFeedback(elements.formFeedback, "success", successMessage);

        if (scheduledMessage) {
            elements.uiState.scheduledMessages = upsertScheduledMessageInCollection(elements.uiState.scheduledMessages, scheduledMessage);
            renderScheduledMessages(elements);
        }

        if (isEditing) {
            resetScheduleForm(elements, { preserveRecipient: false });
        } else {
            if (elements.message) {
                elements.message.value = "";
            }
            if (elements.scheduledFor) {
                elements.scheduledFor.value = createDefaultScheduledDateTime();
            }
            setActivePreset(elements, "");
            renderFormEnhancements(elements);
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
    void refreshScheduledMessages(elements, activeSessionAccess);

    elements.sessionCheckNow?.addEventListener("click", function() {
        setFeedback(elements.formFeedback, "info", "Checking session status now...");
        void refreshSessionState(elements, activeSessionAccess, { force: true });
    });

    elements.scheduleRefresh?.addEventListener("click", function() {
        void refreshScheduledMessages(elements, activeSessionAccess, { announce: true });
    });

    elements.scheduleList?.addEventListener("click", function(event) {
        const actionButton = event.target instanceof HTMLElement
            ? event.target.closest("[data-action=delete][data-scheduled-message-id]")
            : null;

        if (!actionButton) {
            return;
        }

        const scheduledMessage = elements.uiState.scheduledMessages
            .find(entry => entry.id === actionButton.dataset.scheduledMessageId) || null;

        if (scheduledMessage) {
            void deleteScheduledMessage(elements, activeSessionAccess, scheduledMessage);
        }
    });

    elements.form.addEventListener("submit", function(event) {
        submitSchedule(event, elements, activeSessionAccess);
    });
}

initSchedulerPage();
