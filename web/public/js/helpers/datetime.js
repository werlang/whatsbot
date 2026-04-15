const DATETIME_LOCAL_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

/**
 * Pads a number with a leading zero.
 */
function padNumber(value) {
    return String(Math.abs(value)).padStart(2, "0");
}

/**
 * Formats a local Date instance as one datetime-local field value.
 */
export function toDateTimeLocalValue(date = new Date()) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
        return "";
    }

    return String(date.getFullYear())
        + "-"
        + padNumber(date.getMonth() + 1)
        + "-"
        + padNumber(date.getDate())
        + "T"
        + padNumber(date.getHours())
        + ":"
        + padNumber(date.getMinutes());
}

/**
 * Returns a nearby default scheduling value five minutes in the future.
 */
export function createDefaultScheduledDateTime(now = new Date()) {
    const scheduled = new Date(now.getTime());
    scheduled.setSeconds(0, 0);
    scheduled.setMinutes(scheduled.getMinutes() + 5);
    return toDateTimeLocalValue(scheduled);
}

/**
 * Converts one datetime-local value into an ISO string with explicit timezone offset.
 */
export function convertDateTimeLocalToOffsetIso(value) {
    const match = String(value || "").trim().match(DATETIME_LOCAL_PATTERN);
    if (!match) {
        throw new Error("Choose a valid scheduled date and time.");
    }

    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const hour = Number(match[4]);
    const minute = Number(match[5]);
    const second = Number(match[6] || "0");
    const date = new Date(year, month - 1, day, hour, minute, second, 0);

    if (
        Number.isNaN(date.getTime())
        || date.getFullYear() != year
        || date.getMonth() != month - 1
        || date.getDate() != day
        || date.getHours() != hour
        || date.getMinutes() != minute
        || date.getSeconds() != second
    ) {
        throw new Error("Choose a valid scheduled date and time.");
    }

    const offsetMinutes = -date.getTimezoneOffset();
    const sign = offsetMinutes >= 0 ? "+" : "-";
    const absoluteOffset = Math.abs(offsetMinutes);
    const offsetHours = padNumber(Math.floor(absoluteOffset / 60));
    const offsetRemainder = padNumber(absoluteOffset % 60);

    return String(date.getFullYear())
        + "-"
        + padNumber(date.getMonth() + 1)
        + "-"
        + padNumber(date.getDate())
        + "T"
        + padNumber(date.getHours())
        + ":"
        + padNumber(date.getMinutes())
        + ":"
        + padNumber(date.getSeconds())
        + sign
        + offsetHours
        + ":"
        + offsetRemainder;
}

/**
 * Formats one ISO timestamp for concise UI feedback.
 */
export function formatIsoForDisplay(value, locale) {
    const date = new Date(value || "");
    if (Number.isNaN(date.getTime())) {
        return "";
    }

    return new Intl.DateTimeFormat(locale, {
        dateStyle: "medium",
        timeStyle: "short",
    }).format(date);
}

/**
 * Returns the current browser timezone label for UI hints.
 */
export function getCurrentTimezoneLabel(now = new Date()) {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "Local time";
    const offsetMinutes = -now.getTimezoneOffset();
    const sign = offsetMinutes >= 0 ? "+" : "-";
    const absoluteOffset = Math.abs(offsetMinutes);
    const offsetHours = padNumber(Math.floor(absoluteOffset / 60));
    const offsetRemainder = padNumber(absoluteOffset % 60);

    return timeZone + " (UTC" + sign + offsetHours + ":" + offsetRemainder + ")";
}
