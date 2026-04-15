import { HttpError } from "./error.js";

const TIMEZONE_PATTERN = /(z|[+-]\d{2}:\d{2})$/i;
const EPOCH_PATTERN = /^\d+$/;

/**
 * Normalizes a scheduled timestamp into one UTC ISO string.
 */
function normalizeScheduledFor(value) {
    const rawValue = value instanceof Date ? value.toISOString() : String(value ?? "").trim();

    if (!rawValue) {
        throw new HttpError(400, "scheduledFor is required.");
    }

    const isStringValue = typeof value === "string" || value instanceof Date;
    const hasTimezoneInformation = TIMEZONE_PATTERN.test(rawValue) || EPOCH_PATTERN.test(rawValue);

    if (isStringValue && !hasTimezoneInformation) {
        throw new HttpError(400, "scheduledFor must include a timezone, for example 2026-04-15T18:30:00Z.");
    }

    const scheduledDate = new Date(rawValue);
    if (Number.isNaN(scheduledDate.getTime())) {
        throw new HttpError(400, "scheduledFor must be a valid ISO timestamp or timezone-aware date string.");
    }

    return scheduledDate.toISOString();
}

export { normalizeScheduledFor };
