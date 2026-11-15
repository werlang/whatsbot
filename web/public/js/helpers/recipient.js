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

/**
 * Formats a phone number or WhatsApp contact JID for display without mutating stored values.
 */
function formatPhoneNumberForDisplay(rawValue) {
    const raw = String(rawValue ?? "").trim();
    if (!raw) {
        return "";
    }

    if (raw.endsWith("@g.us")) {
        return raw;
    }

    const stripped = raw.replace(/@c\.us$/i, "");
    const digits = stripped.replace(/\D/g, "");
    if (digits.length < 8 || digits.length > 15) {
        return stripped;
    }

    if (digits.startsWith("55") && (digits.length === 12 || digits.length === 13)) {
        const area = digits.slice(2, 4);
        const subscriber = digits.slice(4);
        const splitAt = subscriber.length === 9 ? 5 : 4;
        return `+55 ${area} ${subscriber.slice(0, splitAt)}-${subscriber.slice(splitAt)}`;
    }

    if (digits.startsWith("1") && digits.length === 11) {
        return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
    }

    const ccLen = digits.length >= 11 ? 2 : 1;
    const cc = digits.slice(0, ccLen);
    const rest = digits.slice(ccLen);
    const groups = rest.match(/.{1,4}/g) || [rest];
    return `+${cc} ${groups.join(" ")}`;
}

export {
    buildRecipientChoiceValue,
    formatPhoneNumberForDisplay,
    parseRecipientChoiceValue,
    readRecipientDirectory,
    resolveScheduledMessageTarget,
};