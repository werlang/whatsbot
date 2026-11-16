const DEFAULT_RESULT_LIMIT = 60;
const ptBrCollator = new Intl.Collator("pt-BR", { sensitivity: "base" });

/**
 * Folds one contact name or search query the same way as the API recipient helper: trim, NFD,
 * strip combining marks and lowercase.
 *
 * @param {unknown} value Raw name or query.
 * @returns {string} Folded comparison text.
 */
function foldContactSearchText(value) {
    return String(value ?? "")
        .trim()
        .normalize("NFD")
        .replace(/\p{Mn}/gu, "")
        .toLowerCase();
}

/**
 * Returns every digit from a phone number or JID, so a digits-only query can match either.
 *
 * @param {object} entry Normalized directory entry.
 * @returns {string} Digits-only identifier.
 */
function readContactSearchDigits(entry = {}) {
    return [entry.phoneNumber, entry.targetValue, entry.chatId]
        .filter(value => typeof value === "string" || typeof value === "number")
        .join("")
        .replace(/\D/g, "");
}

/**
 * Reports whether one directory entry matches a folded name substring or a digits-only query.
 *
 * @param {object} entry Normalized directory entry.
 * @param {string} foldedQuery Folded query text.
 * @param {string} digitsQuery Digits-only query, or an empty string.
 * @returns {boolean} True when the entry should be rendered.
 */
function matchesContactSearch(entry, foldedQuery, digitsQuery) {
    if (!foldedQuery) {
        return true;
    }

    if (foldContactSearchText(entry?.label).includes(foldedQuery)) {
        return true;
    }

    return Boolean(digitsQuery) && readContactSearchDigits(entry).includes(digitsQuery);
}

/**
 * Orders directory entries by their pt-BR name, then by canonical value for a stable list.
 *
 * @param {object} left Left entry.
 * @param {object} right Right entry.
 * @returns {number} Negative, zero or positive comparator result.
 */
function compareContactEntries(left, right) {
    return ptBrCollator.compare(String(left?.label ?? ""), String(right?.label ?? ""))
        || String(left?.targetValue ?? "").localeCompare(String(right?.targetValue ?? ""));
}

/**
 * Builds one capped, folded, sectioned contact search result for the picker modal.
 *
 * The cap is applied to the combined Contacts + Groups match list, so a directory with hundreds of
 * contacts cannot hide its groups behind the limit.
 *
 * @param {{ contacts?: object[], groups?: object[] }} directory Normalized recipient directory.
 * @param {string} query Raw search query.
 * @param {{ limit?: number }} [options] Maximum rendered rows.
 * @returns {{
 *   contacts: object[],
 *   groups: object[],
 *   totalMatches: number,
 *   totalRecipients: number,
 *   renderedCount: number,
 *   limit: number,
 *   summary: string,
 * }} Search result.
 */
function buildContactSearchResults(directory = {}, query = "", { limit = DEFAULT_RESULT_LIMIT } = {}) {
    const contacts = Array.isArray(directory?.contacts) ? directory.contacts : [];
    const groups = Array.isArray(directory?.groups) ? directory.groups : [];
    const normalizedLimit = Number.isFinite(Number(limit)) && Number(limit) > 0
        ? Math.floor(Number(limit))
        : DEFAULT_RESULT_LIMIT;
    const foldedQuery = foldContactSearchText(query);
    const digitsQuery = /^\d+$/.test(foldedQuery) ? foldedQuery : "";

    const contactMatches = contacts
        .filter(entry => matchesContactSearch(entry, foldedQuery, digitsQuery))
        .sort(compareContactEntries);
    const groupMatches = groups
        .filter(entry => matchesContactSearch(entry, foldedQuery, digitsQuery))
        .sort(compareContactEntries);
    const totalMatches = contactMatches.length + groupMatches.length;

    const rendered = [
        ...contactMatches.map(entry => ({ entry, section: "contacts" })),
        ...groupMatches.map(entry => ({ entry, section: "groups" })),
    ]
        .sort((left, right) => compareContactEntries(left.entry, right.entry)
            || left.section.localeCompare(right.section))
        .slice(0, normalizedLimit);

    const renderedContacts = rendered
        .filter(item => item.section === "contacts")
        .map(item => item.entry);
    const renderedGroups = rendered
        .filter(item => item.section === "groups")
        .map(item => item.entry);
    const renderedCount = rendered.length;

    return {
        contacts: renderedContacts,
        groups: renderedGroups,
        totalMatches,
        totalRecipients: contacts.length + groups.length,
        renderedCount,
        limit: normalizedLimit,
        summary: totalMatches > renderedCount
            ? `Showing ${renderedCount} of ${totalMatches} — refine your search`
            : "",
    };
}

/**
 * Builds up to two uppercase initials for one avatar placeholder.
 *
 * @param {unknown} label Contact or group name.
 * @returns {string} Initials, or "?" when the label is empty.
 */
function buildContactInitials(label) {
    const words = String(label ?? "").trim().split(/\s+/).filter(Boolean);

    if (words.length === 0) {
        return "?";
    }

    const first = [...words[0]][0] || "";
    const last = words.length > 1 ? [...words[words.length - 1]][0] || "" : "";

    return `${first}${last}`.toLocaleUpperCase("pt-BR") || "?";
}

/**
 * Formats one directory entry as the canonical picker option label used across the workspace.
 *
 * @param {object} entry Normalized directory entry.
 * @returns {string} "Name · phone" for contacts and "Name · Group" for groups.
 */
function formatContactEntryLabel(entry = {}) {
    const label = String(entry?.label || "Unknown").trim();

    if (entry?.phoneNumber) {
        return `${label} · ${entry.phoneNumber}`;
    }

    return `${label} · Group`;
}

export {
    buildContactInitials,
    buildContactSearchResults,
    foldContactSearchText,
    formatContactEntryLabel,
};
