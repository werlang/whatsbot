import { HttpError } from "./error.js";
import {
    CONTACT_TARGET_TYPE,
    GROUP_TARGET_TYPE,
    normalizeMessageTarget,
} from "./message-target.js";

const ptBrCollator = new Intl.Collator("pt-BR");

/**
 * Normalizes a recipient name or search query by trimming, removing combining marks, and lowercasing.
 *
 * @param {unknown} value Candidate recipient name or search query.
 * @returns {string} Normalized folded string, or an empty string for non-string input.
 */
function normalizeRecipientName(value) {
    if (typeof value !== "string") {
        return "";
    }

    return value
        .trim()
        .normalize("NFD")
        .replace(/\p{Mn}/gu, "")
        .toLowerCase();
}

/**
 * Safely converts one cached directory entry into a validated candidate keyed by canonical id.
 *
 * @param {object} entry Raw cached contact or group directory entry.
 * @param {string} expectedType Expected directory bucket type ('contact' or 'group').
 * @returns {{ id: string, name: string, targetType: string, targetValue: string, displayIdentifier: string }|null} Candidate or null.
 */
function toDirectoryCandidate(entry, expectedType) {
    if (!entry || typeof entry !== "object") {
        return null;
    }

    const rawAddress = entry.id ?? entry.chatId ?? entry.targetValue ?? entry.phoneNumber;

    let normalizedTarget;
    try {
        normalizedTarget = normalizeMessageTarget({
            targetType: expectedType,
            targetValue: rawAddress,
        });
    } catch {
        return null;
    }

    if (expectedType === GROUP_TARGET_TYPE) {
        const displayName = String(entry.name ?? entry.label ?? normalizedTarget.targetValue).trim()
            || normalizedTarget.targetValue;

        return {
            id: normalizedTarget.targetValue,
            name: displayName,
            targetType: GROUP_TARGET_TYPE,
            targetValue: normalizedTarget.targetValue,
            displayIdentifier: normalizedTarget.targetValue,
        };
    }

    const displayName = String(entry.name ?? entry.label ?? "").trim();
    if (!displayName) {
        return null;
    }

    const canonicalId = `${normalizedTarget.phoneNumber}@c.us`;
    return {
        id: canonicalId,
        name: displayName,
        targetType: CONTACT_TARGET_TYPE,
        targetValue: canonicalId,
        displayIdentifier: normalizedTarget.phoneNumber,
    };
}

/**
 * Collects unique addressable contact and group candidates from a cached directory snapshot.
 *
 * @param {{ contacts?: Array<object>, groups?: Array<object> }} [chatDirectory] Session chat directory.
 * @returns {Array<{ id: string, name: string, targetType: string, targetValue: string, displayIdentifier: string }>} Unique candidates.
 */
function readUniqueDirectoryCandidates(chatDirectory) {
    const candidatesById = new Map();
    const groups = [
        [CONTACT_TARGET_TYPE, chatDirectory?.contacts],
        [GROUP_TARGET_TYPE, chatDirectory?.groups],
    ];

    for (const [bucketType, entries] of groups) {
        for (const entry of Array.isArray(entries) ? entries : []) {
            const candidate = toDirectoryCandidate(entry, bucketType);
            if (candidate && !candidatesById.has(candidate.id)) {
                candidatesById.set(candidate.id, candidate);
            }
        }
    }

    return [...candidatesById.values()];
}

/**
 * Resolves a human recipient name query synchronously against a cached chat directory.
 *
 * @param {string} recipient Non-empty recipient name query.
 * @param {{ contacts?: Array<object>, groups?: Array<object> }} [chatDirectory] Cached session directory.
 * @param {{ targetType?: string }} [options] Optional explicit targetType consistency check.
 * @returns {{ targetType: string, targetValue: string }} Canonical target payload ready for normalizeMessageTarget.
 */
function resolveRecipientTarget(recipient, chatDirectory, { targetType } = {}) {
    if (typeof recipient !== "string") {
        throw new HttpError(400, "recipient must be a non-empty name string.");
    }

    const trimmedQuery = recipient.trim();
    const normalizedQuery = normalizeRecipientName(trimmedQuery);

    if (!normalizedQuery) {
        throw new HttpError(400, "recipient must be a non-empty name string.");
    }

    const matches = readUniqueDirectoryCandidates(chatDirectory)
        .filter(candidate => normalizeRecipientName(candidate.name).includes(normalizedQuery));

    if (matches.length === 0) {
        throw new HttpError(400, `No recipient found for "${trimmedQuery}".`);
    }

    if (matches.length > 1) {
        matches.sort((left, right) => (
            ptBrCollator.compare(left.name, right.name)
            || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
        ));
        const formattedCandidates = matches
            .map(match => `${match.name} (${match.displayIdentifier})`)
            .join("; ");

        throw new HttpError(
            400,
            `Multiple recipients found for "${trimmedQuery}": ${formattedCandidates}. Use phoneNumber or targetValue to choose.`,
        );
    }

    const [match] = matches;
    const explicitTargetType = String(targetType ?? "").trim().toLowerCase();

    if (explicitTargetType) {
        if (explicitTargetType !== CONTACT_TARGET_TYPE && explicitTargetType !== GROUP_TARGET_TYPE) {
            throw new HttpError(400, "targetType must be either 'contact' or 'group'.");
        }

        if (explicitTargetType !== match.targetType) {
            throw new HttpError(400, "targetType does not match the resolved recipient.");
        }
    }

    return {
        targetType: match.targetType,
        targetValue: match.targetValue,
    };
}

export {
    normalizeRecipientName,
    resolveRecipientTarget,
};
