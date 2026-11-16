import { BaseComponent } from './base-component.js';

const MODAL_TRANSITION_MS = 180;
const FOCUSABLE_SELECTOR = [
    'button:not([disabled])',
    '[href]',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
].join(', ');

/**
 * Returns visible keyboard targets within a modal.
 *
 * @param {HTMLElement} modal
 * @returns {HTMLElement[]}
 */
function getFocusableElements(modal) {
    return Array.from(modal.querySelectorAll(FOCUSABLE_SELECTOR))
        .filter(element => !element.hidden
            && element.getAttribute?.('aria-hidden') !== 'true'
            && !element.closest?.('[hidden]'));
}

/**
 * Reports whether one preferred focus target can actually receive focus.
 *
 * @param {HTMLElement|null} element
 * @returns {boolean}
 */
function canReceiveFocus(element) {
    return Boolean(element
        && !element.disabled
        && !element.hidden
        && !element.closest?.('[hidden]'));
}

/**
 * Reusable modal overlay DOM component.
 */
export class Modal extends BaseComponent {
    #initializedElement = null;
    #previousActiveElement = null;
    #onClose;

    /**
     * @param {HTMLElement|null} [element]
     * @param {{onClose?: () => void}} [options]
     */
    constructor(element = null, { onClose = undefined } = {}) {
        super(element);
        this.#onClose = onClose;
        this.initModal();
    }

    /**
     * Initializes modal triggers and event listeners.
     *
     * @returns {void}
     */
    initModal() {
        const modal = this.get();
        if (!modal || this.#initializedElement === modal) return;

        if (this.#initializedElement) {
            this.clearListeners();
        }
        this.#initializedElement = modal;

        const closeBtn = modal.querySelector('.modal-close');
        if (closeBtn) {
            this.on(closeBtn, 'click', () => this.close());
        }

        const overlay = modal.querySelector('.modal-overlay');
        this.on(modal, 'click', (event) => {
            if (event.target === modal || event.target === overlay) {
                this.close();
            }
        });

        this.on(modal, 'keydown', (event) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation?.();
                this.close();
                return;
            }
            if (event.key === 'Tab') {
                this.trapTabFocus(event);
            }
        });
    }

    /**
     * Keeps keyboard focus inside the active modal, including nested modals.
     *
     * @param {KeyboardEvent} event
     * @returns {void}
     */
    trapTabFocus(event) {
        const modal = this.get();
        if (!modal?.classList?.contains('is-active')) return;

        const focusable = getFocusableElements(modal);
        event.stopPropagation?.();
        if (!focusable.length) {
            event.preventDefault();
            return;
        }

        const activeElement = typeof document !== 'undefined'
            ? document.activeElement
            : event.target;
        const currentIndex = focusable.indexOf(activeElement);
        const isBackward = Boolean(event.shiftKey);
        const atBoundary = isBackward
            ? currentIndex <= 0
            : currentIndex === focusable.length - 1 || currentIndex < 0;
        if (!atBoundary) return;

        event.preventDefault();
        const target = isBackward ? focusable[focusable.length - 1] : focusable[0];
        target?.focus?.();
    }

    /**
     * Opens the modal overlay, starts its entry transition, and moves focus into its content.
     *
     * `[data-modal-autofocus]` wins over the generic first control so a confirmation can start on
     * its safest action and a search modal can start in the search field.
     *
     * @returns {void}
     */
    open() {
        const modal = this.get();
        if (!modal) return;

        this.initModal();
        const alreadyActive = typeof modal.classList.contains === 'function'
            && modal.classList.contains('is-active');
        if (!alreadyActive) {
            this.#previousActiveElement = typeof document !== 'undefined'
                ? document.activeElement
                : null;
        }

        modal.hidden = false;
        // Commit the hidden state before adding the active state so the
        // browser has two renderable states to interpolate between.
        void modal.offsetWidth;
        modal.classList.add('is-active');

        if (!alreadyActive) {
            const preferred = modal.querySelector('[data-modal-autofocus], [autofocus]');
            const fallback = modal.querySelector('.modal-close, input, button, select, textarea, a[href]');
            const focusTarget = [preferred, fallback].find(canReceiveFocus);
            focusTarget?.focus?.();
        }
    }

    /**
     * Starts the modal exit transition and optionally restores the previous
     * focus target.
     *
     * @param {{restoreFocus?: boolean}} [options]
     * @returns {void}
     */
    close({ restoreFocus = true } = {}) {
        const modal = this.get();
        if (!modal) return;

        modal.classList.remove('is-active');
        // Keep the shell renderable until the CSS transition finishes.
        globalThis.setTimeout(() => {
            if (!modal.classList.contains('is-active')) {
                modal.hidden = true;
            }
        }, MODAL_TRANSITION_MS);

        const previousActiveElement = this.#previousActiveElement;
        this.#previousActiveElement = null;
        if (restoreFocus) previousActiveElement?.focus?.();
        this.#onClose?.();
    }
}
