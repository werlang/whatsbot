import { HttpError } from "./error.js";

/**
 * Normalizes a WhatsApp phone number into digits only.
 */
function normalizePhoneNumber(value) {
    const digits = String(value ?? "").replace(/\D/g, "");

    if (digits.length < 10 || digits.length > 15) {
        throw new HttpError(400, "phoneNumber must contain between 10 and 15 digits.");
    }

    return digits;
}

/**
 * Converts a normalized phone number into the whatsapp-web.js chat id format.
 */
function toWhatsAppChatId(phoneNumber) {
    return `${normalizePhoneNumber(phoneNumber)}@c.us`;
}

export { normalizePhoneNumber, toWhatsAppChatId };
