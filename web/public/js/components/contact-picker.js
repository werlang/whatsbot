import { requestApi } from "../helpers/api.js";
import {
    buildContactInitials,
    buildContactSearchResults,
    formatContactEntryLabel,
} from "../helpers/contact-directory.js";
import {
    buildRecipientChoiceValue,
    formatPhoneNumberForDisplay,
    readRecipientDirectory,
} from "../helpers/recipient.js";
import { buildSessionAccessHeaders } from "../helpers/session-id.js";
import { Modal } from "./modal.js";

const AVATAR_HIT_TTL_MS = 15 * 60 * 1000;
const AVATAR_MISS_TTL_MS = 2 * 60 * 1000;
const AVATAR_MAX_CONCURRENCY = 4;
const AVATAR_REQUEST_DEADLINE_MS = 5000;
const avatarCache = new Map();

/**
 * Reads one cached avatar result.
 *
 * @param {string} key Canonical target key.
 * @returns {{ found: boolean, url: string|null }} Cache lookup result.
 */
function readCachedAvatar(key) {
    const cached = avatarCache.get(key);

    if (!cached) {
        return { found: false, url: null };
    }

    if (cached.expiresAt <= Date.now()) {
        avatarCache.delete(key);
        return { found: false, url: null };
    }

    return { found: true, url: cached.url };
}

/**
 * Stores one avatar result with the TTL that matches a hit or a miss.
 *
 * @param {string} key Canonical target key.
 * @param {string|null} url Profile picture URL or null when WhatsApp has no photo.
 */
function writeCachedAvatar(key, url) {
    avatarCache.set(key, {
        url: url || null,
        expiresAt: Date.now() + (url ? AVATAR_HIT_TTL_MS : AVATAR_MISS_TTL_MS),
    });
}

/**
 * Formats the phone number (or group JID) shown under a contact name.
 *
 * @param {object} entry Normalized directory entry.
 * @returns {string} Human-readable identifier.
 */
function formatEntryIdentifier(entry) {
    if (entry?.targetType === "group") {
        return String(entry.targetValue || "");
    }

    const phoneNumber = entry?.phoneNumber || entry?.targetValue || "";
    return formatPhoneNumberForDisplay(phoneNumber) || String(phoneNumber);
}

/**
 * Formats one recipient count for concise helper copy.
 *
 * @param {number} count Entry count.
 * @param {string} label Singular noun.
 * @returns {string} Human-readable count.
 */
function formatRecipientCount(count, label) {
    return `${count} ${label}${count === 1 ? "" : "s"}`;
}

/**
 * Contact and group picker backed by the vendored node-aec Modal.
 *
 * The hidden `#recipient-picker` remains the canonical form value. The picker only renders the
 * search UI, keeps the lazy avatar queue and synchronizes the visible read-only label.
 */
export class ContactPicker {
    #elements;
    #getSessionAccess;
    #onSelect;
    #onClear;
    #modal = null;
    #session = null;
    #directory = { contacts: [], groups: [], refreshedAt: null };
    #labelByValue = new Map();
    #renderedEntryByKey = new Map();
    #selectedFallbackLabel = "";
    #avatarObserver = null;
    #avatarAbortController = null;
    #avatarQueue = [];
    #avatarActive = 0;
    #avatarGeneration = 0;
    #initialized = false;

    /**
     * @param {object} options Picker dependencies.
     * @param {object} options.elements DOM handles for the modal and selection row.
     * @param {() => { sessionId: string, accessToken: string }} options.getSessionAccess Current session access.
     * @param {(entry: object) => void} [options.onSelect] Selection callback.
     * @param {() => void} [options.onClear] Clear callback.
     */
    constructor({ elements, getSessionAccess, onSelect, onClear }) {
        this.#elements = elements;
        this.#getSessionAccess = getSessionAccess;
        this.#onSelect = onSelect;
        this.#onClear = onClear;
    }

    /**
     * Wires modal and keyboard listeners once the DOM is available.
     *
     * @returns {ContactPicker}
     */
    init() {
        if (this.#initialized || !this.#elements?.modal) {
            return this;
        }

        this.#initialized = true;
        this.#modal = new Modal(this.#elements.modal, {
            onClose: () => this.#handleClose(),
        });

        this.#elements.search?.addEventListener("input", () => {
            this.#renderResults();
        });

        this.#elements.search?.addEventListener("keydown", (event) => {
            if (event.key !== "ArrowDown") {
                return;
            }

            const options = this.#readOptions();
            if (options.length === 0) {
                return;
            }

            event.preventDefault();
            options[0].focus();
        });

        this.#elements.results?.addEventListener("keydown", (event) => {
            this.#handleResultKeydown(event);
        });

        this.#elements.results?.addEventListener("click", (event) => {
            const row = event.target instanceof Element
                ? event.target.closest("[data-contact-key]")
                : null;
            const entry = row ? this.#renderedEntryByKey.get(row.dataset.contactKey || "") : null;

            if (entry) {
                this.#selectEntry(entry);
            }
        });

        this.syncSelectionLabel();
        return this;
    }

    /**
     * Opens the picker and renders the current directory snapshot.
     *
     * @returns {void}
     */
    open() {
        if (!this.#modal) {
            return;
        }

        this.#modal.open();
        this.#renderResults({ focusSearch: true });
    }

    /**
     * Closes the picker and stops every pending avatar request for this render.
     *
     * @returns {void}
     */
    close() {
        this.#modal?.close();
    }

    /**
     * Reports whether the picker is currently visible.
     *
     * @returns {boolean}
     */
    isOpen() {
        return Boolean(this.#elements?.modal?.classList?.contains("is-active"));
    }

    /**
     * Replaces the directory snapshot, refreshing an open dialog without moving focus.
     *
     * @param {object|null} session Latest session payload.
     * @returns {void}
     */
    updateDirectory(session) {
        this.#session = session;
        this.#directory = readRecipientDirectory(session);
        this.#labelByValue = new Map();

        for (const entry of [...this.#directory.contacts, ...this.#directory.groups]) {
            this.#labelByValue.set(buildRecipientChoiceValue(entry), formatContactEntryLabel(entry));
        }

        if (this.isOpen()) {
            this.#renderResults({ preserveFocus: true });
        }

        this.syncSelectionLabel();
    }

    /**
     * Returns the label map used by the queue rows and edit draft.
     *
     * @returns {Map<string, string>} Choice value to display label.
     */
    getLabelByValue() {
        return this.#labelByValue;
    }

    /**
     * Returns the short directory summary used beside the compose field.
     *
     * @returns {string} Field hint.
     */
    getDirectoryStatusText() {
        const state = this.#readDirectoryState();

        if (state.kind !== "ready") {
            return state.message;
        }

        return `Synced ${formatRecipientCount(this.#directory.contacts.length, "contact")} and ${formatRecipientCount(this.#directory.groups.length, "group")}.`;
    }

    /**
     * Sets the canonical hidden value and refreshes the visible selection label.
     *
     * @param {string} value Canonical choice value.
     * @param {{ fallbackLabel?: string }} [options] Label used when the target is not in the directory.
     * @returns {void}
     */
    setSelectedValue(value, { fallbackLabel = "" } = {}) {
        const normalizedValue = String(value ?? "").trim();
        this.#selectedFallbackLabel = normalizedValue ? String(fallbackLabel || "") : "";

        if (this.#elements.hiddenInput) {
            this.#elements.hiddenInput.value = normalizedValue;
        }

        this.syncSelectionLabel();
    }

    /**
     * Clears the canonical value and the read-only label.
     *
     * @returns {void}
     */
    clearSelection() {
        this.setSelectedValue("");
        this.#onClear?.();
    }

    /**
     * Returns the canonical hidden value.
     *
     * @returns {string} Choice value.
     */
    getSelectedValue() {
        return String(this.#elements?.hiddenInput?.value ?? "").trim();
    }

    /**
     * Re-reads the label for the current value after a directory poll.
     *
     * @returns {void}
     */
    syncSelectionLabel() {
        const value = this.getSelectedValue();
        const selection = this.#elements?.selection;
        const clearButton = this.#elements?.clearButton;

        if (selection) {
            selection.textContent = value
                ? (this.#labelByValue.get(value) || this.#selectedFallbackLabel || value)
                : "No contact selected";
        }

        if (clearButton) {
            clearButton.hidden = !value;
        }
    }

    /**
     * Handles keyboard navigation and selection inside the results list.
     *
     * @param {KeyboardEvent} event Result-row keydown.
     * @returns {void}
     */
    #handleResultKeydown(event) {
        const options = this.#readOptions();
        const row = event.target instanceof Element
            ? event.target.closest("[data-contact-key]")
            : null;
        const currentIndex = row ? options.indexOf(row) : -1;

        if (event.key === "Home" || event.key === "End") {
            event.preventDefault();
            const target = event.key === "Home" ? options[0] : options[options.length - 1];
            target?.focus();
            return;
        }

        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            if (options.length === 0) {
                return;
            }

            const delta = event.key === "ArrowDown" ? 1 : -1;
            const nextIndex = currentIndex < 0
                ? (delta > 0 ? 0 : options.length - 1)
                : Math.min(options.length - 1, Math.max(0, currentIndex + delta));
            options[nextIndex].focus();
            return;
        }

        if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            const entry = row ? this.#renderedEntryByKey.get(row.dataset.contactKey || "") : null;
            if (entry) {
                this.#selectEntry(entry);
            }
        }
    }

    /**
     * Returns the rendered option buttons in visual order.
     *
     * @returns {HTMLElement[]} Option rows.
     */
    #readOptions() {
        if (!this.#elements?.results) {
            return [];
        }

        return [...this.#elements.results.querySelectorAll("[data-contact-key]")];
    }

    /**
     * Applies one selection, closes the dialog and reports the chosen directory entry.
     *
     * @param {object} entry Selected normalized directory entry.
     * @returns {void}
     */
    #selectEntry(entry) {
        this.setSelectedValue(buildRecipientChoiceValue(entry), {
            fallbackLabel: formatContactEntryLabel(entry),
        });
        this.#modal?.close();
        this.#onSelect?.(entry);
    }

    /**
     * Stops avatar work when the dialog closes through any path.
     *
     * @returns {void}
     */
    #handleClose() {
        this.#stopAvatarLoading();
    }

    /**
     * Describes the current directory availability.
     *
     * @returns {{ kind: string, message: string, searchable: boolean }} Picker state.
     */
    #readDirectoryState() {
        if (!this.#session?.ready) {
            return {
                kind: "not-ready",
                message: "Pair WhatsApp to load contacts",
                searchable: false,
            };
        }

        if (!this.#directory.refreshedAt) {
            return {
                kind: "syncing",
                message: "Contacts are syncing",
                searchable: false,
            };
        }

        if (this.#directory.contacts.length + this.#directory.groups.length === 0) {
            return {
                kind: "empty",
                message: "No contacts found",
                searchable: false,
            };
        }

        return {
            kind: "ready",
            message: "Search by name or number.",
            searchable: true,
        };
    }

    /**
     * Rebuilds the dialog body from the latest directory snapshot and query.
     *
     * @param {{ focusSearch?: boolean, preserveFocus?: boolean }} [options] Focus behaviour.
     * @returns {void}
     */
    #renderResults({ focusSearch = false, preserveFocus = false } = {}) {
        const { results, search, empty, status, count } = this.#elements || {};
        if (!results || !search || !empty || !status) {
            return;
        }

        const activeKey = preserveFocus && results.contains(document.activeElement)
            ? document.activeElement.closest?.("[data-contact-key]")?.dataset.contactKey || ""
            : "";
        const scrollContainer = results.closest(".modal-body");
        const previousScrollTop = preserveFocus ? Number(scrollContainer?.scrollTop || 0) : 0;
        const state = this.#readDirectoryState();

        status.textContent = state.message;
        search.disabled = !state.searchable;
        this.#stopAvatarLoading();
        this.#avatarAbortController = typeof AbortController === "function" ? new AbortController() : null;
        results.replaceChildren();
        this.#renderedEntryByKey = new Map();

        if (!state.searchable) {
            empty.hidden = false;
            empty.textContent = state.message;
            if (count) {
                count.hidden = true;
            }
            return;
        }

        const searchResult = buildContactSearchResults(this.#directory, search.value);
        empty.hidden = searchResult.totalMatches > 0;
        empty.textContent = searchResult.totalMatches > 0 ? "" : "No matches";

        if (count) {
            count.hidden = !searchResult.summary;
            count.textContent = searchResult.summary;
        }

        const fragment = document.createDocumentFragment();
        this.#appendSection(fragment, "Contacts", "contacts", searchResult.contacts);
        this.#appendSection(fragment, "Groups", "groups", searchResult.groups);
        results.append(fragment);

        this.#startAvatarObserver();

        if (activeKey) {
            results.querySelector(`[data-contact-key="${CSS.escape(activeKey)}"]`)?.focus?.();
        }

        if (preserveFocus && scrollContainer) {
            scrollContainer.scrollTop = previousScrollTop;
        }

        if (focusSearch) {
            search.focus();
        }
    }

    /**
     * Appends one named result section when it has rows.
     *
     * @param {DocumentFragment} fragment Result fragment.
     * @param {string} title Visible section title.
     * @param {string} sectionKey Stable section id suffix.
     * @param {object[]} entries Directory entries.
     * @returns {void}
     */
    #appendSection(fragment, title, sectionKey, entries) {
        if (entries.length === 0) {
            return;
        }

        const section = document.createElement("div");
        section.className = "contact-picker__section";
        section.setAttribute("role", "group");
        const titleId = `contact-results-${sectionKey}`;
        section.setAttribute("aria-labelledby", titleId);

        const heading = document.createElement("p");
        heading.className = "contact-picker__section-title label-type";
        heading.id = titleId;
        heading.textContent = title;
        section.append(heading);

        for (const entry of entries) {
            section.append(this.#createRow(entry));
        }

        fragment.append(section);
    }

    /**
     * Builds one option row with its initials avatar.
     *
     * @param {object} entry Normalized directory entry.
     * @returns {HTMLButtonElement} Option row.
     */
    #createRow(entry) {
        const key = buildRecipientChoiceValue(entry);
        const row = document.createElement("button");
        row.type = "button";
        row.className = "contact-row";
        row.dataset.contactKey = key;
        row.setAttribute("role", "option");
        row.setAttribute("aria-selected", "false");
        row.tabIndex = -1;

        const avatar = document.createElement("span");
        avatar.className = "contact-avatar";
        avatar.dataset.avatarKey = key;
        avatar.dataset.avatarState = "initials";
        avatar.textContent = buildContactInitials(entry.label);
        avatar.setAttribute("aria-hidden", "true");

        const text = document.createElement("span");
        text.className = "contact-row__text";

        const name = document.createElement("span");
        name.className = "contact-row__name";
        name.textContent = entry.label;

        const identifier = document.createElement("span");
        identifier.className = "contact-row__meta";
        identifier.textContent = formatEntryIdentifier(entry);

        text.append(name, identifier);
        row.append(avatar, text);
        this.#renderedEntryByKey.set(key, entry);
        return row;
    }

    /**
     * Starts observing the rendered avatars so only visible rows request a photo.
     *
     * @returns {void}
     */
    #startAvatarObserver() {
        const nodes = [...(this.#elements?.results?.querySelectorAll("[data-avatar-key]") || [])];
        if (nodes.length === 0) {
            return;
        }

        if (typeof IntersectionObserver !== "function") {
            nodes.forEach(node => this.#queueAvatarLoad(node));
            return;
        }

        const root = this.#elements.results.closest(".modal-body") || null;
        this.#avatarObserver = new IntersectionObserver((entries, observer) => {
            for (const entry of entries) {
                if (!entry.isIntersecting) {
                    continue;
                }

                observer.unobserve(entry.target);
                this.#queueAvatarLoad(entry.target);
            }
        }, { root, rootMargin: "80px 0px" });

        for (const node of nodes) {
            this.#avatarObserver.observe(node);
        }
    }

    /**
     * Stops observation and drops queued avatar work. In-flight requests are ignored when they
     * resolve because their generation no longer matches.
     *
     * @returns {void}
     */
    #stopAvatarLoading() {
        this.#avatarGeneration += 1;
        this.#avatarObserver?.disconnect();
        this.#avatarObserver = null;
        this.#avatarAbortController?.abort();
        this.#avatarAbortController = null;
        this.#avatarQueue = [];
    }

    /**
     * Queues one visible avatar after consulting the in-memory cache.
     *
     * @param {Element} node Avatar placeholder.
     * @returns {void}
     */
    #queueAvatarLoad(node) {
        const key = node?.dataset?.avatarKey || "";
        if (!key) {
            return;
        }

        const cached = readCachedAvatar(key);
        if (cached.found) {
            this.#applyAvatar(node, cached.url);
            return;
        }

        this.#avatarQueue.push({
            key,
            node,
            generation: this.#avatarGeneration,
            deadline: Date.now() + AVATAR_REQUEST_DEADLINE_MS,
            signal: this.#avatarAbortController?.signal || null,
        });
        this.#pumpAvatarQueue();
    }

    /**
     * Starts queued avatar lookups up to the concurrency limit.
     *
     * @returns {void}
     */
    #pumpAvatarQueue() {
        while (this.#avatarActive < AVATAR_MAX_CONCURRENCY && this.#avatarQueue.length > 0) {
            const job = this.#avatarQueue.shift();

            if (job.generation !== this.#avatarGeneration) {
                continue;
            }

            if (Date.now() >= job.deadline) {
                writeCachedAvatar(job.key, null);
                continue;
            }

            this.#avatarActive += 1;
            void this.#loadAvatar(job);
        }
    }

    /**
     * Requests one avatar URL and applies it only if the render generation is still current.
     *
     * @param {{ key: string, node: Element, generation: number, signal: AbortSignal|null }} job Avatar job.
     * @returns {Promise<void>} Resolves after the slot is released.
     */
    async #loadAvatar(job) {
        const sessionAccess = this.#getSessionAccess?.() || {};

        try {
            if (!sessionAccess.sessionId || !sessionAccess.accessToken) {
                writeCachedAvatar(job.key, null);
                return;
            }

            const [targetType, ...targetValueParts] = job.key.split(":");
            const targetValue = targetValueParts.join(":");
            const response = await requestApi(
                `/whatsapp/sessions/${encodeURIComponent(sessionAccess.sessionId)}/avatar`
                + `?targetType=${encodeURIComponent(targetType)}`
                + `&targetValue=${encodeURIComponent(targetValue)}`,
                {
                    headers: buildSessionAccessHeaders(sessionAccess.accessToken),
                    signal: job.signal || undefined,
                },
            );

            if (response.type === "AbortError") {
                return;
            }

            const url = response.ok && typeof response.data?.avatar?.url === "string"
                ? response.data.avatar.url.trim()
                : "";
            const resolvedUrl = url || null;

            writeCachedAvatar(job.key, resolvedUrl);

            if (job.generation === this.#avatarGeneration && job.node.isConnected) {
                this.#applyAvatar(job.node, resolvedUrl);
            }
        } catch {
            // Photos are decoration: a failed lookup keeps the initials and is retried later.
            writeCachedAvatar(job.key, null);
        } finally {
            this.#avatarActive = Math.max(0, this.#avatarActive - 1);
            this.#pumpAvatarQueue();
        }
    }

    /**
     * Layers a profile photo over the initials without removing the fallback.
     *
     * @param {Element} node Avatar placeholder.
     * @param {string|null} url Profile picture URL.
     * @returns {void}
     */
    #applyAvatar(node, url) {
        if (!node || node.dataset.avatarState === "loaded" || !url) {
            return;
        }

        node.dataset.avatarState = "loading";
        const image = document.createElement("img");
        image.className = "contact-avatar__image";
        image.alt = "";
        image.decoding = "async";
        image.loading = "lazy";
        image.referrerPolicy = "no-referrer";
        image.addEventListener("load", () => {
            node.dataset.avatarState = "loaded";
        });
        image.addEventListener("error", () => {
            image.remove();
            node.dataset.avatarState = "initials";
        });
        image.src = url;
        node.append(image);
    }
}
