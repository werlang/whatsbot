# WhatsBot repository instructions

## Current architecture
- This repo contains **two independent Node services**: `api/` and `web/`.
- Both services use **ES modules** and **Express 5**.
- Root orchestration lives in `compose.yaml` with development overrides in `compose.dev.yaml`.
- Persistence is MySQL plus the `whatsapp_auth` named Docker volume used by `whatsapp-web.js` `LocalAuth`.
- The web app serves direct static JS/CSS from `web/public/`; do **not** assume a Webpack pipeline exists here.

## API rules
- Keep the API centered on the current route surface:
  - `POST /messages`
  - `GET /whatsapp/session`
  - `POST /whatsapp/sessions`
  - `GET /whatsapp/sessions/:sessionId`
  - `GET /ready`
- Runtime schema patching is development-only. Do not treat app-startup SQL execution or `ALTER TABLE`-style changes as the production migration strategy; production deployments must use explicit planned migrations.
- Preserve the existing response envelope shape:
  - success: `{ error: false, status, data, message? }`
  - error: `{ error: true, status, type, message, data? }`
- MySQL access flows through `api/helpers/mysql.js`, `api/model/model.js`, and model classes such as `api/model/scheduled-message.js`.
- Background delivery behavior belongs in `api/background/`. Per-session WhatsApp lifecycle behavior belongs in `api/services/whatsapp-client-manager.js`, and cross-session orchestration belongs in `api/services/whatsapp-session-manager.js`.
- `whatsapp-web.js` is unofficial and depends on QR pairing plus Chromium in Docker; do not describe it like an official WhatsApp Business API integration.

## Web rules
- The web service is an SSR Mustache app with a scheduler page at `/`, a dedicated login/pairing page at `/login`, and readiness JSON at `/ready`.
- Browser behavior lives in plain modules under `web/public/js/`.
- Keep the current pattern of server-rendered HTML plus lightweight browser helpers.
- The scheduler page posts directly to the API and polls live session state for QR/readiness updates. The login page creates one WhatsApp session and monitors its pairing state.

## Testing and tooling
- Both services currently use the **Node test runner** via `node --test`, exposed as `npm test`.
- Do **not** introduce docs or guidance that claim Jest or Webpack are part of the current default workflow unless the code actually changes to add them.

## Documentation guardrails
- Audit `whatsbot` code before updating docs; code wins over copied structure.
- Remove stale `event-hub` language such as auth, events, dashboard, Google Calendar, Webpack, or Jest unless the destination repo truly gains those features.
- Prefer smaller accurate docs over large migrated docs with inherited false claims.

## Code style conventions already present
- Add JSDoc blocks to named functions, methods, getters/setters, and reusable local helpers.
- Prefer small focused modules and classes over large mixed-responsibility files.
- Keep route modules explicit about their own data flow.
- Prefer readable direct code over clever abstractions.
