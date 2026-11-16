import { HttpError } from "./error.js";
import { normalizePhoneNumber } from "./phone-number.js";

const CONTACT_TARGET_TYPE = "contact";
const GROUP_TARGET_TYPE = "group";
const CONTACT_TARGET_PATTERN = /^(\d+)(?:@c\.us)?$/i;
const GROUP_TARGET_PATTERN = /^(\d+(?:-\d+)?)@g\.us$/i;

/**
 * Normalizes one contact target value from either digits or a @c.us chat id.
 *
 * @param {string|number} value Raw targetValue or phoneNumber input.
 * @returns {string} Canonical 10-to-15-digit phone number.
 */
function normalizeContactTargetValue(value) {
    const rawValue = typeof value === "string" || typeof value === "number"
        ? String(value).trim()
        : "";
    const match = rawValue.match(CONTACT_TARGET_PATTERN);

    if (!match) {
        throw new HttpError(400, "targetValue must be digits or a valid WhatsApp contact chat id.");
    }

    return normalizePhoneNumber(match[1]);
}

/**
 * Normalizes one WhatsApp group chat id.
 *
 * @param {string} value Raw WhatsApp group chat identifier.
 * @returns {string} Canonical lowercase @g.us group chat id.
 */
function normalizeGroupTargetValue(value) {
    const rawValue = typeof value === "string" ? value.trim() : "";
    const match = rawValue.match(GROUP_TARGET_PATTERN);

    if (!match) {
        throw new HttpError(400, "targetValue must be a valid WhatsApp group chat id.");
    }

    return `${match[1]}@g.us`;
}

/**
 * Normalizes the scheduled-message recipient into one typed target object.
 *
 * @param {{ targetType?: string, targetValue?: string|number, phoneNumber?: string|number }} [payload] Target payload.
 * @returns {{ targetType: string, targetValue: string, phoneNumber: string|null }} Canonical typed message target.
 */
function normalizeMessageTarget(payload = {}) {
    const source = payload && typeof payload === "object" ? payload : {};
    const rawTargetType = String(source.targetType ?? "").trim().toLowerCase();
    const rawTargetValue = source.targetValue ?? source.phoneNumber;
    const trimmedValue = typeof rawTargetValue === "string" ? rawTargetValue.trim().toLowerCase() : "";
    const inferredTargetType = rawTargetType
        || (trimmedValue.endsWith("@g.us")
            ? GROUP_TARGET_TYPE
            : CONTACT_TARGET_TYPE);

    if (inferredTargetType === GROUP_TARGET_TYPE) {
        return {
            targetType: GROUP_TARGET_TYPE,
            targetValue: normalizeGroupTargetValue(rawTargetValue),
            phoneNumber: null,
        };
    }

    if (inferredTargetType !== CONTACT_TARGET_TYPE) {
        throw new HttpError(400, "targetType must be either 'contact' or 'group'.");
    }

    const phoneNumber = normalizeContactTargetValue(rawTargetValue);

    return {
        targetType: CONTACT_TARGET_TYPE,
        targetValue: phoneNumber,
        phoneNumber,
    };
}

export {
    CONTACT_TARGET_TYPE,
    GROUP_TARGET_TYPE,
    normalizeMessageTarget,
};
