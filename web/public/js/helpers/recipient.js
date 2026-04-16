const CONTACT_TARGET_TYPE = "contact";
const GROUP_TARGET_TYPE = "group";

/**
 * Normalizes one session directory payload into predictable recipient arrays.
 */
function readRecipientDirectory(session = {}) {
    const chatDirectory = session?.chatDirectory && typeof session.chatDirectory === "object"
        ? session.chatDirectory
        : {};

    return {
        contacts: normalizeRecipientEntries(chatDirectory.contacts, CONTACT_TARGET_TYPE),
        groups: normalizeRecipientEntries(chatDirectory.groups, GROUP_TARGET_TYPE),
        refreshedAt: typeof chatDirectory.refreshedAt === "string"
            ? chatDirectory.refreshedAt
            : null,
    };
}

/**
 * Encodes one recipient entry into the select option value.
 */
function buildRecipientChoiceValue(entry = {}) {
    return `${entry.targetType}:${entry.targetValue}`;
}

/**
 * Parses one select option value back into a scheduled-message target payload.
 */
function parseRecipientChoiceValue(value) {
    const normalizedValue = String(value ?? "").trim();

    if (!normalizedValue) {
        return null;
    }

    const separatorIndex = normalizedValue.indexOf(":");

    if (separatorIndex <= 0 || separatorIndex === normalizedValue.length - 1) {
        return null;
    }

    return {
        targetType: normalizedValue.slice(0, separatorIndex),
        targetValue: normalizedValue.slice(separatorIndex + 1),
    };
}

/**
 * Resolves the final scheduling payload from the recipient picker and manual input.
 */
function resolveScheduledMessageTarget({ selectedRecipientValue = "", phoneNumber = "" } = {}) {
    const selectedTarget = parseRecipientChoiceValue(selectedRecipientValue);

    if (selectedTarget) {
        return selectedTarget;
    }

    return {
        phoneNumber: String(phoneNumber ?? "").trim(),
    };
}

/**
 * Normalizes one recipient entry list while enforcing the expected target type.
 */
function normalizeRecipientEntries(entries, targetType) {
    return (Array.isArray(entries) ? entries : [])
        .map(entry => {
            const targetValue = typeof entry?.targetValue === "string"
                ? entry.targetValue.trim()
                : "";
            const label = typeof entry?.label === "string"
                ? entry.label.trim()
                : "";
            const phoneNumber = typeof entry?.phoneNumber === "string"
                ? entry.phoneNumber.trim()
                : null;

            if (!targetValue || !label) {
                return null;
            }

            return {
                targetType,
                targetValue,
                label,
                phoneNumber,
            };
        })
        .filter(Boolean);
}

export {
    buildRecipientChoiceValue,
    parseRecipientChoiceValue,
    readRecipientDirectory,
    resolveScheduledMessageTarget,
};