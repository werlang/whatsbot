import { HttpError } from "./error.js";
import { normalizePhoneNumber } from "./phone-number.js";

const CONTACT_TARGET_TYPE = "contact";
const GROUP_TARGET_TYPE = "group";

/**
 * Normalizes one contact target value from either digits or a @c.us chat id.
 */
function normalizeContactTargetValue(value) {
    const rawValue = String(value ?? "").trim();
    const chatIdMatch = rawValue.match(/^(\d+)@c\.us$/i);
    return normalizePhoneNumber(chatIdMatch ? chatIdMatch[1] : rawValue);
}

/**
 * Normalizes one WhatsApp group chat id.
 */
function normalizeGroupTargetValue(value) {
    const normalizedValue = String(value ?? "").trim();

    if (!/@g\.us$/i.test(normalizedValue)) {
        throw new HttpError(400, "targetValue must be a valid WhatsApp group chat id.");
    }

    return normalizedValue;
}

/**
 * Normalizes the scheduled-message recipient into one typed target object.
 */
function normalizeMessageTarget(payload = {}) {
    const rawTargetType = String(payload.targetType ?? "").trim().toLowerCase();
    const rawTargetValue = payload.targetValue ?? payload.phoneNumber;
    const inferredTargetType = rawTargetType
        || (String(rawTargetValue ?? "").trim().toLowerCase().endsWith("@g.us")
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