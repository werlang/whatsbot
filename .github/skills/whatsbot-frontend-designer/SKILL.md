---
name: whatsbot-frontend-designer
description: Design or refine WhatsBot frontend pages and features with a production-ready, Apple-like UX for non-technical users. Use when changing web UI structure, visual language, interaction copy, onboarding, forms, scheduling flows, or session and pairing experiences.
---

# WhatsBot Frontend Designer

Use this skill for any user-facing work in the `web/` service.

## Goals

- Make the product feel production ready, calm, and trustworthy.
- Optimize for non-technical users first.
- Keep technical diagnostics in the browser console unless the user explicitly needs them in the UI.
- Preserve the current SSR Mustache plus plain browser-module architecture.

## Product context

- Routes:
  - `/` is a lightweight gateway page.
  - `/session/:id` is the scheduling workspace.
  - `/login` is the session creation and pairing flow.
- Templates live in `web/public/html/`.
- Shared styling lives in `web/public/css/index.css`.
- Browser behavior lives in `web/public/js/` and helper modules under `web/public/js/helpers/`.
- The scheduler page posts to `POST /messages` and polls the session state.
- The login page creates sessions with `POST /whatsapp/sessions`, restores sessions by password, and polls `GET /whatsapp/sessions/:sessionId`.

## Design direction

- Prefer a restrained Apple-like approach: soft surfaces, generous spacing, subtle depth, calm blues and neutrals, clean rounded geometry.
- Write in plain language. Avoid exposing API URLs, transport jargon, or internal states unless they are necessary for the task.
- Use hierarchy that explains itself: short headings, reassuring body copy, clear next actions.
- Favor onboarding cues, previews, and progressive disclosure over dense instruction blocks.
- Assume mobile use matters. Validate layouts and controls at narrow widths.

## Interaction rules

- Keep form flows obvious. Labels should answer what, who, and when.
- Add live previews, helper text, and feedback where they reduce hesitation.
- Preserve important DOM ids and `data-role` selectors when improving visuals so existing scripts and tests stay stable unless a broader refactor is intentional.
- Prefer showing one strong primary action per panel.
- For debugging, use `console.debug` or `console.info` with concise structured payloads instead of adding raw technical text into the page.

## Implementation workflow

1. Read the relevant Mustache template, CSS, page script, and tests before changing anything.
2. Map which ids and `data-role` selectors are used by the browser scripts.
3. Redesign copy and layout first, then adapt the page script only where the UX requires new live behavior.
4. Keep CSS tokenized with clear variables for color, type, spacing, radii, and elevation.
5. Run `npm test` in `web/` after changes.
6. If practical, inspect the page in a browser before finishing.

## Quality bar

- Feels polished enough for a launch candidate, not like an admin prototype.
- Reduces user anxiety during session creation and QR pairing.
- Uses concise, human language for success, warning, and error states.
- Keeps visual consistency across gateway, login, and scheduler pages.
- Avoids introducing new frameworks, build steps, or unnecessary abstractions.