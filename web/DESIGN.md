# WhatsBot Design System

- **Surface mode:** Operate (scanability, precision, real usage density).
- **Visual world:** The dispatch board — departure boards, delivery receipts, and 24-hour clocks.
- **Signature element:** The "Next send" departure strip (`.board`, `#next-send`), pairing oversized tabular numerals, formatted recipient, a minute-ticked sodium progress track, and per-digit countdown animation.
- **Type:** `Big Shoulders Display` (workspace title), `Source Sans 3` (UI labels & body), `Martian Mono` (times, phone numbers, statuses, labels). All self-hosted as variable WOFF2 under `/fonts/`.
- **Palette:** Graphite/slate neutrals (`#0d0f11`–`#f4f6f7`), `sodium` amber (`#f2a516` / `#f7b847` / `#8c4f00`) reserved for time, `receipt` green (`#1b7449` / `#4fc48b`) for sent/ready, and `fault` red (`#b3312a` / `#f2766b`) for failures. Light and dark themes derive from semantic `light-dark()` tokens in `web/public/css/tokens.css`.

---

## 1. Tokens (`web/public/css/tokens.css`)

`:root` declares `color-scheme: light dark` so native controls, scrollbars, and `light-dark()` tokens adapt automatically to `prefers-color-scheme`.

### Palette Primitives

| Token | Value | Role |
|---|---|---|
| `--graphite-950` | `#0d0f11` | Darkest board ground |
| `--graphite-900` | `#16191c` | Dark ground / dark field |
| `--graphite-850` | `#1c2024` | Dark sheet / light board / light action ink |
| `--graphite-800` | `#23282d` | Dark raised sheet |
| `--graphite-700` | `#343b42` | Dark hairline rule |
| `--graphite-500` | `#5d666f` | Light muted ink / dark strong rule |
| `--graphite-400` | `#8a939b` | Dark muted ink |
| `--graphite-300` | `#b4bbc1` | Light strong rule |
| `--slate-200` | `#d5dade` | Light hairline rule / dark soft ink |
| `--slate-150` | `#e2e6e9` | Secondary slate stop |
| `--slate-100` | `#e9ecee` | Light ground |
| `--slate-50` | `#f4f6f7` | Light sheet / light inverse ink |
| `--sodium-500` | `#f2a516` | Board countdown & track fill |
| `--sodium-400` | `#f7b847` | Dark theme time accent & focus ring |
| `--sodium-700` | `#8c4f00` | Light theme time accent & focus ring |
| `--receipt-600` | `#1b7449` | Light theme delivered/ready |
| `--receipt-400` | `#4fc48b` | Dark theme delivered/ready |
| `--fault-600` | `#b3312a` | Light theme failed/error |
| `--fault-400` | `#f2766b` | Dark theme failed/error |

### Semantic Tokens

| Category | Token | Light | Dark |
|---|---|---|---|
| Surface | `--color-ground` | `#e9ecee` | `#16191c` |
| Surface | `--color-sheet` | `#f4f6f7` | `#1c2024` |
| Surface | `--color-sheet-raised` | `#fbfcfc` | `#23282d` |
| Surface | `--color-field` | `#ffffff` | `#16191c` |
| Rule | `--color-rule` | `#d5dade` | `#343b42` |
| Rule | `--color-rule-strong` | `#b4bbc1` | `#5d666f` |
| Ink | `--color-ink` | `#1c2024` | `#e6e9ec` |
| Ink | `--color-ink-soft` | `#343b42` | `#d5dade` |
| Ink | `--color-ink-muted` | `#5d666f` | `#8a939b` |
| Ink | `--color-ink-inverse` | `#f4f6f7` | `#16191c` |
| Signal (Time) | `--color-time` | `#8c4f00` | `#f7b847` |
| Signal (Time) | `--color-time-wash` | `#fbefd9` | `#3a2e17` |
| Signal (Sent) | `--color-sent` | `#1b7449` | `#4fc48b` |
| Signal (Sent) | `--color-sent-wash` | `#e1f1e8` | `#183326` |
| Signal (Failed) | `--color-failed` | `#b3312a` | `#f2766b` |
| Signal (Failed) | `--color-failed-wash` | `#f8e3e1` | `#3c1d1b` |
| Action | `--color-action` | `#1c2024` | `#e6e9ec` |
| Action | `--color-action-hover` | `#000000` | `#ffffff` |
| Action | `--color-action-ink` | `#ffffff` | `#16191c` |
| Focus | `--color-focus` | `#8c4f00` | `#f7b847` |

### Spacing, Shape, Motion & Layout Tokens

- **Spacing:** 4px base (`--space-1: 0.25rem` through `--space-12: 3rem`).
- **Shape:** `--radius-sm: 4px`, `--radius-md: 6px`, `--radius-lg: 10px`, `--hairline: 1px`.
- **Elevation:** `--shadow-overlay: 0 18px 48px rgb(13 15 17 / 0.28), 0 2px 6px rgb(13 15 17 / 0.12)` (only overlays/dialogs float; workspace regions are separated by hairlines and surface tints).
- **Motion:** `--ease-out: cubic-bezier(0.16, 1, 0.3, 1)`, `--duration-fast: 140ms`, `--duration-base: 220ms`, `--duration-slow: 600ms`. Non-essential animations and transitions sit inside `@media (prefers-reduced-motion: no-preference)`.
- **Layout:** `--topbar-height: 3.5rem`, `--compose-width: 27rem`, `--content-max: 90rem`, `--z-sticky: 10`, `--z-topbar: 20`.

---

## 2. Type Roles

| Role | Token | Font | Usage |
|---|---|---|---|
| Display | `--font-display` | `Big Shoulders Display` (700, uppercase, `0.01em` tracking) | Topbar workspace/page heading (`.topbar__heading`, `.gateway__title`) |
| Body | `--font-body` | `Source Sans 3` (400–650) | Labels, form fields, message copy, notes, buttons |
| Board / Data | `--font-board` | `Martian Mono` (87.5% / 75% stretch, `tabular-nums slashed-zero`) | Clocks, countdown digits, phone numbers, statuses, uppercase labels (`.label-type`), recovery codes |

Scale (fixed `rem`, ~1.2 ratio):
`--text-2xs: 0.6875rem`, `--text-xs: 0.75rem`, `--text-sm: 0.875rem`, `--text-md: 1rem`, `--text-lg: 1.125rem`, `--text-xl: 1.375rem`, `--text-2xl: 1.75rem`, `--text-board: 2.25rem`, `--text-board-lg: 3.25rem`.

---

## 3. CSS Architecture

Page entry stylesheets declare `@layer tokens, base, components;` up front, import `tokens.css`, `base.css`, and required component partials into their layers, and keep page-layout rules unlayered:

- `/session/:id` → `web/public/css/workspace.css`
- `/login` → `web/public/css/login.css`
- `/` → `web/public/css/gateway.css`

Component partials (`web/public/css/`):
`topbar.css`, `board.css`, `pane.css`, `compose.css`, `field.css`, `button.css`, `queue.css`, `status.css`, `session-panel.css`.
No `!important` declarations are used anywhere; `[hidden]` overrides are colocated with explicit `display` rules via `&[hidden] { display: none; }`.

---

## 4. Component Inventory & States

1. **Topbar (`.topbar`)**: Brand mark (`/img/mark.svg`), uppercase display heading, optional ready-account summary (`.topbar__account`, hidden until `ready`), `.state-chip`, and quiet navigation link.
2. **State Chip (`.state-chip` + `.lamp`)**: Live status lamp + label (`data-tone="info|warning|success|danger"`). Pulses on `info` / `warning` when motion is allowed.
3. **Departure Board (`.board`, `#next-send`)**:
   - `data-state="empty"`: Muted placeholders (`--:--`, `Nothing queued`, `The board is clear`, `--:--:--`), track fill hidden.
   - `data-state="active"`: Sodium countdown digits with per-character flip animation (`.is-turning`), hairline track filling to `--progress`.
   - `data-state="due"`: `00:00:00` with `Due · within 15s` label and pulsing track indicator.
4. **Workspace Tabs (`.workspace-tabs`)**: Mobile/tablet (`< 1024px`) `tablist` switching between Queue (`#tab-queue`, with live count badge) and New message (`#tab-compose`). Hidden at `>= 1024px`.
5. **Compose Pane (`.compose`)**:
   - Phone number input (`#phone-number`) is first-class, with live non-mutating formatted preview (`#phone-echo`).
   - Saved contacts/groups autocomplete (`#recipient-entry` + `#recipient-directory`), gracefully disabled with clear helper text when `chatDirectory` is empty.
   - Quick time presets (`.preset[aria-pressed="true|false"]`) + `datetime-local` input + timezone hint.
   - Sticky footer (`.compose__footer`) with inline `.feedback`, live `.compose__summary`, and primary `#schedule-submit` (`Schedule` / `Save changes`).
   - Edit mode shows `.mode-tag` (`Editing`) and `[data-role="schedule-cancel-edit"]`.
6. **Session Panel (`.session-panel`)**:
   - Hidden when `phase === "ready"` on `/session/:id`; always visible as the connection/QR pane on `/login`.
   - Tinted background automatically via `body:has(#session-status[data-tone="warning|danger"])`.
   - States covered: `starting`/`initializing` (loading % meter), `awaiting-qr` (QR + 3-step instructions), `connecting` (`Scan received`), `disconnected` (`reconnectAttempt` + live `nextReconnectAt` countdown in `#session-reconnect`), `needsQrCode` (`New QR required`), and API `error` (`Session unavailable`).
7. **Queue Pane (`.queue`)**:
   - Header tally (`.queue__tally`) highlighting failed count in `.queue__tally-failed`.
   - Inline error/info feedback (`#schedule-list-feedback`).
   - Loading skeleton (`.queue__loading` with `.ticket--skeleton`) shown prior to first `/messages` response.
   - Empty state (`.queue__empty`) with CTA (`#queue-empty-compose`) when loaded with 0 messages and no load error.
   - Grouped tickets (`.queue__group` + `.queue__rows`): `Upcoming` (earliest first, `data-next="true"` on first pending), `Needs attention` (failed, with `.ticket__error`), `Delivered` (sent, muted copy).
   - Each `.ticket` pairs icon + color + word in `.status-mark` (`i-clock` + `time`, `i-check` + `success`, `i-fault` + `danger`) and offers Edit/Delete icon buttons where permitted.
8. **Boarding Steps & Secret Dialog (`login.html`)**:
   - `.steps-bar`: 3-step graphite strip (`create`, `copy`, `scan`) with `data-state="active|completed|pending"`.
   - `.secret-dialog`: Native `<dialog>` top-layer modal showing the one-time recovery code (`.secret-dialog__code`), session ID, access token, copy status feedback, and `Copy code` / `Open scheduler` / `Close` actions.
9. **Gateway (`root.html`)**:
   - Quiet centered panel with `/img/mark.svg`, `Opening...`, hairline sodium sweep (`.gateway__track` / `.gateway__sweep`), direct `/login` link, and `<noscript>` fallback.

---

## 5. Layout & Responsive Rules

- Mobile-first CSS using `min-width` media queries (`640px`, `768px`, `1024px`, `1280px`) and `@container (min-width: 40rem)` on `.queue` so `.ticket` rows adapt to their container width.
- **Below `1024px`**: Single-column flow (`dvh`-safe), sticky `.board`, `.workspace-tabs` switches between Queue and Compose, `.compose__footer` sticks to the bottom edge with `safe-area-inset-bottom`.
- **`>= 1024px` (`/session/:id`)**: Fixed `100dvh` shell; two-column grid (`27rem` / `30rem` Compose on left with independently scrolling `.compose__body` and pinned `.compose__footer`; Queue scrolling independently on right).

---

## 6. Accessibility Floor

- Skip links (`.skip-link`) on both `/session/:id` and `/login`.
- Real `<label for="...">` elements on all inputs and `<fieldset>`/`<legend>` groupings.
- `:focus-visible` 2px solid `--color-focus` outline (`8c4f00` light / `f7b847` dark) on all interactive controls.
- `aria-live="polite"` on feedback banners, state chips, phone echo, compose summary, queue tally, and progress metadata; `role="timer"` on the board countdown; `role="tablist"`/`role="tab"` with arrow-key support on mobile workspace tabs.
- Never color-only status: every state pairs color with an icon (`icons.svg`) or lamp and explicit text label.
- Native `<dialog>.showModal()` handles focus trap, `Escape` dismissal, and `::backdrop` on the recovery code modal.

---

## 7. Intentionally Not Themable

- **The Departure Board (`.board`)**: Always dark graphite (`#1c2024` light / `#0d0f11` dark) with `#eef1f3` ink and `#f2a516` sodium numerals in both light and dark themes, preserving high-contrast clock legibility.
- **QR Code Surface (`.qr__image`)**: Always rendered on solid `#ffffff` padding in both light and dark themes so phone cameras can reliably scan dark-on-light QR modules.
- **Recovery Code Box (`.secret-dialog__code`)**: Always dark graphite (`--color-board`) with `--color-time-board` numerals for high visual separation inside the dialog.
