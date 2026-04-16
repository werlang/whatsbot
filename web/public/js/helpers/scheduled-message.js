import { formatIsoForDisplay, toDateTimeLocalValue } from "./datetime.js";
import { buildRecipientChoiceValue } from "./recipient.js";

const EDITABLE_STATUSES = new Set(["pending", "failed"]);
const DELETABLE_STATUSES = new Set(["pending", "failed"]);

/**
 * Normalizes one scheduled-message status label.
 */
function normalizeScheduledMessageStatus(status) {
    const normalizedStatus = String(status || "pending").trim().toLowerCase();
    return normalizedStatus || "pending";
}

/**
 * Returns true when one scheduled message can be edited from the UI.
 */
function isScheduledMessageEditable(scheduledMessage = {}) {
    return EDITABLE_STATUSES.has(normalizeScheduledMessageStatus(scheduledMessage.status));
}

/**
 * Returns true when one scheduled message can be deleted from the UI.
 */
function isScheduledMessageDeletable(scheduledMessage = {}) {
    return DELETABLE_STATUSES.has(normalizeScheduledMessageStatus(scheduledMessage.status));
}

/**
 * Converts one scheduled message into form-friendly values.
 */
function buildScheduledMessageDraft(scheduledMessage = {}) {
    const recipientValue = buildRecipientChoiceValue({
        targetType: scheduledMessage.targetType,
        targetValue: scheduledMessage.targetValue,
    });

    return {
        id: String(scheduledMessage.id || "").trim(),
        recipientValue,
        phoneNumber: scheduledMessage.targetType === "contact"
            ? String(scheduledMessage.phoneNumber || scheduledMessage.targetValue || "").trim()
            : "",
        message: String(scheduledMessage.message || "").trim(),
        scheduledFor: scheduledMessage.scheduledFor
            ? toDateTimeLocalValue(new Date(scheduledMessage.scheduledFor))
            : "",
    };
}

/**
 * Returns one readable recipient label for the schedule list.
 */
function formatScheduledMessageRecipient(scheduledMessage = {}, recipientLabelByValue = new Map()) {
    const recipientValue = buildRecipientChoiceValue({
        targetType: scheduledMessage.targetType,
        targetValue: scheduledMessage.targetValue,
    });
    const knownLabel = recipientLabelByValue.get(recipientValue);

    if (knownLabel) {
        return knownLabel;
    }

    if (scheduledMessage.targetType === "group") {
        return String(scheduledMessage.targetValue || "Group").trim();
    }

    return String(scheduledMessage.phoneNumber || scheduledMessage.targetValue || "Unknown recipient").trim();
}

/**
 * Returns one concise view model for rendering schedule rows.
 */
function buildScheduledMessageViewModel(scheduledMessage = {}, recipientLabelByValue = new Map()) {
    const normalizedStatus = normalizeScheduledMessageStatus(scheduledMessage.status);
    const recipientLabel = formatScheduledMessageRecipient(scheduledMessage, recipientLabelByValue);
    const toneByStatus = {
        pending: "info",
        failed: "danger",
        sent: "success",
        processing: "warning",
    };

    return {
        id: String(scheduledMessage.id || "").trim(),
        recipientLabel,
        messagePreview: String(scheduledMessage.message || "").trim(),
        scheduledForLabel: formatIsoForDisplay(scheduledMessage.scheduledFor),
        status: normalizedStatus,
        statusLabel: normalizedStatus.charAt(0).toUpperCase() + normalizedStatus.slice(1),
        statusTone: toneByStatus[normalizedStatus] || "info",
        canEdit: isScheduledMessageEditable(scheduledMessage),
        canDelete: isScheduledMessageDeletable(scheduledMessage),
    };
}

/**
 * Builds the current form mode labels from one optional editing schedule.
 */
function createScheduleFormMode(editingScheduledMessage = null) {
    if (!editingScheduledMessage?.id) {
        return {
            kicker: "New",
            title: "Message",
            submitLabel: "Schedule",
            cancelLabel: "Cancel edit",
            isEditing: false,
        };
    }

    return {
        kicker: "Editing",
        title: "Message",
        submitLabel: "Save changes",
        cancelLabel: "Cancel edit",
        isEditing: true,
    };
}

/**
 * Returns the scheduled messages ordered by their planned send time.
 */
function sortScheduledMessages(messages = []) {
    return [...(Array.isArray(messages) ? messages : [])].sort((left, right) => {
        const leftTime = new Date(left?.scheduledFor || 0).getTime();
        const rightTime = new Date(right?.scheduledFor || 0).getTime();

        if (leftTime !== rightTime) {
            return leftTime - rightTime;
        }

        return String(left?.id || "").localeCompare(String(right?.id || ""));
    });
}

/**
 * Inserts or replaces one scheduled message inside an ordered collection.
 */
function upsertScheduledMessageInCollection(messages = [], scheduledMessage = null) {
    if (!scheduledMessage?.id) {
        return sortScheduledMessages(messages);
    }

    const filteredMessages = (Array.isArray(messages) ? messages : [])
        .filter(entry => String(entry?.id || "") !== String(scheduledMessage.id));

    return sortScheduledMessages([...filteredMessages, scheduledMessage]);
}

/**
 * Removes one scheduled message from an ordered collection.
 */
function removeScheduledMessageFromCollection(messages = [], scheduledMessageId = "") {
    return sortScheduledMessages((Array.isArray(messages) ? messages : [])
        .filter(entry => String(entry?.id || "") !== String(scheduledMessageId || "")));
}

export {
    buildScheduledMessageDraft,
    buildScheduledMessageViewModel,
    createScheduleFormMode,
    isScheduledMessageDeletable,
    isScheduledMessageEditable,
    removeScheduledMessageFromCollection,
    sortScheduledMessages,
    upsertScheduledMessageInCollection,
};