import { BaseComponent } from './base-component.js';
import { Translator } from '../helpers/translate.js';

const DEFAULT_DURATION = 5000;
const FADE_OFFSET_MS = 100;
const CLOSE_TRANSITION_MS = 180;
const FLASH_STORAGE_KEY = 'template_flash_toast';
const TOAST_SELECTOR = '.toast';
const TOAST_CONTAINER_SELECTOR = '.toast-container';

const toastGroupMap = new WeakMap();

/**
 * Returns session storage when the current browser allows access.
 *
 * @returns {Storage|null}
 */
function getSessionStorage() {
    try {
        return globalThis.sessionStorage || null;
    }
    catch {
        return null;
    }
}

/**
 * Normalizes the requested toast tone.
 *
 * @param {string} tone
 * @returns {'info'|'success'|'warning'|'error'}
 */
function normalizeTone(tone) {
    const normalizedTone = String(tone || 'info').trim().toLowerCase();
    return ['success', 'warning', 'error'].includes(normalizedTone) ? normalizedTone : 'info';
}

/**
 * Normalizes the toast screen position.
 *
 * @param {string} position
 * @returns {'center'|'end'}
 */
function normalizePosition(position) {
    return String(position || '').trim().toLowerCase() === 'center' ? 'center' : 'end';
}

/**
 * Reads duration from current and legacy option names.
 *
 * @param {{ duration?: number, timeout?: number, timeOut?: number }} options
 * @returns {number}
 */
function readDuration({ duration, timeout, timeOut } = {}) {
    const rawDuration = [duration, timeout, timeOut].find(value => value != null);
    const normalizedDuration = Number(rawDuration);
    return Number.isFinite(normalizedDuration) && normalizedDuration >= 0
        ? normalizedDuration
        : DEFAULT_DURATION;
}

/**
 * Appends string, node, or array content to the toast body.
 *
 * @param {Element} container
 * @param {unknown} content
 */
function appendToastContent(container, content) {
    if (!container || content == null) {
        return;
    }

    if (Array.isArray(content)) {
        content.forEach(item => appendToastContent(container, item));
        return;
    }

    if (typeof Node !== 'undefined' && content instanceof Node) {
        container.appendChild(content);
        return;
    }

    const text = String(content).trim();
    if (!text) {
        return;
    }

    const paragraph = document.createElement('p');
    paragraph.textContent = text;
    container.appendChild(paragraph);
}

/**
 * Removes empty toast containers after dismissals.
 */
function removeEmptyContainers() {
    if (!document || typeof document.querySelectorAll !== 'function') return;
    document.querySelectorAll(TOAST_CONTAINER_SELECTOR).forEach(container => {
        if (!container.querySelector(TOAST_SELECTOR)) {
            container.remove();
        }
    });
}

/**
 * Creates or returns the container for one toast position.
 *
 * @param {string} position
 * @returns {HTMLElement}
 */
function resolveToastContainer(position) {
    const normalizedPosition = normalizePosition(position);
    const selector = `${TOAST_CONTAINER_SELECTOR}.toast-container--${normalizedPosition}`;
    const existingContainer = document.querySelector(selector);
    if (existingContainer) {
        return existingContainer;
    }

    const container = document.createElement('div');
    container.className = `toast-container toast-container--${normalizedPosition}`;
    container.setAttribute('role', 'region');
    container.setAttribute('aria-label', new Translator().translate('Notifications'));
    document.body.appendChild(container);
    return container;
}

/**
 * DOM component for accessible, dismissible transient messages.
 */
export class Toast extends BaseComponent {
    #container;
    #title;
    #body;
    #closeButton;
    #duration;
    #fadeTimer = null;
    #dismissTimer = null;
    #removeTimer = null;
    #isClosed = false;

    /**
     * @param {unknown} content
     * @param {{ title?: string, tone?: string, type?: string, position?: string, duration?: number, timeout?: number, timeOut?: number, customClass?: string, group?: string, dismissible?: boolean }} options
     */
    constructor(content, {
        title = '',
        tone = 'info',
        type,
        position = 'end',
        duration,
        timeout,
        timeOut,
        customClass,
        group,
        dismissible = true,
    } = {}) {
        const element = document.createElement('section');
        element.className = 'toast';
        element.setAttribute('aria-atomic', 'true');

        const contentWrapper = document.createElement('div');
        contentWrapper.className = 'toast__content';

        const titleElement = document.createElement('strong');
        titleElement.className = 'toast__title';
        titleElement.hidden = true;

        const bodyElement = document.createElement('div');
        bodyElement.className = 'toast__body';

        const closeButton = document.createElement('button');
        closeButton.className = 'toast__close';
        closeButton.type = 'button';
        closeButton.setAttribute('aria-label', new Translator().translate('Close notification'));
        closeButton.textContent = '×';

        contentWrapper.append(titleElement, bodyElement);
        element.append(contentWrapper, closeButton);
        super(element);

        const normalizedGroup = typeof group === 'string' ? group.trim() : '';
        if (normalizedGroup) {
            Toast.dismissGroup(normalizedGroup);
            toastGroupMap.set(element, normalizedGroup);
        }

        this.#container = resolveToastContainer(position);
        this.#title = titleElement;
        this.#body = bodyElement;
        this.#closeButton = closeButton;
        this.#duration = readDuration({ duration, timeout, timeOut });

        this.#applyCustomClasses(customClass);
        this.on(this.#closeButton, 'click', () => this.close());
        this.setTone(type || tone);
        this.setTitle(title);
        this.setContent(content);

        this.#container.prepend(this.get());

        if (this.#duration > 0) {
            this.fade(this.#duration);
        }
    }

    /**
     * Creates a toast using the static API.
     *
     * @param {unknown} content
     * @param {object} options
     * @returns {Toast}
     */
    static show(content, options = {}) {
        return new Toast(content, options);
    }

    /**
     * Stores a toast payload to be displayed after the next navigation.
     *
     * @param {string} content
     * @param {object} options
     * @returns {Toast|null}
     */
    static flash(content, options = {}) {
        const normalizedContent = typeof content === 'string' ? content.trim() : '';
        if (!normalizedContent) {
            return null;
        }

        const storage = getSessionStorage();
        if (!storage) {
            return Toast.show(normalizedContent, options);
        }

        try {
            storage.setItem(FLASH_STORAGE_KEY, JSON.stringify({ content: normalizedContent, options }));
            return null;
        }
        catch {
            return Toast.show(normalizedContent, options);
        }
    }

    /**
     * Displays and clears the queued flash toast when one exists.
     *
     * @returns {Toast|null}
     */
    static consumeFlash() {
        const storage = getSessionStorage();
        if (!storage) {
            return null;
        }

        const rawPayload = storage.getItem(FLASH_STORAGE_KEY);
        if (!rawPayload) {
            return null;
        }

        storage.removeItem(FLASH_STORAGE_KEY);
        try {
            const payload = JSON.parse(rawPayload);
            return typeof payload?.content === 'string' && payload.content.trim()
                ? Toast.show(payload.content, payload.options || {})
                : null;
        }
        catch {
            return null;
        }
    }

    /**
     * Dismisses all visible toasts in a logical group.
     *
     * @param {string} group
     */
    static dismissGroup(group) {
        const normalizedGroup = typeof group === 'string' ? group.trim() : '';
        if (!normalizedGroup) {
            return;
        }

        document.querySelectorAll(TOAST_SELECTOR).forEach(element => {
            if (toastGroupMap.get(element) === normalizedGroup) {
                element.remove();
            }
        });
        removeEmptyContainers();
    }

    /**
     * Updates the semantic tone classes and live-region behavior.
     *
     * @param {string} tone
     * @returns {Toast}
     */
    setTone(tone) {
        const normalizedTone = normalizeTone(tone);
        this.get().classList.remove('toast--info', 'toast--success', 'toast--warning', 'toast--error');
        this.get().classList.add(`toast--${normalizedTone}`);
        this.get().setAttribute('role', normalizedTone === 'error' ? 'alert' : 'status');
        this.get().setAttribute('aria-live', normalizedTone === 'error' ? 'assertive' : 'polite');
        return this;
    }

    /**
     * Legacy type-oriented alias for setTone.
     *
     * @param {string} type
     * @returns {Toast}
     */
    setType(type) {
        return this.setTone(type);
    }

    /**
     * Sets the optional toast title.
     *
     * @param {string} title
     * @returns {Toast}
     */
    setTitle(title = '') {
        const normalizedTitle = typeof title === 'string' ? title.trim() : '';
        this.#title.hidden = !normalizedTitle;
        this.#title.textContent = normalizedTitle;
        return this;
    }

    /**
     * Replaces toast body content.
     *
     * @param {unknown} content
     * @returns {Toast}
     */
    setContent(content) {
        this.#body.replaceChildren();
        appendToastContent(this.#body, content);
        return this;
    }

    /**
     * Schedules the toast fade and removal lifecycle.
     *
     * @param {number} duration
     * @returns {Toast}
     */
    fade(duration = this.#duration) {
        const normalizedDuration = Number(duration);
        if (!Number.isFinite(normalizedDuration) || normalizedDuration <= 0 || this.#isClosed) {
            this.#clearTimerIndicator();
            return this;
        }

        this.#clearTimers();
        this.#duration = normalizedDuration;
        this.#syncTimerIndicator(normalizedDuration);

        this.#fadeTimer = globalThis.setTimeout(() => {
            if (!this.#isClosed) {
                this.get().classList.add('toast--fade');
            }
        }, Math.max(normalizedDuration - FADE_OFFSET_MS, 0));

        this.#dismissTimer = globalThis.setTimeout(() => this.close(), normalizedDuration);
        return this;
    }

    /**
     * Dismisses and removes the toast.
     *
     * @param {{ immediate?: boolean }} options
     * @returns {Toast}
     */
    close({ immediate = false } = {}) {
        if (this.#isClosed) {
            return this;
        }

        this.#isClosed = true;
        this.#clearTimers();
        this.#clearTimerIndicator();

        const removeToast = () => {
            this.clearListeners();
            this.get().remove();
            removeEmptyContainers();
        };

        if (immediate) {
            removeToast();
            return this;
        }

        this.get().classList.add('toast--fade');
        this.#removeTimer = globalThis.setTimeout(removeToast, CLOSE_TRANSITION_MS);
        return this;
    }

    /**
     * Applies extra classes from a whitespace-separated class list.
     *
     * @param {string} customClass
     */
    #applyCustomClasses(customClass) {
        if (typeof customClass !== 'string') {
            return;
        }

        customClass
            .split(/\s+/)
            .map(className => className.trim())
            .filter(Boolean)
            .forEach(className => this.get().classList.add(className));
    }

    /**
     * Clears lifecycle timers.
     */
    #clearTimers() {
        globalThis.clearTimeout(this.#fadeTimer);
        globalThis.clearTimeout(this.#dismissTimer);
        globalThis.clearTimeout(this.#removeTimer);
        this.#fadeTimer = null;
        this.#dismissTimer = null;
        this.#removeTimer = null;
    }

    /**
     * Starts the visible timed-progress indicator.
     *
     * @param {number} duration
     */
    #syncTimerIndicator(duration) {
        this.get().style.setProperty('--toast-duration', `${duration}ms`);
        this.get().classList.remove('toast--timed');
        void this.get().offsetWidth;
        this.get().classList.add('toast--timed');
    }

    /**
     * Removes the timed-progress indicator.
     */
    #clearTimerIndicator() {
        this.get().classList.remove('toast--timed');
        this.get().style.removeProperty('--toast-duration');
    }
}
