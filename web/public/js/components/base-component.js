/**
 * Small DOM component base that tracks event listeners for safe cleanup.
 */
export class BaseComponent {
    #element;
    #subscriptions = [];

    /**
     * @param {Element|null} element
     */
    constructor(element = null) {
        this.#element = element;
    }

    /**
     * Returns the wrapped DOM element.
     *
     * @returns {Element|null}
     */
    get() {
        return this.#element;
    }

    /**
     * Replaces the wrapped DOM element.
     *
     * @param {Element|null} element
     * @returns {BaseComponent}
     */
    setElement(element) {
        this.#element = element;
        return this;
    }

    /**
     * Reports whether the component currently wraps a DOM element.
     *
     * @returns {boolean}
     */
    isReady() {
        return Boolean(this.#element);
    }

    /**
     * Registers and tracks an event listener for later cleanup.
     *
     * @param {EventTarget} target
     * @param {string} eventName
     * @param {EventListener} listener
     * @param {AddEventListenerOptions|boolean} options
     * @returns {BaseComponent}
     */
    on(target, eventName, listener, options) {
        if (!target || typeof target.addEventListener !== 'function' || typeof listener !== 'function') {
            return this;
        }

        target.addEventListener(eventName, listener, options);
        this.#subscriptions.push({ target, eventName, listener, options });
        return this;
    }

    /**
     * Removes every listener registered through this component.
     *
     * @returns {BaseComponent}
     */
    clearListeners() {
        this.#subscriptions.forEach(({ target, eventName, listener, options }) => {
            target.removeEventListener(eventName, listener, options);
        });
        this.#subscriptions = [];
        return this;
    }

    /**
     * Destroys the component lifecycle hooks.
     *
     * @returns {BaseComponent}
     */
    destroy() {
        return this.clearListeners();
    }
}
