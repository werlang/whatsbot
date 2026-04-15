# WhatsBot

WhatsBot is a small two-service Node application for scheduling WhatsApp messages. It is built around Docker Compose, MySQL persistence, and [`whatsapp-web.js`](https://wwebjs.dev/) running with Chromium inside the API container.

> `whatsapp-web.js` is an unofficial Web WhatsApp client library. This project depends on QR pairing with a real WhatsApp account and can break when WhatsApp Web changes upstream.

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
- `whatsapp-web.js` + `LocalAuth`
- a background `MessageDispatcher` polling loop

Current HTTP routes:

- `POST /messages`
  - body: `{ phoneNumber, message, scheduledFor }`
  - `scheduledFor` must include timezone information
  - returns the created scheduled message in the standard envelope
- `GET /whatsapp/session`
  - returns current WhatsApp client/session state, including QR data when pairing is required
- `GET /ready`
  - readiness payload for the API runtime

The dispatcher only sends due messages when the WhatsApp client is ready. Messages can still be queued before pairing is complete.

### Web

The web service uses:

- Express 5 + Mustache SSR
- one page at `/`
- direct static assets from `web/public/css` and `web/public/js`
- browser-side polling of `GET /whatsapp/session`
- browser-side submission to `POST /messages`

The browser converts `datetime-local` input into a timezone-aware ISO timestamp before posting to the API.

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
- API ready check: `http://localhost:3000/ready`
- API session check: `http://localhost:3000/whatsapp/session`
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

2. Open `http://localhost`.

3. Wait for the session panel to show a QR code, then scan it with WhatsApp on your phone.

## Persistence and runtime caveats

- **MySQL** stores scheduled messages and delivery lifecycle data.
- **`whatsapp_auth` named volume** persists the `LocalAuth` session directory mounted at `/whatsapp/auth`, so QR pairing survives container recreation.
- If the WhatsApp session becomes invalid, you may need to re-pair by scanning a new QR code.
- The API image installs Chromium because `whatsapp-web.js` needs a browser runtime inside Docker.
- The scheduler stores `scheduledFor` timestamps in UTC after validating timezone-aware input.
- The dispatcher polls every `SCHEDULER_POLL_INTERVAL_MS` milliseconds and claims work in small batches.

Current hardcoded API runtime defaults:

- API host: `0.0.0.0`
- API port: `3000`
- WhatsApp `LocalAuth` path: `/whatsapp/auth`
- WhatsApp client id: `main`
- Chromium executable path: `/usr/bin/chromium-browser`
- MySQL host/user/port in the helper: `mysql` / `root` / `3306`

Current scheduled message statuses in MySQL: `pending`, `processing`, `sent`, `failed`.

## Environment variables

The root `.env.example` documents the current Compose-oriented defaults. The main variables in current use are:

- `NODE_ENV`
- `API_URL` / `WEB_URL`
- `MYSQL_DATABASE` / `MYSQL_ROOT_PASSWORD`
- `SCHEDULER_POLL_INTERVAL_MS` / `SCHEDULER_BATCH_SIZE` / `SCHEDULER_CLAIM_TIMEOUT_MS`

Notes:

- The current API code does **not** read `WHATSAPP_CLIENT_ID`, `WHATSAPP_AUTH_PATH`, `WHATSAPP_PUPPETEER_ARGS`, or `PUPPETEER_EXECUTABLE_PATH` from the environment. Those values are currently hardcoded in `api/config/app-config.js`.
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

When running outside Compose, the API still needs a reachable MySQL server and a Chromium executable compatible with `whatsapp-web.js`. The current code also assumes the WhatsApp auth directory is `/whatsapp/auth` unless you change the runtime config in `api/config/app-config.js`.

## Tests

Both services currently use the **Node test runner**, not Jest.

```bash
cd api
npm test

cd ../web
npm test
```

The committed tests cover route and helper behavior. They do **not** prove full live WhatsApp delivery behavior, QR pairing, or browser parity. Manual validation is still needed for:

- real WhatsApp pairing in Docker
- actual scheduled message delivery through a connected account
- browser UX behavior in a real browser session

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
