# WhatsBot

WhatsBot is a small two-service Node application for scheduling WhatsApp messages. It is built around Docker Compose, MySQL persistence, and [`baileys`](https://github.com/WhiskeySockets/Baileys), a direct WebSocket WhatsApp client with no browser runtime.

> `baileys` is an unofficial WhatsApp client library. This project depends on QR pairing with a real WhatsApp account and can break when WhatsApp changes its protocol upstream.

## What is in this repository

- **`api/`**: Express 5 REST API that stores scheduled messages in MySQL, exposes session/readiness routes, starts the WhatsApp client, and runs the background dispatcher.
- **`web/`**: Express 5 + Mustache SSR app that serves one scheduler page at `/` plus direct static browser JS/CSS from `web/public/`. There is **no Webpack build** in the current project.
- **`compose.yaml`**: base runtime for `api`, `web`, and `mysql`.
- **`compose.dev.yaml`**: development override with bind mounts, Node watch mode, and the API inspector port.

The services are independent Node projects with their own `package.json` files and their own Node test suites.

## Architecture summary

### API

The API uses:

- Express 5 + ES modules
- `mysql2/promise` for MySQL access
- a `Mysql` helper and `Model`/`ScheduledMessage` model structure
- `baileys` + `useMultiFileAuthState` (one auth directory per session)
- a background `MessageDispatcher` polling loop

Current HTTP routes:

- `POST /messages` and `PUT /messages/:scheduledMessageId`
  - body: `{ sessionId?, phoneNumber | targetValue | recipient, targetType?, message, scheduledFor }`
  - `phoneNumber` / `targetValue` accept strict contact digits (10–15 digits or `<digits>@c.us`) or group chat ids (`<digits>@g.us` or `<digits>-<digits>@g.us`); formatted phone strings and `@lid` identifiers are rejected with HTTP 400
  - `recipient` resolves a single case/diacritic-insensitive contact or group name within the authorized session's `chatDirectory` (cannot be combined with non-null `phoneNumber` or `targetValue`; returns HTTP 400 when missing or ambiguous)
  - `scheduledFor` must include timezone information
  - `sessionId` defaults to `main` when omitted on `POST` and cannot be changed on `PUT`
  - returns the created or updated scheduled message in the standard envelope (without persisting `recipient`)
- `GET /whatsapp/session`
  - accepts optional `sessionId` query string and returns the current session state, including QR data when pairing is required, and `chatDirectory` (`{ contacts, groups, refreshedAt }`) with `{ id, name, targetType, targetValue, phoneNumber, chatId, label }` entries
- `POST /whatsapp/sessions`
  - creates one new WhatsApp app session with its own Baileys auth directory
- `GET /whatsapp/sessions/:sessionId`
  - returns the current state for a specific app session
- `GET /ready`
  - HTTP 200 readiness payload for the API runtime; `data.ready` requires a reachable MySQL database with both application tables, at least one ready WhatsApp session, and no recorded scheduler failure
  - includes `database`, explicit `reasons`, `whatsapp.readySessionIds`, and the last tick time, processed count, and error under `scheduler`; the database probe has a one-second deadline and does not cache success

The dispatcher only sends due messages when their owning WhatsApp session is ready. Messages remain pending if their session is still waiting for pairing or temporarily disconnected.

After the access registry initializes, startup restores the default session and registered sessions in the background. A session is a restoration candidate only when `baileys/<sessionId>/creds.json` exists and carries `registered` or `me`; unpaired credentials are skipped. Existing credentials do not guarantee valid pairing. Initial boots and recovery boots share a queue so only one WebSocket handshake runs at a time. An explicit session-state request still boots a skipped session so its QR remains available.

A dropped connection or failed boot first runs up to five fast rebuilds: immediately, then after 1, 2, 4, and 8 seconds (delays are capped at 30 seconds when configured for more attempts). Once the fast budget is exhausted the session keeps retrying at a fixed slow interval (`WHATSAPP_RECONNECT_SLOW_RETRY_MS`, default five minutes) instead of giving up, so a router reboot or a long outage heals on its own. A QR emission or a ready event resets `reconnectAttempt` to 0: an unscanned QR timeout simply produces a fresh QR forever, matching the old browser client. State responses add `reconnectAttempt`, `nextReconnectAt`, and `needsQrCode`, and return progress without waiting for an in-flight socket boot. `DisconnectReason.loggedOut` stops recovery, closes the socket, and reports `needsQrCode: true`; slow retries never apply to a logged-out session, and polling does not restart one.

The contact directory is event-driven. Baileys `messaging-history.set`, `contacts.upsert/update` and `chats.upsert/update` events feed an in-memory index; group subjects come from `groupFetchAllParticipating()` and refresh at most once every ten minutes. Entries exclude LIDs without a phone number, broadcasts, malformed ids, and unnamed people, deduplicate by canonical id, and sort in `pt-BR` order. A JSON snapshot is written next to the auth state and restored on startup, so the picker survives a restart before history sync finishes. Group-metadata failures preserve the snapshot, retry after 30 seconds, and log each distinct failure once until a successful refresh. Sending remains available when enrichment fails. Sends use `onWhatsApp()` to resolve phone numbers (including the Brazil nine-digit candidates) and preserve the Baileys message id from `key.id`; if WhatsApp returns none, the id stays null and a warning is logged.

Self-command scheduling is also supported per session. When a paired user sends a message to their own chat in the format below, the API converts it into a scheduled message owned by that session:

```text
@whatsbot <recipient> <scheduled_datetime> <message>
```

Example:

```text
@whatsbot 5551997771055 2026-04-15-19-20-30 teste message
```

The `scheduled_datetime` token currently uses the API runtime local timezone and is persisted in UTC.

### Web

The web service uses:

- Express 5 + Mustache SSR
- a browser gateway at `/` that redirects to `/login` or `/session/:id`
- a dedicated login and pairing page at `/login`
- a session-specific scheduler page at `/session/:id`
- direct static assets from `web/public/css` and `web/public/js`
- browser-side polling of `GET /whatsapp/session` or `GET /whatsapp/sessions/:sessionId`
- browser-side submission to `POST /messages`

The browser converts `datetime-local` input into a timezone-aware ISO timestamp before posting to the API. The active scheduler session is stored in browser state as a session id plus a user-friendly password, and `/login` can either create a new session or restore an existing one by password.

## Docker Compose workflow

1. Copy the example environment file:

   ```bash
   cp .env.example .env
   ```

2. Start the base stack:

   ```bash
   docker compose up --build
   ```

3. Note the current base compose behavior:

  - `compose.yaml` does **not** publish host ports by default.
  - the `api` and `web` services are reachable from other containers on the Compose network.
  - the `whatsapp_auth` named volume is mounted at `/whatsapp/auth` inside the API container.

4. For local browser access, prefer the development stack below.

### Development compose

The development file adds bind mounts, watch mode, and host port publishing for local development:

```bash
docker compose -f compose.dev.yaml up --build
```

Current development URLs and ports:

- Web: `http://localhost`
- Web login flow: `http://localhost/login`
- Web scheduler flow after login: `http://localhost/session/<session-id>`
- API ready check: `http://localhost:3000/ready`
- API session check: `http://localhost:3000/whatsapp/session`
- API session creation: `http://localhost:3000/whatsapp/sessions`
- API session restore: `http://localhost:3000/whatsapp/sessions/login`
- MySQL host port: `3306`
- Node inspector: `9229`

Current development compose mounts the WhatsApp auth volume at `/whatsapp/auth`, matching the API runtime config.

Development mode adds:

- bind mounts for `api/` and `web/`
- watch mode via `npm run development` in both services
- API inspector port `9229`
- separate named volumes for container `node_modules`

Typical local flow:

1. Start the development stack:

  ```bash
  docker compose -f compose.dev.yaml up --build
  ```

2. Open `http://localhost` to let the gateway route you, or go directly to `http://localhost/login` to create a new session or paste an existing recovery password.

3. If you create a new session, copy the generated recovery password from the modal, then wait for the session panel to show a QR code and scan it with WhatsApp on your phone.

4. After pairing, the browser returns to `/` and opens `/session/:id` automatically for the active token-backed session, or you can restore the same session later from `/login` by pasting that recovery password.

## Persistence and runtime caveats

- **MySQL** stores scheduled messages, delivery lifecycle data, and the session id to hashed session-token plus hashed recovery-password registry used by the login and restore flow.
- **`whatsapp_auth` named volume** persists the Baileys auth directory mounted at `/whatsapp/auth`, under `baileys/<sessionId>/`, so QR pairing survives container recreation. Credentials use `creds.json` plus per-key files written by `useMultiFileAuthState`; the contact snapshot lives in `chat-directory.json` in the same directory. The API never reads, modifies, or deletes the old `session-*` Chromium profiles.
- Existing installations that still have `whatsbot-session-access.json` can be migrated forward by creating the `whatsapp_session_access` table and restarting the API once. The API imports legacy entries into MySQL when that file is present, but it no longer writes session access state back to JSON.
- Schema changes must be applied explicitly through a planned migration workflow. The application must not patch or evolve the database schema at startup.
- The SQL files under `api/data/mysql/` are schema artifacts, not a runtime migration engine. Provisioning and deployment must execute the appropriate schema or migration steps outside the API process.
- Existing environments created before the multi-session change must apply [api/data/mysql/migrations/20260415_add_session_id_to_scheduled_messages.sql](/Users/pablowerlang/Documents/Workspaces/whatsbot/api/data/mysql/migrations/20260415_add_session_id_to_scheduled_messages.sql) manually before running the updated API.
- Existing environments that stored session access data in JSON must also apply [api/data/mysql/migrations/20260416_create_whatsapp_session_access.sql](/Users/pablowerlang/Documents/Workspaces/whatsbot/api/data/mysql/migrations/20260416_create_whatsapp_session_access.sql) before restarting the API.
- If the WhatsApp session becomes invalid, you may need to re-pair by scanning a new QR code.
- The API layer is a thin transport wrapper: `api/services/whatsapp-client-manager.js` owns the Baileys socket, `api/services/whatsapp-session-manager.js` owns the session registry, and routes/dispatcher/web use the same public contract as before. Chrome, Puppeteer, and `whatsapp-web.js` are not part of the runtime or the image.
- A logged-out session (`DisconnectReason.loggedOut`) stops reconnecting and reports `needsQrCode: true`; create a new app session to get a fresh QR. Other disconnects keep retrying with bounded backoff; restart the API after exhausted attempts to retry persisted credentials.
- The API image installs only `ca-certificates`: Baileys speaks the WhatsApp WebSocket protocol directly and needs no browser runtime.
- Deployment note: the image now installs dependencies with `npm ci` from the lockfile. If an existing environment keeps a `node_modules_api` named volume from the browser era, recreate that volume (or run `npm ci` inside it) so the container sees `baileys` and no longer carries `whatsapp-web.js`.
- The scheduler stores `scheduledFor` timestamps in UTC after validating timezone-aware input.
- Each scheduled message belongs to one app session via `sessionId`.
- The dispatcher polls every `SCHEDULER_POLL_INTERVAL_MS` milliseconds and claims work in small batches.

For local development with Docker Compose, one explicit way to apply the current migration is:

```bash
docker compose exec -T mysql sh -lc 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" "$MYSQL_DATABASE" < /tmp/20260416_create_whatsapp_session_access.sql'
```

Copy the migration file into the container or pipe it on stdin as part of your deployment or local setup workflow. Apply any required migrations before restarting the API, and keep that step outside the API startup path.

Current hardcoded API runtime defaults:

- API host: `0.0.0.0`
- API port: `3000`
- WhatsApp auth path: `/whatsapp/auth` (Baileys sessions live under `/whatsapp/auth/baileys/<sessionId>`)
- WhatsApp client id: `main`
- WhatsApp transport: `baileys` `7.0.0-rc14` (exact pin), logger `pino` at `warn`
- MySQL host/user/port in the helper: `mysql` / `root` / `3306`

Current scheduled message statuses in MySQL: `pending`, `processing`, `sent`, `failed`.

## Environment variables

The root `.env.example` documents the current Compose-oriented defaults. The main variables in current use are:

- `NODE_ENV`
- `API_URL` / `WEB_URL`
- `MYSQL_DATABASE` / `MYSQL_ROOT_PASSWORD`
- `SCHEDULER_POLL_INTERVAL_MS` / `SCHEDULER_BATCH_SIZE` / `SCHEDULER_CLAIM_TIMEOUT_MS`
- API process environment: `WHATSAPP_RECONNECT_MAX_ATTEMPTS` (default `5`; `0` skips the fast phase), `WHATSAPP_RECONNECT_DELAY_MS` (default `1000`), `WHATSAPP_RECONNECT_MAX_DELAY_MS` (default `30000`), `WHATSAPP_RECONNECT_SLOW_RETRY_MS` (default `300000`), and `WHATSAPP_CHAT_DIRECTORY_RETRY_MS` (default `30000`). Inject overrides into the API container environment; adding them only to the root `.env` does not forward them through Compose. Delay values have a minimum of `1` ms.

Notes:

- The current API code does **not** read `WHATSAPP_CLIENT_ID`, `WHATSAPP_AUTH_PATH`, `WHATSAPP_PUPPETEER_ARGS`, or `PUPPETEER_EXECUTABLE_PATH` from the environment. Those values are hardcoded in `api/config/app-config.js`. Browser-era variables such as `WHATSAPP_PROTOCOL_TIMEOUT_MS` and `PUPPETEER_EXECUTABLE_PATH` are ignored and do not crash startup.
- The current MySQL helper does **not** read host, port, or username from the environment. It currently uses `mysql:3306` and `root` in code.
- The old `DEV_*` port and URL overrides are not part of the current compose files.
- The old `event-hub` auth variables are **not** part of the current WhatsBot runtime.

## Local service commands

Each service is its own Node project.

```bash
# API
cd api
npm install
npm run development

# Web
cd ../web
npm install
npm run development
```

When running outside Compose, the API still needs a reachable MySQL server and a writable auth directory. The current code assumes the WhatsApp auth directory is `/whatsapp/auth` unless you change the runtime config in `api/config/app-config.js`.

## Tests

Both services currently use the **Node test runner**, not Jest.

```bash
cd api
npm test

cd ../web
npm test
```

The committed tests cover route and helper behavior, the Baileys lifecycle handlers (QR, open, logout, transient close), self-command detection over PN and LID jids, send resolution, and the event-driven directory. They do **not** prove full live WhatsApp delivery behavior or QR pairing. Manual validation is still needed for:

- real WhatsApp pairing in Docker
- actual scheduled message delivery through a connected account
- browser UX behavior in a real browser session

### Isolated Baileys test stack

`compose.test.yaml` runs only `api` and `mysql` under the `whatsbot-baileys-test` project name, with its own volumes, its own default network, and `.env.test`. It publishes the API on `127.0.0.1:3310` and never joins the production `whatsbot` network.

```bash
docker compose -p whatsbot-baileys-test -f compose.test.yaml up -d --build
curl -s 127.0.0.1:3310/ready
```

Create a session with `POST /whatsapp/sessions`, then poll `GET /whatsapp/session?sessionId=<id>` with the returned `x-whatsbot-session-token` header until `status` is `qr` and `qrCodeDataUrl` is present. For an existing pairing file under `.pairing/`, `node .pairing/qr.mjs` rewrites `.pairing/qr.png` with the current QR and prints only the status and `qrCodeUpdatedAt`; scan within ~20 seconds because WhatsApp rotates the code.

## Response shape

API responses use the project envelope style:

- success: `{ error: false, status, data, message? }`
- error: `{ error: true, status, type, message, data? }`

## Project layout

```text
.
├── api/
├── web/
├── compose.yaml
├── compose.dev.yaml
├── compose.test.yaml
└── .env.example
```

## What this project is not

This repository is **not** the original `event-hub` app. It does not currently include:

- auth flows
- event dashboards
- Google Calendar integration
- Webpack-based frontend bundling
- Jest-based test suites

Use the current code in `whatsbot` as the source of truth when extending the project.
