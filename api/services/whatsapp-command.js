import { HttpError } from "../helpers/error.js";
import { normalizePhoneNumber } from "../helpers/phone-number.js";

const COMMAND_PATTERN = /^\s*@whatsbot\b/i;
const SCHEDULED_AT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})$/;

/**
 * Reports whether one message body starts with the WhatsBot command prefix.
 */
function isWhatsBotCommand(value) {
    return COMMAND_PATTERN.test(String(value ?? ""));
}

/**
 * Parses one WhatsBot command into a schedule payload.
 */
function parseWhatsBotCommand(value) {
    const rawValue = String(value ?? "").trim();

    if (!isWhatsBotCommand(rawValue)) {
        throw new HttpError(400, "Command must start with @whatsbot.");
    }

    const tokens = rawValue.split(/\s+/);

    if (tokens.length < 4) {
        throw new HttpError(400, "Command must follow: @whatsbot <recipient> <scheduled_datetime> <message>.");
    }

    const [, rawRecipient, rawScheduledAt, ...messageTokens] = tokens;
    const message = messageTokens.join(" ").trim();

    if (!message) {
        throw new HttpError(400, "Command message is required after the scheduled date and time.");
    }

    return {
        phoneNumber: normalizePhoneNumber(rawRecipient),
        scheduledFor: normalizeCommandScheduledFor(rawScheduledAt),
        message,
    };
}

/**
 * Converts the command datetime token into one UTC ISO timestamp.
 */
function normalizeCommandScheduledFor(value) {
    const match = String(value ?? "").trim().match(SCHEDULED_AT_PATTERN);

    if (!match) {
        throw new HttpError(400, "scheduled_datetime must follow YYYY-MM-DD-HH-mm-ss.");
    }

    const [, year, month, day, hour, minute, second] = match;
    const numericYear = Number(year);
    const numericMonth = Number(month);
    const numericDay = Number(day);
    const numericHour = Number(hour);
    const numericMinute = Number(minute);
    const numericSecond = Number(second);
    const scheduledAt = new Date(
        numericYear,
        numericMonth - 1,
        numericDay,
        numericHour,
        numericMinute,
        numericSecond,
        0,
    );

    const isInvalidDate = Number.isNaN(scheduledAt.getTime())
        || scheduledAt.getFullYear() !== numericYear
        || scheduledAt.getMonth() !== numericMonth - 1
        || scheduledAt.getDate() !== numericDay
        || scheduledAt.getHours() !== numericHour
        || scheduledAt.getMinutes() !== numericMinute
        || scheduledAt.getSeconds() !== numericSecond;

    if (isInvalidDate) {
        throw new HttpError(400, "scheduled_datetime must be a valid local date and time.");
    }

    return scheduledAt.toISOString();
}

/**
 * Builds one confirmation message for a successful command schedule.
 */
function buildScheduledCommandReply(scheduledMessage) {
    return `Scheduled ${scheduledMessage.phoneNumber} for ${scheduledMessage.scheduledFor}.`;
}

/**
 * Builds one user-facing usage message when the command cannot be processed.
 */
function buildCommandErrorReply(error) {
    const message = String(error?.message || error || "Could not understand the command.").trim();
    return `${message} Use: @whatsbot <recipient> <scheduled_datetime> <message>.`;
}

export {
    buildCommandErrorReply,
    buildScheduledCommandReply,
    isWhatsBotCommand,
    normalizeCommandScheduledFor,
    parseWhatsBotCommand,
};