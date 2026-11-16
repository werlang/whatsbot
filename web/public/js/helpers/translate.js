/**
 * Minimal translator used by the vendored node-aec components.
 *
 * WhatsBot has no i18n catalogue, so the first argument is the message: it is returned as-is.
 * Call sites pass readable English text instead of catalogue keys.
 */
export class Translator {
    /**
     * Returns one message unchanged.
     *
     * @param {string} message Human-readable message or legacy catalogue key.
     * @param {string} [_scope] Legacy namespace retained for component compatibility.
     * @returns {string} Trimmed message.
     */
    translate(message, _scope) {
        return typeof message === "string" ? message.trim() : "";
    }
}
